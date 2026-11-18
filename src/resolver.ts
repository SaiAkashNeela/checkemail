export interface MxRecord { priority: number; exchange: string; }

/** The DNS lookups the validator needs. Swap implementations per runtime. */
export interface Resolver {
    /** MX records. Throws if the lookup fails. */
    resolveMx(domain: string): Promise<MxRecord[]>;
    /** TXT records, each record split into its character strings. Throws if the lookup fails. */
    resolveTxt(domain: string): Promise<string[][]>;
    /** True when the domain has an A record (directly or via CNAME). Never throws. */
    domainExists(domain: string): Promise<boolean>;
}

// ponytail: in-process TTL cache for DNS results, ceiling = process restart clears it.
// upgrade path: accept a cache adapter in validateEmail options for Redis/external.
const TTL = 60 * 60 * 1000;      // 1 hour
const NEGATIVE_TTL = 60 * 1000;  // 1 minute for "no records" answers
const MAX_ENTRIES = 10_000;      // bound memory on long-lived processes and public endpoints

/**
 * Wrap a resolver with an in-memory TTL cache.
 * - Positive answers are kept for `ttlMs`.
 * - Negative answers (domain not found, no records) are kept for `negativeTtlMs`: a DoH
 *   timeout or SERVFAIL also looks like "no records", and must not mark a real domain
 *   invalid for an hour.
 * - Failed lookups (throws) are not cached, so a flaky resolver gets retried next time.
 * - Concurrent lookups for the same name share one in-flight request.
 */
export function withCache(resolver: Resolver, ttlMs = TTL, negativeTtlMs = Math.min(NEGATIVE_TTL, ttlMs)): Resolver {
    const cache = new Map<string, { val: unknown; exp: number }>();
    const inflight = new Map<string, Promise<unknown>>();

    const get = <T>(key: string): T | undefined => {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.exp) { cache.delete(key); return undefined; }
        return entry.val as T;
    };
    const set = (key: string, val: unknown) => {
        const negative = val === false || (Array.isArray(val) && val.length === 0);
        cache.delete(key); // re-insert at the end so eviction stays oldest-first
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
        cache.set(key, { val, exp: Date.now() + (negative ? negativeTtlMs : ttlMs) });
    };
    const cached = <T>(key: string, lookup: () => Promise<T>): Promise<T> => {
        const hit = get<T>(key);
        if (hit !== undefined) return Promise.resolve(hit);
        const pending = inflight.get(key) as Promise<T> | undefined;
        if (pending) return pending;
        const p = lookup()
            .then(val => { set(key, val); return val; })
            .finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    };

    return {
        resolveMx: d => cached(`mx:${d}`, () => resolver.resolveMx(d)),
        resolveTxt: d => cached(`txt:${d}`, () => resolver.resolveTxt(d)),
        domainExists: d => cached(`exists:${d}`, () => resolver.domainExists(d)),
    };
}

/** MX records sorted by priority. Also handles null MX ("0 .", RFC 7505). */
export async function checkMx(resolver: Resolver, domain: string): Promise<{ hasMx: boolean; exchanges: string[] }> {
    try {
        const records = await resolver.resolveMx(domain);
        // A null MX ("0 .", RFC 7505) comes back as an empty exchange: the domain accepts no mail
        const exchanges = [...records]
            .sort((a, b) => a.priority - b.priority)
            .map(r => r.exchange.toLowerCase().replace(/\.$/, ''))
            .filter(Boolean);
        return { hasMx: exchanges.length > 0, exchanges };
    } catch {
        return { hasMx: false, exchanges: [] };
    }
}

/** Detect Google Workspace / Microsoft 365 from MX, falling back to SPF. */
export async function detectProviderFromDns(resolver: Resolver, domain: string): Promise<'GOOGLE_WORKSPACE' | 'MICROSOFT_365' | null> {
    try {
        const { exchanges } = await checkMx(resolver, domain);
        if (exchanges.some(h => h.endsWith('google.com') || h.endsWith('googlemail.com') || h.endsWith('gmail.com'))) {
            return 'GOOGLE_WORKSPACE';
        }
        if (exchanges.some(h => h.endsWith('outlook.com'))) {
            return 'MICROSOFT_365';
        }
        // SPF fallback
        try {
            const txt = await resolver.resolveTxt(domain);
            const spf = txt.flat().join(' ').toLowerCase();
            if (spf.includes('_spf.google.com')) return 'GOOGLE_WORKSPACE';
            if (spf.includes('spf.protection.outlook.com')) return 'MICROSOFT_365';
        } catch { /* no SPF — fine */ }
    } catch { /* DNS failure */ }
    return null;
}
