// The DNS resolvers' "does this domain exist" check: A first, then AAAA (IPv6-only hosts).
// fetch and the dns module are mocked, so nothing touches the network.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import dns from 'dns';
import { dohResolver } from '../src/doh';
import { nodeResolver } from '../src/dns';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// DoH JSON answers per record type
const mockDoh = (byType: Record<string, { Status: number; Answer?: Array<{ type: number; data: string }> }>) => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
        const type = new URL(url).searchParams.get('type')!;
        asked.push(type);
        return new Response(JSON.stringify(byType[type] ?? { Status: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    return asked;
};

describe('dohResolver.domainExists', () => {
    test('true on an A record, without asking for AAAA', async () => {
        const asked = mockDoh({ A: { Status: 0, Answer: [{ type: 1, data: '192.0.2.1' }] } });
        expect(await dohResolver.domainExists('a.test')).toBe(true);
        expect(asked).toEqual(['A']);
    });

    test('true for an IPv6-only domain (AAAA, no A)', async () => {
        const asked = mockDoh({ A: { Status: 0 }, AAAA: { Status: 0, Answer: [{ type: 28, data: '2001:db8::1' }] } });
        expect(await dohResolver.domainExists('v6.test')).toBe(true);
        expect(asked).toEqual(['A', 'AAAA']);
    });

    test('false on NXDOMAIN, without a second query', async () => {
        const asked = mockDoh({ A: { Status: 3 } });
        expect(await dohResolver.domainExists('missing.test')).toBe(false);
        expect(asked).toEqual(['A']);
    });

    test('false when the name has neither A nor AAAA', async () => {
        mockDoh({ A: { Status: 0 }, AAAA: { Status: 0 } });
        expect(await dohResolver.domainExists('mailonly.test')).toBe(false);
    });
});

describe('nodeResolver.domainExists', () => {
    const err = (code: string) => Object.assign(new Error(code), { code });

    test('falls through to AAAA when the name has no A record', async () => {
        const r4 = spyOn(dns.promises, 'resolve4').mockRejectedValue(err('ENODATA'));
        const r6 = spyOn(dns.promises, 'resolve6').mockResolvedValue(['2001:db8::1']);
        try {
            expect(await nodeResolver.domainExists('v6.test')).toBe(true);
        } finally { r4.mockRestore(); r6.mockRestore(); }
    });

    test('false with neither A nor AAAA, without a DoH fallback', async () => {
        const r4 = spyOn(dns.promises, 'resolve4').mockRejectedValue(err('ENODATA'));
        const r6 = spyOn(dns.promises, 'resolve6').mockRejectedValue(err('ENODATA'));
        const asked = mockDoh({});
        try {
            expect(await nodeResolver.domainExists('mailonly.test')).toBe(false);
            expect(asked).toEqual([]);
        } finally { r4.mockRestore(); r6.mockRestore(); }
    });

    test('falls back to DoH when system DNS fails', async () => {
        const r4 = spyOn(dns.promises, 'resolve4').mockRejectedValue(err('ETIMEOUT'));
        const asked = mockDoh({ A: { Status: 0, Answer: [{ type: 1, data: '192.0.2.1' }] } });
        try {
            expect(await nodeResolver.domainExists('a.test')).toBe(true);
            expect(asked).toEqual(['A']);
        } finally { r4.mockRestore(); }
    });
});
