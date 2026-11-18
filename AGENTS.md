# AGENTS.md

Instructions for AI coding agents and contributors working in this repo. `CLAUDE.md` imports this file; keep this one as the source of truth.

## What this is

`@isan3/checkemail`: a zero-dependency email validator (syntax, DNS/MX, disposable list, role inboxes, alias canonicalisation, provider fingerprinting, 0-100 score). It ships three ways:

| Surface | Code | Notes |
|---|---|---|
| npm package | `src/` → `dist/` (`bun run build`) | Node entry `src/index.ts` (system DNS + DoH fallback); edge entry `src/edge.ts` (no Node built-ins) |
| Docker HTTP API | `docker/server.ts`, `docker/Dockerfile` | `GET /validate?email=`, `GET /health`; port from `PORT` (see `.env.example`); runs as non-root |
| checkemail.dev | `website/` (Cloudflare Pages) | static `index.html` (demo runs in the browser) + Pages Function `website/functions/validate.ts` |

Domain lists live in `data/*.txt`. `data/disposable.txt` is refreshed by `.github/workflows/publish.yml` (Mon/Thu), which also bumps the version and publishes to npm and Docker Hub. Don't hand-edit it.

## Commands

Bun is the package manager (`bun.lock`, version pinned in `package.json` `packageManager`).

```bash
bun install --frozen-lockfile
bun run typecheck   # src + website/functions (tsconfig.website.json)
bun run build       # tsc -> dist/
bun run test        # bun test, offline (fake resolvers, no network)
bun run serve       # Docker API locally (needs a build first)
```

All four must pass before a PR merges; `.github/workflows/ci.yml` runs them on every PR, plus `bun audit`.

Local Pages preview (static site + Function): `cd website && npx wrangler pages dev .`

## Conventions

- **Zero runtime dependencies.** Don't add packages to `dependencies`. Dev tooling only.
- `src/core.ts` and everything it imports must stay runtime-agnostic (no `fs`, `dns`, `process`). Node-only code goes in `src/index.ts`, `src/data.ts`, `src/dns.ts`.
- The JSON response shape is a public contract shared by npm, Docker and the hosted API. Changing it is a breaking change.
- The browser engine in `website/index.html` is a port of `src/`. If you change validation or scoring logic, update both.
- New behaviour needs a test in `test/`. Tests must not hit the network: use a fake `Resolver` (see `test/core.test.ts`).
- Helpers for the Pages Function go in `website/functions/_lib/`. Anything elsewhere under `website/` is served publicly as a static file.

## Security rules

- **Rate limiting:** the public `/validate` Function allows **100 requests per minute per IP** (`website/functions/_lib/rate-limit.ts`): fixed window, keyed by `CF-Connecting-IP` (never `X-Forwarded-For`), IPv6 grouped by /64, checked before any DNS work. It answers 429 with `Retry-After` and sends `RateLimit-*` headers. Counting is two-layered: in memory per isolate, plus a counter shared by all isolates in a data center via the Cache API (`caches.default`, synthetic `https://rate-limit.invalid/` keys). The shared counter fails open to the in-memory one, and its read-then-write isn't atomic, so simultaneous parallel requests can overshoot slightly. For a hard global cap, add a Cloudflare WAF rate-limiting rule on `/validate` in the dashboard. Keep any new public endpoint behind the same limiter.
- **Privacy:** the hosted endpoint must not store or log email addresses. Responses stay `Cache-Control: no-store`. The DNS cache holds domains only.
- **DNS cache** (`withCache` in `src/resolver.ts`): bounded at 10k entries. Positive answers live 1 h, negative answers (no records / lookup failed) 60 s, and concurrent lookups are shared. Keep module-level state bounded: Workers isolates and long-lived processes reuse it across requests.
- Static-site security headers live in `website/_headers`. Don't add a CSP `upgrade-insecure-requests`: the demo's `?api=http://localhost:3000` mode needs plain HTTP to localhost.
- GitHub Actions are pinned to commit SHAs. Keep them pinned when updating, and never use `pull_request_target`.
- Never commit secrets. npm publishing uses OIDC trusted publishing (or the `NPM_TOKEN` secret); Docker Hub uses the `DOCKER_USERNAME`/`DOCKER_TOKEN` secrets.
- Audit history: `SECURITY_AUDIT_REPORT.md` and `.security-audit/findings.json`.
