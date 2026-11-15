import type { MxRecord, Resolver } from './resolver';

// DNS-over-HTTPS resolver: only needs fetch, so it runs in Node 18+, Bun,
// Cloudflare Workers/Pages and browsers. Cloudflare 1.1.1.1 first, Google 8.8.8.8 as fallback.
interface DohResponse { Status: number; Answer?: Array<{ type: number; data: string }>; }

const TYPES = { A: 1, MX: 15, TXT: 16 } as const;

async function query(name: string, type: keyof typeof TYPES): Promise<DohResponse> {
    const q = `name=${encodeURIComponent(name)}&type=${type}`;
    const endpoints = [
        `https://cloudflare-dns.com/dns-query?${q}`,
        `https://dns.google/resolve?${q}`,
    ];
    for (const url of endpoints) {
        try {
            const res = await fetch(url, {
                headers: { accept: 'application/dns-json' },
                signal: AbortSignal.timeout(3000),
            });
            if (res.ok) return await res.json() as DohResponse;
        } catch { /* try the next endpoint */ }
    }
    throw new Error(`DNS-over-HTTPS lookup failed for ${name} ${type}`);
}

const answers = (res: DohResponse, type: keyof typeof TYPES) =>
    (res.Answer ?? []).filter(a => a.type === TYPES[type]).map(a => a.data);

// "10 mx.example.com." -> { priority: 10, exchange: 'mx.example.com' }
const parseMx = (data: string): MxRecord => {
    const parts = data.trim().split(/\s+/);
    return {
        priority: parseInt(parts[0], 10) || 10,
        exchange: (parts[1] ?? parts[0]).replace(/\.$/, ''),
    };
};

// '"v=spf1 include:_spf.google.com" "~all"' -> ['v=spf1 include:_spf.google.com', '~all']
const parseTxt = (data: string): string[] => {
    const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
    return chunks.length > 0 ? chunks : [data];
};

export const dohResolver: Resolver = {
    async resolveMx(domain) {
        return answers(await query(domain, 'MX'), 'MX').map(parseMx);
    },
    async resolveTxt(domain) {
        return answers(await query(domain, 'TXT'), 'TXT').map(parseTxt);
    },
    async domainExists(domain) {
        try {
            const res = await query(domain, 'A');
            // Any answer counts, including a CNAME chain
            return res.Status === 0 && (res.Answer?.length ?? 0) > 0;
        } catch {
            return false;
        }
    },
};
