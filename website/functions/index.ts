// Cloudflare Worker: serves the static site from ./public and the validation API.
//
//   GET /api/validate?email=   same response as the Docker API's /validate (+ `records`)
//   GET /api/health

import { validateEmail, DATASET_SIZES } from './edge';

interface Env {
    ASSETS: { fetch(req: Request): Promise<Response> };
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...CORS_HEADERS } });

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

        if (url.pathname === '/api/health') {
            return json({ status: 'ok', runtime: 'cloudflare-workers', datasets: DATASET_SIZES });
        }

        if (url.pathname === '/api/validate') {
            const email = url.searchParams.get('email');
            if (!email) return json({ error: 'email query parameter is required' }, 400);
            if (email.length > 320) return json({ error: 'email is too long' }, 400);
            try {
                return json(await validateEmail(email));
            } catch {
                return json({ error: 'Validation failed' }, 500);
            }
        }

        return json({ error: 'Not found', endpoints: ['GET /api/validate?email=', 'GET /api/health'] }, 404);
    },
};
