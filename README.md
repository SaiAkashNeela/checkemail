# checkemail

[![npm version](https://img.shields.io/npm/v/checkemail.svg)](https://www.npmjs.com/package/checkemail)
[![npm downloads](https://img.shields.io/npm/dm/checkemail.svg)](https://www.npmjs.com/package/checkemail)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Fast, zero-dependency email validation for Node.js. No API keys. No rate limits. Runs entirely offline (except DNS lookups).

## Features

| Check | How |
|---|---|
| ✅ Syntax validation | RFC 5321/5322 compliant |
| ✅ Domain existence | DNS A/CNAME lookup |
| ✅ MX record check | DNS MX lookup |
| ✅ Disposable detection | 9,000+ domains, updated twice a week |
| ✅ Provider fingerprinting | 10 providers + custom domain detection via MX/SPF |
| ✅ Plus-addressing | `user+tag@gmail.com` → `ALIAS_CONFIRMED` |
| ✅ Dot-stripping | `j.o.h.n@gmail.com` → canonical `john@gmail.com` |
| ✅ Role-based detection | 380+ role prefixes (`admin@`, `noreply@`, `support@`, ...) |
| ✅ Confidence scoring | 0–100 composite score |

**Zero runtime dependencies** — uses Node's built-in `dns` module. No Redis, no Docker, no API calls.

## Install

```bash
bun add checkemail
# or
npm install checkemail
```

Requires **Node.js >= 18**.

## Usage

```ts
import { validateEmail } from 'checkemail';

const result = await validateEmail('john+test@gmail.com');
console.log(result);
```

```json
{
  "email": "john+test@gmail.com",
  "validations": {
    "syntax": true,
    "domain_exists": true,
    "mx_records": true,
    "is_disposable": false
  },
  "confidence": {
    "score": 65,
    "status": "LIKELY",
    "is_role_based": false,
    "alias_status": "ALIAS_CONFIRMED",
    "canonical_email": "john@gmail.com",
    "equivalent_domains": ["gmail.com", "googlemail.com"]
  },
  "provider": {
    "id": "GMAIL",
    "name": "Gmail"
  },
  "meta": {
    "latency_ms": 47
  }
}
```

## More examples

```ts
// Disposable — exits immediately, no DNS needed
await validateEmail('throwaway@mailinator.com');
// → { confidence: { score: 0, status: 'DISPOSABLE' }, ... }

// Role-based on a custom domain
await validateEmail('support@yourcompany.com');
// → { confidence: { is_role_based: true, score: 70 }, ... }

// Custom domain on Google Workspace — detected via MX
await validateEmail('john@yourcompany.com');
// → { provider: { id: 'GOOGLE_WORKSPACE', name: 'Google Workspace' }, ... }

// Proton alias — domain normalised to canonical
await validateEmail('user@pm.me');
// → { confidence: { canonical_email: 'user@protonmail.com', alias_status: 'ALIAS_CONFIRMED' }, ... }
```

## Response Reference

### `confidence.status`

| Value | Meaning |
|---|---|
| `LIKELY` | Passes all checks — valid, real, deliverable |
| `INVALID_FORMAT` | Syntax is wrong |
| `INVALID_DOMAIN` | Domain doesn't exist in DNS |
| `NO_MX_RECORDS` | Domain exists but can't receive mail |
| `DISPOSABLE` | Throwaway / temporary email address |

### `confidence.alias_status`

| Value | Meaning |
|---|---|
| `MAYBE_NOT_ALIAS` | No alias signals detected |
| `ALIAS_CONFIRMED` | Definitively an alias (Gmail dot trick, plus-addressing on known providers) |
| `ALIAS_POSSIBLE` | May be an alias (e.g. Google Workspace where plus addressing is optional) |
| `ALIAS_UNKNOWN` | Unknown provider, can't determine |

### `provider.id`

| ID | Description |
|---|---|
| `GMAIL` | Gmail (gmail.com, googlemail.com) |
| `GOOGLE_WORKSPACE` | Custom domain on Google Workspace (detected via MX) |
| `MICROSOFT_CONSUMER` | Outlook, Hotmail, Live, MSN |
| `MICROSOFT_365` | Custom domain on Microsoft 365 (detected via MX) |
| `APPLE_ICLOUD` | iCloud, me.com, mac.com |
| `PROTON` | Proton Mail (all domains) |
| `YAHOO` | Yahoo Mail (all regional variants) |
| `FASTMAIL` | Fastmail (all domains) |
| `ZOHO` | Zoho Mail |
| `YANDEX` | Yandex Mail |
| `GOOGLE_GROUPS` | Google Groups mailing list |

## How the disposable list works

The bundled list comes from the community-maintained [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) repository, which is updated **daily** by a GitHub Actions bot.

This package fetches the latest list and republishes to npm **twice a week** (Monday and Thursday) automatically via CI. No action needed on your end — just keep your package up to date with `bun update checkemail`.

## What is role-based detection?

A role-based address belongs to a team or function, not a real person: `support@`, `admin@`, `noreply@`, `billing@`, etc. The package detects 380+ such prefixes.

**Important:** role-based detection is skipped for consumer domains. `admin@gmail.com` is a personal email, not a role address.

## What are consumer domains?

Consumer domains are personal email providers (Gmail, iCloud, ProtonMail, etc.) as opposed to company/custom domains. The package knows 100+ consumer domains across all major providers and their regional variants.

## License

MIT © [Sai Akash Neela](https://github.com/SaiAkashNeela)
