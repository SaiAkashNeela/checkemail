# checkemail.dev

Landing page and live demo for checkemail, deployed as one Cloudflare Worker.

```
website/
  public/            static assets served as-is
    index.html       the whole site (HTML, CSS, JS, browser engine inline)
    llms.txt         LLM summary (llmstxt.org format)
    llms-full.txt    full docs for LLMs
    robots.txt, sitemap.xml, og.png
  functions/
    index.ts         Worker: /api/validate, /api/health, everything else from public/
    edge.ts          edge build of validateEmail (DNS over HTTPS, reuses src/syntax + src/score)
  scripts/
    sync-lists.mjs   copies data/role_based.txt + consumer_domains.txt into index.html
  wrangler.toml
```

## Deploy

```bash
cd website
npx wrangler deploy
```

## Local

```bash
cd website
npx wrangler dev
```

`public/index.html` also works on any static host (Pages, GitHub Pages, S3). Without the Worker it
runs the same validation logic in the browser against Cloudflare DNS over HTTPS.

## How the demo picks an engine

| Situation | Engine |
|---|---|
| `?api=http://localhost:3000` | That HTTP API (Docker image or another Worker) |
| Served by this Worker (`/api/health` answers) | Same-origin `/api/validate` |
| Anything else | In-browser port of `src/` |

## Keeping it in sync with the package

- The browser engine in `index.html` and `functions/edge.ts` mirror `src/index.ts` and `src/classify.ts`.
  Change them together.
- After editing `data/role_based.txt` or `data/consumer_domains.txt`, run `node website/scripts/sync-lists.mjs`.
- The disposable list is not inlined. The browser loads it from the published npm package via jsDelivr,
  falling back to the upstream disposable-email-domains list. The Worker bundles `data/disposable.txt`.
- The FAQ section in `index.html` is mirrored in its FAQPage JSON-LD. Edit both together.
