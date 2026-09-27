import dns from 'dns';

const dnsPromises = dns.promises;

// ponytail: in-process TTL cache for DNS results, ceiling = process restart clears it.
// upgrade path: accept a cache adapter in validateEmail options for Redis/external.
interface CacheEntry { val: unknown; exp: number; }
const cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.exp) { cache.delete(key); return null; }
    return entry.val as T;
}

function setCached(key: string, val: unknown, ttlMs: number) {
    cache.set(key, { val, exp: Date.now() + ttlMs });
}

const TTL = 60 * 60 * 1000; // 1 hour

async function resolveMxViaDoH(domain: string): Promise<dns.MxRecord[]> {
    // 1. Cloudflare 1.1.1.1 DoH
    try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
            headers: { 'accept': 'application/dns-json' },
            signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
            const data = await res.json() as { Answer?: Array<{ data: string }> };
            if (data.Answer && data.Answer.length > 0) {
                return data.Answer.map(ans => {
                    const parts = ans.data.trim().split(/\s+/);
                    const priority = parseInt(parts[0], 10) || 10;
                    const exchange = (parts[1] || parts[0]).replace(/\.$/, '');
                    return { priority, exchange };
                });
            }
        }
    } catch { /* fall through to Google */ }

    // 2. Google 8.8.8.8 DoH fallback
    try {
        const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
            signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
            const data = await res.json() as { Answer?: Array<{ data: string }> };
            if (data.Answer && data.Answer.length > 0) {
                return data.Answer.map(ans => {
                    const parts = ans.data.trim().split(/\s+/);
                    const priority = parseInt(parts[0], 10) || 10;
                    const exchange = (parts[1] || parts[0]).replace(/\.$/, '');
                    return { priority, exchange };
                });
            }
        }
    } catch { /* all DNS fallbacks failed */ }

    return [];
}

async function domainExistsViaDoH(domain: string): Promise<boolean> {
    // 1. Cloudflare 1.1.1.1 DoH
    try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
            headers: { 'accept': 'application/dns-json' },
            signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
            const data = await res.json() as { Status: number; Answer?: unknown[] };
            if (data.Status === 0 && Boolean(data.Answer && data.Answer.length > 0)) {
                return true;
            }
        }
    } catch { /* fall through to Google */ }

    // 2. Google 8.8.8.8 DoH fallback
    try {
        const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`, {
            signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
            const data = await res.json() as { Status: number; Answer?: unknown[] };
            return data.Status === 0 && Boolean(data.Answer && data.Answer.length > 0);
        }
    } catch { /* all DNS fallbacks failed */ }

    return false;
}

export async function resolveMx(domain: string): Promise<dns.MxRecord[]> {
    const key = `mx:${domain}`;
    const cached = getCached<dns.MxRecord[]>(key);
    if (cached) return cached;
    try {
        const records = await dnsPromises.resolveMx(domain);
        setCached(key, records, TTL);
        return records;
    } catch {
        // Fallback: Cloudflare DNS-over-HTTPS (in case UDP port 53 is blocked or ISP flaked)
        const fallback = await resolveMxViaDoH(domain);
        if (fallback.length > 0) {
            setCached(key, fallback, TTL);
            return fallback;
        }
        throw new Error('MX lookup failed');
    }
}

export async function resolveTxt(domain: string): Promise<string[][]> {
    const key = `txt:${domain}`;
    const cached = getCached<string[][]>(key);
    if (cached) return cached;
    const records = await dnsPromises.resolveTxt(domain);
    setCached(key, records, TTL);
    return records;
}

export async function domainExists(domain: string): Promise<boolean> {
    const key = `exists:${domain}`;
    const cached = getCached<boolean>(key);
    if (cached !== null) return cached;
    try {
        await dnsPromises.resolve(domain);
        setCached(key, true, TTL);
        return true;
    } catch {
        // Fallback: Cloudflare DNS-over-HTTPS
        const exists = await domainExistsViaDoH(domain);
        setCached(key, exists, TTL);
        return exists;
    }
}

/**
 * Check MX records — returns the sorted list or empty if none.
 * Also inspects SPF TXT records as fallback (same as the Go service did).
 */
export async function checkMx(domain: string): Promise<{ hasMx: boolean; exchanges: string[] }> {
    try {
        const records = await resolveMx(domain);
        if (records.length === 0) return { hasMx: false, exchanges: [] };
        const exchanges = records
            .sort((a, b) => a.priority - b.priority)
            .map(r => r.exchange.toLowerCase());
        return { hasMx: true, exchanges };
    } catch {
        return { hasMx: false, exchanges: [] };
    }
}

/**
 * Detect provider from MX/SPF when domain isn't in known sets.
 * Mirrors the logic that was in classifier.ts.
 */
export async function detectProviderFromDns(domain: string): Promise<'GOOGLE_WORKSPACE' | 'MICROSOFT_365' | null> {
    try {
        const { exchanges } = await checkMx(domain);
        if (exchanges.some(h => h.endsWith('google.com') || h.endsWith('googlemail.com') || h.endsWith('gmail.com'))) {
            return 'GOOGLE_WORKSPACE';
        }
        if (exchanges.some(h => h.endsWith('outlook.com'))) {
            return 'MICROSOFT_365';
        }
        // SPF fallback
        try {
            const txt = await resolveTxt(domain);
            const spf = txt.flat().join(' ').toLowerCase();
            if (spf.includes('_spf.google.com')) return 'GOOGLE_WORKSPACE';
            if (spf.includes('spf.protection.outlook.com')) return 'MICROSOFT_365';
        } catch { /* no SPF — fine */ }
    } catch { /* DNS failure */ }
    return null;
}
