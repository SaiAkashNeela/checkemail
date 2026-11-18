// Free public endpoint: GET https://checkemail.dev/validate?email=...
// Cloudflare Pages Function. Same JSON as the Docker API (../../docker/server.ts).
// Nothing is stored or logged; the DNS cache below holds domains only, and the
// rate limiter holds client IPs (in memory, for one minute) and nothing else.
import { createValidator, dohResolver, withCache, parseList } from '../../src/edge';
import { createLimiter, clientKey, type CacheLike } from './_lib/rate-limit';
// Bundled as text at deploy time, so each deploy ships the list CI last committed
import disposableTxt from '../../data/disposable.txt';
import roleTxt from '../../data/role_based.txt';
import consumerTxt from '../../data/consumer_domains.txt';

// Module scope: parsed once per isolate, DNS cache shared across requests in that isolate
const validateEmail = createValidator({
    resolver: withCache(dohResolver),
    lists: {
        disposable: parseList(disposableTxt),
        role: parseList(roleTxt),
        consumer: parseList(consumerTxt),
    },
});

// 100 requests per minute per IP: generous for apps and people, blocks bulk abuse.
const RATE_LIMIT = 100;
const RATE_WINDOW_SECONDS = 60;
// In-memory per isolate + shared across the data center via the Cache API
// (caches.default only exists on Cloudflare; elsewhere, e.g. tests, the in-memory limiter runs alone)
const rateLimit = createLimiter({
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_SECONDS * 1000,
    cache: () => (globalThis as { caches?: { default?: CacheLike } }).caches?.default,
});

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Let browser clients read the rate-limit headers
    'Access-Control-Expose-Headers': 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Policy, Retry-After',
    'Cache-Control': 'no-store', // keep addresses out of any cache
    'X-Content-Type-Options': 'nosniff',
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...HEADERS, ...extra },
    });

export const onRequestOptions = () => new Response(null, { status: 204, headers: HEADERS });

export const onRequestGet = async ({ request, waitUntil }: { request: Request; waitUntil?: (p: Promise<unknown>) => void }) => {
    // Checked before any DNS work, so blocked requests cost almost nothing
    const rl = await rateLimit(clientKey(request), waitUntil);
    const rlHeaders: Record<string, string> = {
        'RateLimit-Limit': String(rl.limit),
        'RateLimit-Remaining': String(rl.remaining),
        'RateLimit-Reset': String(rl.resetSeconds),
        'RateLimit-Policy': `${RATE_LIMIT};w=${RATE_WINDOW_SECONDS}`,
    };
    if (!rl.allowed) {
        return json(
            { error: `Rate limit exceeded: ${RATE_LIMIT} requests per minute per IP. Retry in ${rl.resetSeconds}s, or self-host for bulk use.`, retry_after: rl.resetSeconds },
            429,
            { ...rlHeaders, 'Retry-After': String(rl.resetSeconds) },
        );
    }

    const email = new URL(request.url).searchParams.get('email');
    if (!email) return json({ error: 'email query parameter is required' }, 400, rlHeaders);
    try {
        return json(await validateEmail(email), 200, rlHeaders);
    } catch {
        return json({ error: 'Validation failed' }, 500, rlHeaders);
    }
};
