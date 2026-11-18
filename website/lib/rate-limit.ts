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
    const hextets = ipv6Hextets(ip);
    if (!hextets) return ip;
    return hextets.slice(0, 4).map(h => h.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
