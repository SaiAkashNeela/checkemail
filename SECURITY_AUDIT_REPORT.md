# Security Audit Report — checkemail

| | |
|---|---|
| **Date** | 2026-11-18 |
| **Commit audited** | `3dc0151` on `main` |
| **Remediation branch** | `claude/inspiring-euler-v13z5l` |
| **Scope** | Whole repository: npm library (`src/`), Docker API (`docker/`), Cloudflare Pages site and Function (`website/`), domain lists (`data/`), GitHub Actions. Excluded: Cloudflare dashboard settings, npm and Docker Hub account settings (not in the repo). |
| **Auditor** | Claude (Ironclad skill) |

## 1. Executive summary

checkemail is a small, dependency-free codebase with no authentication, no database and no secrets in the repository, so the attack surface is narrow. The most serious issue was that the free public `/validate` endpoint had **no rate limit**: one client could exhaust the site's Cloudflare Functions quota or use it as a free bulk validator. It now allows **100 requests per minute per IP** and returns HTTP 429 above that. We also fixed a reliability bug where a single DNS hiccup made real domains look invalid for an hour, hardened the release pipeline and the Docker image, and added security headers, a test suite and CI. The website now paints about 2.5x sooner and transfers 45% fewer bytes. Every finding is fixed. One optional action remains: a Cloudflare WAF rule if a hard, global cap is ever needed.

| Severity | Found | Fixed | Open |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 1 | 1 | 0 |
| Low | 3 | 3 | 0 |
| Info | 0 | — | — |

Plus 3 reliability (REL), 3 SEO and 2 documentation findings, all fixed (sections 7–9).

## 2. Open action items (human required)

1. **Optional:** add a Cloudflare WAF rate-limiting rule on `/validate` (dashboard → Security → WAF → Rate limiting rules) if you want a hard global cap. The in-code limiter counts per Cloudflare isolate, so a client spread across several isolates can get somewhat more than 100/min (SEC-001).
2. Make **"CI / test"** a required status check on `main` (Settings → Branches → branch protection or Rulesets → require status checks to pass, require branches to be up to date, block force pushes).
3. After deploy: re-submit `https://checkemail.dev/sitemap.xml` in Google Search Console and Bing Webmaster Tools. Nothing in the social preview tags changed, so no re-scrape is needed.

## 3. System overview

- **Stack:** TypeScript, Bun 1.3 (package manager and Docker runtime), Node ≥ 18 for library users, Cloudflare Pages + Pages Functions for checkemail.dev.
- **Entry points:** `GET /validate?email=` (Pages Function, public, unauthenticated) and `OPTIONS /validate`; the Docker API's `GET /validate` and `GET /health` (self-hosted); the npm `validateEmail()` function; the browser demo in `website/index.html` (calls DoH and GitHub directly; `?api=` points it at another API).
- **Trust boundaries:** the `email` query string (attacker-controlled) → syntax regexes → DNS-over-HTTPS queries to Cloudflare/Google with the domain URL-encoded (fixed hosts, no SSRF). DNS answers are parsed as data only.
- **Identity:** none. All endpoints are anonymous by design.
- **Caching & rate limiting:** in-memory DNS cache per process/isolate (`withCache`, 10k entries). Before this audit: no rate limiting anywhere. Pages runs many isolates, so in-memory counters are per isolate.
- **Data:** email addresses in transit only; nothing is stored or logged; responses are `Cache-Control: no-store`.
- **Deployment:** Cloudflare Pages (project root `website/`), npm and Docker Hub via `.github/workflows/publish.yml` (scheduled, pushes to `main`).

## 4. Methodology

Phases 0–6 of the Ironclad process: recon, automated scanning, manual review of every source file, report, fix with tests (one commit per finding), verification, an independent second-reviewer pass over the full diff, and the merge gate.

- **Automated:** Ironclad `run_scanners.sh` (only the grep secret-pattern fallback could run: 0 matches), `bun audit` (0 vulnerabilities, 3 packages), `check_docs.py`, `check_seo.py`, `check_social_meta.py`.
- **Not installed (not installed without asking):** gitleaks, trufflehog, semgrep, osv-scanner, trivy, zizmor, actionlint. The repo has no runtime dependencies and the dev dependencies are `typescript` and `@types/node` only, so the dependency risk is small.
- **Runtime verification:** the Pages Function ran in the real Workers runtime (`wrangler pages dev`): 100 × 200 then 429, real Gmail lookup OK. The Docker image was built and smoke-tested before and after. The website was measured with Playwright (slow-4G + 4x CPU throttle, median of 3) and compared element-by-element.
- **Limitations:** no access to the Cloudflare dashboard, npm or Docker Hub settings, or production logs.

## 5. Findings

### SEC-001 — No rate limit on the free public /validate endpoint
| | |
|---|---|
| **Severity** | Medium |
| **Status** | Fixed |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **OWASP** | A04:2021 Insecure Design (API4:2023 Unrestricted Resource Consumption) |
| **Location** | `website/functions/validate.ts` |

**Description** — The Pages Function validated as many addresses as a client sent. An uncached check makes up to 8 DoH subrequests.
**Attack path** — Anonymous client → `GET /validate?email=<random>@<random-domain>` in a loop → Function invocations + DoH fan-out. No preconditions.
**Impact** — Burns the Pages Functions daily request quota (the free endpoint goes down for everyone), offers free bulk validation the README asks people to self-host for, and turns the site into a DoH amplifier.
**Remediation** — `website/functions/_lib/rate-limit.ts`: fixed window, **100 requests per 60 s per client**, keyed by `CF-Connecting-IP` (set by Cloudflare, not spoofable like `X-Forwarded-For`). IPv6 is grouped by /64 and IPv4-mapped IPv6 is keyed by the IPv4 address. It is checked before any DNS work. Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `RateLimit-Policy: 100;w=60`. Over the limit: `429` with `Retry-After` and a JSON `error`/`retry_after`, CORS headers included so browser apps can read it. Memory is bounded at 10,000 tracked clients (expired windows are swept first). The window is fixed, as requested: generous, at the cost of allowing a burst at window edges. Counters are per isolate (documented in AGENTS.md; optional WAF rule above).
**Verification** — `test/rate-limit.test.ts`, `test/validate-function.test.ts` (100 OK then 429, `Retry-After`, per-IP isolation, spoofed `X-Forwarded-For` ignored, bounded memory). Commits `46d6547`, `9ee7eb6` (helper moved under `functions/_lib/` so Pages never serves it as a static file), `d02975e`.

### SEC-002 — Static site sent no anti-framing, HSTS or Permissions-Policy headers
| | |
|---|---|
| **Severity** | Low |
| **Status** | Fixed |
| **CWE** | CWE-1021: Improper Restriction of Rendered UI Layers |
| **OWASP** | A05:2021 Security Misconfiguration |
| **Location** | `website/_headers` (new) |

**Description** — Only `X-Content-Type-Options` and `Referrer-Policy` (Pages defaults) were sent.
**Impact** — The demo could be framed for clickjacking; no HSTS.
**Remediation** — `_headers`: HSTS (1 year, includeSubDomains), `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`, Permissions-Policy, nosniff. The CSP deliberately has no script/connect restrictions, so the inline demo, the `?api=http://localhost:3000` mode and analytics keep working. The Function adds nosniff to its JSON.
**Verification** — Headers checked on `/`, `/og.png`, the 404 page and `/validate` under `wrangler pages dev`; no console errors in Playwright. Commit `632e813`.

### SEC-003 — Release workflow used mutable action tags, Bun "latest" and an interpolated secret
| | |
|---|---|
| **Severity** | Low |
| **Status** | Fixed |
| **CWE** | CWE-829: Inclusion of Functionality from Untrusted Control Sphere |
| **OWASP** | A08:2021 Software and Data Integrity Failures |
| **Location** | `.github/workflows/publish.yml` |

**Description** — The job that pushes to `main` and publishes to npm/Docker Hub (with `contents: write`, `id-token: write`) ran `actions/*@v4`, `oven-sh/setup-bun@v2` with `bun-version: latest`, and `docker/*` by tag; `NPM_TOKEN` was expanded into the script text.
**Impact** — A retagged or compromised action or Bun release would run with publish rights (supply-chain compromise of every package user).
**Remediation** — Every action pinned to a commit SHA (tag kept as a comment); Bun pinned through `packageManager`; `NPM_TOKEN` passed via `env`.
**Verification** — The same steps run locally with Bun 1.3.13. Commit `74bad5c`.

### SEC-004 — Docker image ran the API as root
| | |
|---|---|
| **Severity** | Low |
| **Status** | Fixed |
| **CWE** | CWE-250: Execution with Unnecessary Privileges |
| **OWASP** | A05:2021 Security Misconfiguration |
| **Location** | `docker/Dockerfile` |

**Description** — No `USER`; the runtime stage also shipped the unused TypeScript compiler in `node_modules`; `docker/.dockerignore` was never applied because the build context is the repo root.
**Impact** — Any future code-execution bug would run as root in the container.
**Remediation** — `USER bun`; the runtime no longer copies `node_modules` (206 MB → 174 MB); renamed to `docker/Dockerfile.dockerignore` so BuildKit applies it.
**Verification** — Built and smoke-tested before and after: `whoami` = `bun`, `/health` and `/validate` unchanged. Commit `e899521`.

## 6. Social sharing & link previews

| Page | og:title | og:image (size / dimensions) | twitter:card | Server-rendered? | Status |
|---|---|---|---|---|---|
| `/` | checkemail: free, open-source email validation | `og.png` 62 KB, 1200×630 PNG | summary_large_image | Yes (static HTML) | ✅ 12/12 pass |

No SOC findings.

## 7. Reliability: caching & rate limiting

**Cache inventory**
| Key pattern | Data | TTL | Written by | Invalidated by | Status |
|---|---|---|---|---|---|
| `mx:<domain>` | MX records | 1 h (60 s if empty) | `withCache` on lookup | TTL; FIFO eviction at 10k | Fixed (REL-001/002) |
| `txt:<domain>` | TXT/SPF records | 1 h (60 s if empty) | `withCache` | TTL; FIFO eviction | Fixed |
| `exists:<domain>` | A-record existence | 1 h (60 s if false) | `withCache` | TTL; FIFO eviction | Fixed |
| Browser demo `type:name` | DoH answers | page lifetime | `website/index.html` | page reload | OK |

DNS data is public and the same for every user, so there is no cross-user leak.

**Rate-limit coverage**
| Endpoint | Abuse risk | Limit before | Limit after | Store | Status |
|---|---|---|---|---|---|
| `GET /validate` (checkemail.dev) | quota exhaustion, bulk abuse, DoH fan-out | none | 100/min per IP (IPv6 /64) | memory, per isolate (+ optional WAF) | Fixed (SEC-001) |
| `OPTIONS /validate` | negligible (static 204) | none | none | — | OK |
| Docker `GET /validate` | operator's own infra | none | none (by design, documented) | — | OK: self-hosted for bulk use |

### REL-001 — Transient DNS failures cached as "domain does not exist" for an hour
**Severity** Medium · **Problem** DoH timeouts and SERVFAIL come back as `false`/`[]`, not exceptions, and `withCache` kept them for the full hour, so after one network blip real domains scored 0 (`INVALID_DOMAIN`/`NO_MX_RECORDS`) in that process or isolate. · **Fix** Negative answers are cached for 60 s (new optional `negativeTtlMs` argument; backwards compatible). Commit `a3e9f1a`. · **Test added** `test/core.test.ts`.

### REL-002 — Concurrent lookups of the same name were not shared
**Severity** Low · **Problem** MX is requested by both `checkMx` and provider detection in parallel; a cold cache sent both to the network. · **Fix** In-flight promises are shared per key (commits `a3e9f1a`, `d02975e`). · **Test added** `test/core.test.ts`.

### REL-003 — Releases were published without tests, CI or a list sanity check
**Severity** Low · **Problem** No tests or PR CI existed; the scheduled job committed and published whatever upstream served. · **Fix** 36 offline tests; `.github/workflows/ci.yml` (typecheck, build, test, `bun audit`) on every PR and push to `main`; `publish.yml` runs typecheck + tests before committing/publishing and rejects a list with fewer than 5,000 lines or unexpected characters. Commit `74bad5c`. · **Test added** `test/*.test.ts`.

## 8. Documentation
| File | Status | Notes |
|---|---|---|
| README.md | ✅ Updated | Hosted API limit, Development section, Docker `PORT`/non-root note; "No rate limits" scoped to self-hosting |
| AGENTS.md | ✅ Created | Architecture, verified commands, conventions, security rules |
| CLAUDE.md (imports @AGENTS.md) | ✅ Created | `@AGENTS.md` |
| .env.example | ✅ Created | `PORT` |

### DOC-001 — No AGENTS.md / CLAUDE.md
**Problem** Nothing recorded the commands, the browser-engine ↔ `src/` parity rule or the security rules for future (agent-written) changes. · **Fix** AGENTS.md as the single source; CLAUDE.md imports it. Commit `ca796d6`.

### DOC-002 — No .env.example; README lacked dev workflow and API limits
**Problem** `PORT` was undocumented outside the site; no build/test instructions; README said "No rate limits" unconditionally. · **Fix** `.env.example`, README Development section; the hosted limit is documented in README, `llms.txt`, `llms-full.txt` and on the site (`46d6547`, `ca796d6`).

## 9. SEO & AI search

| Check | Status | Notes |
|---|---|---|
| robots.txt (allow all, Sitemap line) | ✅ | Search and AI crawlers explicitly allowed |
| Search & AI crawlers reach the site (CDN/WAF) | Not verified | Needs the Cloudflare dashboard (Bot Fight Mode / AI-crawler blocking settings) |
| sitemap.xml / index (valid, canonical URLs only, real lastmod) | ✅ | lastmod updated |
| llms.txt / llms-full.txt | ✅ | Hosted API rate limit added |
| Server-rendered content & metadata | ✅ | Static HTML |
| Titles, descriptions, canonicals, h1, lang | ✅ | Fixed (SEO-002) |
| Structured data (JSON-LD) | ✅ | WebSite, Person, SoftwareApplication, SoftwareSourceCode, FAQPage |
| hreflang (if multilingual) | n/a | |
| Core Web Vitals (LCP / INP / CLS) | ✅ | Improved (SEO-003) |

### SEO-001 — Unknown URLs returned the homepage with HTTP 200 (soft 404)
**Impact** Medium · **Problem** With no `404.html`, Pages serves `index.html` for every path, so junk URLs become indexable duplicates. · **Fix** `noindex` `404.html`; unknown paths now return 404 (commit `334a556`). · **Follow-up** none.

### SEO-002 — Title and meta description too long
**Impact** Low · **Problem** 73-char title, 188-char description (truncated in results). · **Fix** 58 and 162 chars (commit `334a556`).

### SEO-003 — Render-blocking third-party CSS and a 145 KB icon font
**Impact** Medium · **Problem** Three cross-origin stylesheets blocked first paint, and the full Phosphor icon font (~1,500 glyphs, 145 KB) was downloaded to show 21 icons. · **Fix** The 21 icons are inlined as CSS masks (3.4 KB gzipped; same `ph ph-*` classes, so markup and JS are untouched); font stylesheets load via `preload` + `onload` with `font-display: swap`; fixed a preconnect that could not be reused (commit `7a6c9ec`). Measured (slow 4G, 4x CPU, median of 3):

| | Before | After |
|---|---|---|
| First Contentful Paint | 716 ms | 284 ms |
| Largest Contentful Paint | 1064 ms | 672 ms |
| Load event | 2311 ms | 1569 ms |
| Transferred | 335 KB | 184 KB |
| Render-blocking requests | 3 | 0 |
| CLS | 0.001 | 0.001 |

Icon positions were compared element-by-element at desktop and mobile widths. All icons render at the same coordinates; footer link rows are now a uniform 27 px (previously 26/27 px).

## 10. Merge gate

See `.security-audit/merge-gate.md` (pasted into the PR description).

## 11. Remediation log
| ID | Title | Commit | Test added | Notes |
|---|---|---|---|---|
| SEC-001 | Rate limit /validate 100/min/IP | `46d6547`, `9ee7eb6`, `d02975e` | `test/rate-limit.test.ts`, `test/validate-function.test.ts` | Verified in workerd |
| REL-001 | Short TTL for negative DNS answers | `a3e9f1a` | `test/core.test.ts` | |
| REL-002 | Share in-flight lookups | `a3e9f1a`, `d02975e` | `test/core.test.ts` | |
| SEO-003 | Remove render-blocking CSS / icon font | `7a6c9ec` | Playwright comparison | |
| SEC-002 | Static security headers | `632e813` | curl checks | |
| SEO-001 | Real 404s | `334a556` | curl checks | |
| SEO-002 | Title/description length | `334a556` | `check_seo.py` | |
| SEC-003 | Pin actions, Bun, secret via env | `74bad5c` | CI run locally | |
| REL-003 | CI + tests before publish + list check | `74bad5c` | `ci.yml` | |
| SEC-004 | Non-root Docker, slimmer image | `e899521` | docker build + smoke test | |
| DOC-001 | AGENTS.md + CLAUDE.md | `ca796d6` | `check_docs.py` | |
| DOC-002 | .env.example, README | `ca796d6` | `check_docs.py` | |

## 12. Scanner results not reported as findings
- grep secret patterns: 0 matches.
- `bun audit`: 0 advisories.
- Reviewed and **not** issues: the syntax regexes are not ReDoS-prone (unambiguous separators, input capped at 254 chars before matching; covered by a test). DoH queries go to fixed hosts with the name URL-encoded (no SSRF). The demo renders results with `textContent`/DOM nodes and escapes code samples (no XSS from `?email=` or `?api=`). CORS `*` without credentials is intended for a public read-only API. The Function source is not served as a static file.

## 13. Recommendations
- **Correctness (not changed, behaviour change):** a domain with MX records but no A record is reported `INVALID_DOMAIN` because `domain_exists` only checks A. RFC 5321 delivers to MX first, so consider `domain_exists = hasA || hasMx`. This changes results for API users, so it should be a deliberate, versioned change.
- Add gitleaks (pre-commit and CI) and Dependabot/Renovate for GitHub Actions, so the SHA pins get updated.
- Consider adding the full Ironclad merge gate to CI (`assets/ci/github-actions-merge-gate.yml`) once this branch is merged. Adding it in the same PR that vendors its scripts makes it flag its own `|| true` lines.
- The third-party analytics script (`pilotfox.app`) runs with full page access; keep it to vendors you trust, since SRI isn't possible for a script that changes.
- Run Claude Code `/security-review` on PRs that touch `website/functions/` or `src/`.

---
*Audit performed with Ironclad by [Sai Akash Neela](https://saiakashneela.com) · [GitHub](https://github.com/saiakashneela) · [X](https://x.com/thesaiakash)*
