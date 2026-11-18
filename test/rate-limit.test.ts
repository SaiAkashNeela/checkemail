import { describe, expect, test } from 'bun:test';
import { createRateLimiter, clientKey } from '../website/functions/_lib/rate-limit';

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
