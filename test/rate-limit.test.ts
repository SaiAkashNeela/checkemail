import { describe, expect, test } from 'bun:test';
import { createRateLimiter, createLimiter, clientKey } from '../website/functions/_lib/rate-limit';

const req = (ip?: string) => new Request('https://checkemail.dev/validate', {
    headers: ip ? { 'CF-Connecting-IP': ip } : {},
});

describe('createRateLimiter', () => {
    test('allows `limit` requests per window, then blocks', () => {
        let t = 0;
        const check = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
        expect([1, 2, 3].map(() => check('a').allowed)).toEqual([true, true, true]);
        const blocked = check('a');
        expect(blocked.allowed).toBe(false);
        expect(blocked.remaining).toBe(0);
        expect(blocked.resetSeconds).toBe(60);
    });

    test('reports remaining and reset time', () => {
        let t = 1_000;
        const check = createRateLimiter({ limit: 100, windowMs: 60_000, now: () => t });
        expect(check('a')).toEqual({ allowed: true, limit: 100, remaining: 99, resetSeconds: 60 });
        t += 45_500;
        expect(check('a')).toEqual({ allowed: true, limit: 100, remaining: 98, resetSeconds: 15 });
    });

    test('window resets after windowMs', () => {
        let t = 0;
        const check = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
        check('a'); check('a');
        expect(check('a').allowed).toBe(false);
        t = 59_999;
        expect(check('a').allowed).toBe(false);
        t = 60_000;
        expect(check('a')).toMatchObject({ allowed: true, remaining: 1 });
    });

    test('blocked requests do not extend the window', () => {
        let t = 0;
        const check = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => t });
        check('a');
        for (t = 1_000; t < 60_000; t += 1_000) expect(check('a').allowed).toBe(false);
        t = 60_000;
        expect(check('a').allowed).toBe(true);
    });

    test('clients are counted separately', () => {
        const check = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
        expect(check('a').allowed).toBe(true);
        expect(check('a').allowed).toBe(false);
        expect(check('b').allowed).toBe(true);
    });

    test('memory stays bounded by maxKeys', () => {
        let t = 0;
        const check = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3, now: () => t });
        check('a'); check('b'); check('c');
        check('d'); // evicts the oldest live window ('a')
        expect(check('a').allowed).toBe(true); // 'a' starts fresh, evicting 'b'
        expect(check('c').allowed).toBe(false); // 'c' is still tracked
        t = 60_000; // everything expired: expired windows are swept first
        expect(check('e').allowed).toBe(true);
        expect(check('d').allowed).toBe(true);
    });
});

// Fake per-data-center cache: entries honour max-age like the Workers Cache API
const fakeCache = (now: () => number) => {
    const store = new Map<string, { body: string; exp: number }>();
    return {
        store,
        async match(key: string) {
            const e = store.get(key);
            return e && e.exp > now() ? new Response(e.body) : undefined;
        },
        async put(key: string, res: Response) {
            const age = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1] ?? 0);
            store.set(key, { body: await res.text(), exp: now() + age * 1000 });
        },
    };
};

describe('createLimiter (in-memory + shared data-center counter)', () => {
    const setup = (isolates: number, limit = 5) => {
        let t = 0;
        const now = () => t;
        const cache = fakeCache(now);
        const pending: Promise<unknown>[] = [];
        const waitUntil = (p: Promise<unknown>) => { pending.push(p); };
        const limiters = Array.from({ length: isolates }, () => createLimiter({ limit, windowMs: 60_000, cache: () => cache, now }));
        // Requests round-robin over isolates; await background cache writes between requests
        let i = 0;
        const hit = async (key = 'ip') => {
            const r = await limiters[i++ % isolates](key, waitUntil);
            await Promise.all(pending.splice(0));
            return r;
        };
        return { hit, cache, setTime: (v: number) => { t = v; } };
    };

    test('counts across isolates: limit applies to the client, not each isolate', async () => {
        const { hit } = setup(4, 5);
        const results = [];
        for (let n = 0; n < 7; n++) results.push((await hit()).allowed);
        expect(results).toEqual([true, true, true, true, true, false, false]);
    });

    test('reports the shared remaining count and reset', async () => {
        const { hit, setTime } = setup(3, 5);
        await hit(); await hit();
        setTime(20_000);
        expect(await hit()).toEqual({ allowed: true, limit: 5, remaining: 2, resetSeconds: 40 });
    });

    test('blocked response carries the shared reset time', async () => {
        const { hit, setTime } = setup(10, 2);
        await hit(); await hit();
        setTime(15_000);
        expect(await hit()).toEqual({ allowed: false, limit: 2, remaining: 0, resetSeconds: 45 });
    });

    test('window resets after it expires', async () => {
        const { hit, setTime } = setup(4, 2);
        await hit(); await hit();
        expect((await hit()).allowed).toBe(false);
        setTime(60_001);
        expect((await hit()).allowed).toBe(true);
    });

    test('clients are counted separately', async () => {
        const { hit } = setup(4, 1);
        expect((await hit('a')).allowed).toBe(true);
        expect((await hit('a')).allowed).toBe(false);
        expect((await hit('b')).allowed).toBe(true);
    });

    test('cache keys never contain anything but the client key', async () => {
        const { hit, cache } = setup(1, 5);
        await hit('2001:db8:1:2::/64');
        expect([...cache.store.keys()]).toEqual(['https://rate-limit.invalid/v1/2001%3Adb8%3A1%3A2%3A%3A%2F64']);
    });

    test('falls back to the in-memory limiter when the cache is missing or failing', async () => {
        const broken = { match: async () => { throw new Error('cache down'); }, put: async () => {} };
        for (const cache of [() => undefined, () => broken]) {
            const check = createLimiter({ limit: 2, windowMs: 60_000, cache, now: () => 0 });
            expect((await check('ip')).allowed).toBe(true);
            expect((await check('ip')).allowed).toBe(true);
            expect((await check('ip')).allowed).toBe(false);
        }
    });

    test('ignores a corrupted cache entry', async () => {
        const cache = { match: async () => new Response('{"count":"x"}'), put: async () => {} };
        const check = createLimiter({ limit: 2, windowMs: 60_000, cache: () => cache, now: () => 0 });
        expect(await check('ip')).toMatchObject({ allowed: true, remaining: 1 });
    });
});

describe('clientKey', () => {
    test('uses CF-Connecting-IP for IPv4', () => {
        expect(clientKey(req('203.0.113.7'))).toBe('203.0.113.7');
    });

    test('ignores spoofable X-Forwarded-For', () => {
        const r = new Request('https://checkemail.dev/validate', {
            headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' },
        });
        expect(clientKey(r)).toBe('203.0.113.7');
    });

    test('groups IPv6 by /64', () => {
        expect(clientKey(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd'))).toBe('2001:db8:1:2::/64');
        expect(clientKey(req('2001:db8:1:2::1'))).toBe('2001:db8:1:2::/64');
        expect(clientKey(req('2001:0DB8:0001:0002::ffff'))).toBe('2001:db8:1:2::/64');
        expect(clientKey(req('2001:db8::1'))).toBe('2001:db8:0:0::/64');
        expect(clientKey(req('::1'))).toBe('0:0:0:0::/64');
    });

    test('IPv4-mapped IPv6 is keyed by the IPv4 address', () => {
        expect(clientKey(req('::ffff:203.0.113.7'))).toBe('203.0.113.7');
        expect(clientKey(req('::FFFF:198.51.100.1'))).toBe('198.51.100.1');
    });

    test('falls back safely', () => {
        expect(clientKey(req())).toBe('unknown');
        expect(clientKey(req('not:an::ip::addr'))).toBe('not:an::ip::addr');
    });
});
