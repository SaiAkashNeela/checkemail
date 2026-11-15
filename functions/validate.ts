// Free public endpoint: GET https://checkemail.dev/validate?email=...
// Cloudflare Pages Function. Same JSON as the Docker API (docker/server.ts).
// Nothing is stored or logged; the DNS cache below holds domains only.
import { createValidator, dohResolver, withCache, parseList } from '../src/edge';
// Bundled as text at deploy time, so each deploy ships the list CI last committed
import disposableTxt from '../data/disposable.txt';
import roleTxt from '../data/role_based.txt';
import consumerTxt from '../data/consumer_domains.txt';

// Module scope: parsed once per isolate, DNS cache shared across requests in that isolate
const validateEmail = createValidator({
    resolver: withCache(dohResolver),
    lists: {
        disposable: parseList(disposableTxt),
        role: parseList(roleTxt),
        consumer: parseList(consumerTxt),
    },
});

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store', // keep addresses out of any cache
};

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...HEADERS },
    });

export const onRequestOptions = () => new Response(null, { status: 204, headers: HEADERS });

export const onRequestGet = async ({ request }: { request: Request }) => {
    const email = new URL(request.url).searchParams.get('email');
    if (!email) return json({ error: 'email query parameter is required' }, 400);
    try {
        return json(await validateEmail(email));
    } catch {
        return json({ error: 'Validation failed' }, 500);
    }
};
