import { validateEmail } from './src/index';

const PORT = parseInt(process.env.PORT || '3000');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // CORS preflight
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // Health check
        if (url.pathname === '/health') {
            return json({ status: 'ok', version: process.env.npm_package_version || '1.0.0' });
        }

        // Validate endpoint
        if (url.pathname === '/validate' && req.method === 'GET') {
            const email = url.searchParams.get('email');
            if (!email) {
                return json({ error: 'email query parameter is required' }, 400);
            }
            try {
                const result = await validateEmail(email);
                return json(result);
            } catch (err) {
                return json({ error: 'Validation failed' }, 500);
            }
        }

        return json({ error: 'Not found', endpoints: ['GET /validate?email=', 'GET /health'] }, 404);
    }
});

console.log(`checkemail API running on http://localhost:${server.port}`);
