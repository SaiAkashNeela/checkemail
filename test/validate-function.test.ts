// The public Cloudflare Pages Function. Inputs are chosen so no DNS lookups happen
// (bad syntax and disposable domains return before any network call).
import { describe, expect, test } from 'bun:test';
import { onRequestGet, onRequestOptions } from '../website/functions/validate';

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`; // module-level limiter: each test uses new IPs

const get = (query: string, ip: string, extra: Record<string, string> = {}) =>
    onRequestGet({
        request: new Request(`https://checkemail.dev/validate${query}`, {
            headers: { 'CF-Connecting-IP': ip, ...extra },
        }),
    });

describe('GET /validate', () => {
    test('returns the validation result with rate-limit headers', async () => {
        const res = await get('?email=not-an-email', freshIp());
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.confidence.status).toBe('INVALID_FORMAT');
        expect(res.headers.get('RateLimit-Limit')).toBe('100');
        expect(res.headers.get('RateLimit-Remaining')).toBe('99');
        expect(res.headers.get('RateLimit-Policy')).toBe('100;w=60');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
    });

    test('flags disposable domains without DNS', async () => {
        const res = await get('?email=someone@mailinator.com', freshIp());
        expect(((await res.json()) as any).confidence.status).toBe('DISPOSABLE');
    });

    test('400 when email is missing', async () => {
        const res = await get('', freshIp());
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error).toBe('email query parameter is required');
    });

    test('allows 100 requests per minute per IP, then 429 with Retry-After', async () => {
        const ip = freshIp();
        for (let i = 0; i < 100; i++) {
            expect((await get('?email=bad', ip)).status).toBe(200);
        }
        const res = await get('?email=bad', ip);
        expect(res.status).toBe(429);
        const retry = Number(res.headers.get('Retry-After'));
        expect(retry).toBeGreaterThan(0);
        expect(retry).toBeLessThanOrEqual(60);
        expect(res.headers.get('RateLimit-Remaining')).toBe('0');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*'); // browsers can read the 429
        const body = await res.json() as any;
        expect(body.retry_after).toBe(retry);
        expect(body.error).toContain('Rate limit exceeded');

        // Other clients are unaffected
        expect((await get('?email=bad', freshIp())).status).toBe(200);
    });

    test('a spoofed X-Forwarded-For does not reset the limit', async () => {
        const ip = freshIp();
        for (let i = 0; i < 100; i++) await get('?email=bad', ip);
        const res = await get('?email=bad', ip, { 'X-Forwarded-For': '192.0.2.99' });
        expect(res.status).toBe(429);
    });
});

describe('OPTIONS /validate', () => {
    test('CORS preflight', () => {
        const res = onRequestOptions();
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    });
});
