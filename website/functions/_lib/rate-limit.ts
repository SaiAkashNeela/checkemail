// Per-IP rate limiting for the public /validate endpoint.
//
// Fixed window per client: the first request from a client opens a window of `windowMs`,
// and up to `limit` requests are allowed in it. Counters live in the isolate's memory, so
// the limit is enforced per Cloudflare isolate (a client hitting several isolates may get
// a little more). That keeps the endpoint free of extra infrastructure; for a hard global
// cap add a Cloudflare WAF rate-limiting rule in front (see AGENTS.md).

export interface RateLimitResult {
    allowed: boolean;
    limit: number;
    remaining: number;
    /** Seconds until the client's window resets (at least 1). */
    resetSeconds: number;
}

export interface RateLimiterOptions {
    limit: number;
    windowMs: number;
    /** Cap on tracked clients, so memory stays bounded however many IPs show up. */
    maxKeys?: number;
    now?: () => number;
}

export function createRateLimiter({ limit, windowMs, maxKeys = 10_000, now = Date.now }: RateLimiterOptions) {
    // Insertion order == window-start order (a window that resets is re-inserted at the end),
    // so the oldest windows are always at the front of the map.
    const windows = new Map<string, { count: number; resetAt: number }>();

    const makeRoom = (t: number) => {
        for (const [key, w] of windows) {
            if (w.resetAt > t) break;
            windows.delete(key);
        }
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value as string);
    };

    return function check(key: string): RateLimitResult {
        const t = now();
        let w = windows.get(key);
        if (!w || w.resetAt <= t) {
            if (w) windows.delete(key);
            if (windows.size >= maxKeys) makeRoom(t);
            w = { count: 0, resetAt: t + windowMs };
            windows.set(key, w);
        }
        if (w.count <= limit) w.count++; // stop counting once blocked; the window end doesn't move
        return {
            allowed: w.count <= limit,
            limit,
            remaining: Math.max(0, limit - w.count),
            resetSeconds: Math.max(1, Math.ceil((w.resetAt - t) / 1000)),
        };
    };
}

/** The subset of the Workers Cache API the shared counter needs. */
export interface CacheLike {
    match(key: string): Promise<Response | undefined>;
    put(key: string, response: Response): Promise<void>;
}

type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Fixed-window counter shared by every isolate in a Cloudflare data center, stored with
 * the Cache API (which is per data center). Pages spreads one client's requests over many
 * isolates, so the in-memory limiter alone lets a client through far more than `limit`.
 *
 * Not atomic: requests that arrive at the same instant on different isolates can read the
 * same count, so a parallel burst may slightly overshoot. Sequential traffic is counted
 * exactly. Returns null (caller falls back to the in-memory limiter) if the cache is
 * unavailable or errors, so the endpoint fails open rather than going down.
 */
export function createSharedCounter({ limit, windowMs, cache, now = Date.now }: {
    limit: number;
    windowMs: number;
    cache: () => CacheLike | undefined;
    now?: () => number;
}) {
    return async function count(key: string, waitUntil: WaitUntil): Promise<{ count: number; resetAt: number } | null> {
        const store = cache();
        if (!store) return null;
        // Synthetic, non-routable URL: these entries can never be served to a visitor
        const url = `https://rate-limit.invalid/v1/${encodeURIComponent(key)}`;
        const t = now();
        let state = { count: 0, resetAt: t + windowMs };
        try {
            const hit = await store.match(url);
            if (hit) {
                const saved = await hit.json() as { count?: unknown; resetAt?: unknown };
                if (typeof saved.count === 'number' && typeof saved.resetAt === 'number' && saved.resetAt > t) {
                    state = { count: saved.count, resetAt: saved.resetAt };
                }
            }
        } catch {
            return null;
        }
        if (state.count > limit) return state; // already blocked: nothing new to store
        state.count++;
        const ttl = Math.max(1, Math.ceil((state.resetAt - t) / 1000));
        waitUntil(store.put(url, new Response(JSON.stringify(state), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
        })).catch(() => {}));
        return state;
    };
}

/**
 * Combined check: the in-memory limiter (exact within one isolate, also catches parallel
 * bursts) plus the data-center-wide shared counter. A request is allowed only if both allow it.
 */
export function createLimiter({ limit, windowMs, cache, now = Date.now }: {
    limit: number;
    windowMs: number;
    cache: () => CacheLike | undefined;
    now?: () => number;
}) {
    const local = createRateLimiter({ limit, windowMs, now });
    const shared = createSharedCounter({ limit, windowMs, cache, now });
    return async function check(key: string, waitUntil: WaitUntil = p => { p.catch(() => {}); }): Promise<RateLimitResult> {
        const l = local(key);
        if (!l.allowed) return l;
        const s = await shared(key, waitUntil);
        if (!s) return l;
        const allowed = s.count <= limit;
        const sharedReset = Math.max(1, Math.ceil((s.resetAt - now()) / 1000));
        return {
            allowed,
            limit,
            remaining: Math.min(l.remaining, Math.max(0, limit - s.count)),
            resetSeconds: allowed ? Math.min(l.resetSeconds, sharedReset) : sharedReset,
        };
    };
}

/** Expand an IPv6 address to 8 hextets, or null if it isn't one we can parse. */
function ipv6Hextets(ip: string): string[] | null {
    const addr = ip.split('%')[0].toLowerCase();
    if (!/^[0-9a-f:.]+$/.test(addr)) return null;
    const halves = addr.split('::');
    if (halves.length > 2) return null;
    const part = (s: string) => (s ? s.split(':') : []);
    const head = part(halves[0]);
    const tail = halves.length === 2 ? part(halves[1]) : [];
    // An embedded IPv4 tail (::ffff:1.2.3.4) takes two hextets
    const width = (xs: string[]) => xs.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
    const missing = 8 - width(head) - width(tail);
    if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
    return [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail];
}

/**
 * Rate-limit key for a request. Uses CF-Connecting-IP, which Cloudflare sets and clients
 * cannot spoof (X-Forwarded-For can be). IPv6 clients are grouped by /64, the smallest
 * block usually assigned to one subscriber, so rotating addresses inside it doesn't help.
 */
export function clientKey(request: Request): string {
    const ip = request.headers.get('CF-Connecting-IP')?.trim();
    if (!ip) return 'unknown';
    if (!ip.includes(':')) return ip;
    // IPv4-mapped IPv6 (::ffff:203.0.113.7): key by the IPv4 address, not a shared /64
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) return mapped[1];
    const hextets = ipv6Hextets(ip);
    if (!hextets) return ip;
    return hextets.slice(0, 4).map(h => h.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
