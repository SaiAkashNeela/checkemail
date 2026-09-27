// Edge build of checkemail for Cloudflare Workers.
//
// The npm build can't run on Workers as-is: it reads data/*.txt from disk with
// fs.readFileSync, which a Worker bundle can't do. This file mirrors
// src/index.ts + src/classify.ts, reuses the pure modules (syntax, score) directly, and
// swaps Node DNS for DNS-over-HTTPS against 1.1.1.1. Keep it in sync with src/.

import { checkSyntax } from '../../src/syntax';
import { score } from '../../src/score';
import type { ValidationStatus } from '../../src/score';
import type { AliasStatus, Provider } from '../../src/classify';
import type { ValidationResult } from '../../src/index';
import disposableTxt from '../../data/disposable.txt';
import roleTxt from '../../data/role_based.txt';
import consumerTxt from '../../data/consumer_domains.txt';

// Same parsing as src/data.ts
const load = (content: string): Set<string> =>
    new Set(content.split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#')));

const DISPOSABLE_DOMAINS = load(disposableTxt);
const ROLE_SET = load(roleTxt);
const CONSUMER_DOMAINS = load(consumerTxt);

// Provider domain constants (mirrors src/data.ts)
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const PROTON_DOMAINS = new Set(['proton.me', 'protonmail.com', 'pm.me', 'protonmail.ch']);
const MICROSOFT_CONSUMER_DOMAINS = new Set(['outlook.com', 'live.com', 'hotmail.com', 'msn.com']);
const APPLE_DOMAINS = new Set(['icloud.com', 'me.com', 'mac.com']);
const YAHOO_DOMAINS = new Set(['yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com']);
const FASTMAIL_DOMAINS = new Set(['fastmail.com', 'fastmail.fm']);
const ZOHO_DOMAINS = new Set(['zoho.com', 'zohomail.com']);
const YANDEX_DOMAINS = new Set(['yandex.com', 'yandex.ru', 'yandex.ua']);

export const DATASET_SIZES = {
    disposable: DISPOSABLE_DOMAINS.size,
    role_based: ROLE_SET.size,
    consumer: CONSUMER_DOMAINS.size,
};

// --- DNS over HTTPS ---------------------------------------------------------

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const TYPE = { A: 1, CNAME: 5, MX: 15, TXT: 16 } as const;

interface DohAnswer { name: string; type: number; TTL: number; data: string; }
interface DohResponse { Status: number; Answer?: DohAnswer[]; }

// Per-isolate TTL cache, same idea as src/dns.ts
const cache = new Map<string, { val: DohAnswer[]; exp: number }>();
const TTL = 60 * 60 * 1000;

async function query(name: string, type: keyof typeof TYPE): Promise<DohAnswer[]> {
    const key = `${type}:${name}`;
    const hit = cache.get(key);
    if (hit && Date.now() < hit.exp) return hit.val;

    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
    });
    if (!res.ok) throw new Error(`DoH ${res.status}`);
    const body = await res.json() as DohResponse;
    // Status 0 = NOERROR. NXDOMAIN (3) and friends mean no records.
    const answers = body.Status === 0 ? (body.Answer ?? []) : [];
    cache.set(key, { val: answers, exp: Date.now() + TTL });
    return answers;
}

const stripDot = (h: string) => h.replace(/\.$/, '').toLowerCase();

// Mirrors domainExists(): dns.resolve(domain) resolves A records, following CNAMEs
async function lookupA(domain: string): Promise<{ exists: boolean; a: string[]; cname: string[] }> {
    try {
        const answers = await query(domain, 'A');
        const a = answers.filter(r => r.type === TYPE.A).map(r => r.data);
        const cname = answers.filter(r => r.type === TYPE.CNAME).map(r => stripDot(r.data));
        return { exists: a.length > 0, a, cname };
    } catch {
        return { exists: false, a: [], cname: [] };
    }
}

// Mirrors checkMx(): sorted by priority, lowercased exchanges
async function lookupMx(domain: string): Promise<{ hasMx: boolean; mx: { priority: number; exchange: string }[] }> {
    try {
        const answers = await query(domain, 'MX');
        const mx = answers
            .filter(r => r.type === TYPE.MX)
            .map(r => {
                const [priority, exchange] = r.data.split(/\s+/);
                return { priority: Number(priority), exchange: stripDot(exchange ?? '') };
            })
            // A null MX ("0 .", RFC 7505) means the domain accepts no mail
            .filter(r => r.exchange)
            .sort((a, b) => a.priority - b.priority);
        return { hasMx: mx.length > 0, mx };
    } catch {
        return { hasMx: false, mx: [] };
    }
}

async function lookupSpf(domain: string): Promise<string> {
    try {
        const answers = await query(domain, 'TXT');
        return answers
            .filter(r => r.type === TYPE.TXT)
            .map(r => r.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''))
            .join(' ')
            .toLowerCase();
    } catch {
        return '';
    }
}

// Mirrors detectProviderFromDns()
async function detectProviderFromDns(domain: string, exchanges: string[]): Promise<'GOOGLE_WORKSPACE' | 'MICROSOFT_365' | null> {
    if (exchanges.some(h => h.endsWith('google.com') || h.endsWith('googlemail.com') || h.endsWith('gmail.com'))) {
        return 'GOOGLE_WORKSPACE';
    }
    if (exchanges.some(h => h.endsWith('outlook.com'))) return 'MICROSOFT_365';
    const spf = await lookupSpf(domain);
    if (spf.includes('_spf.google.com')) return 'GOOGLE_WORKSPACE';
    if (spf.includes('spf.protection.outlook.com')) return 'MICROSOFT_365';
    return null;
}

// --- Classification (mirrors src/classify.ts) --------------------------------

interface Classification {
    is_role_based: boolean;
    alias_status: AliasStatus;
    canonical_email: string | null;
    provider: Provider;
    provider_name: string | null;
    equivalent_domains?: string[];
}

async function classify(email: string, exchanges: Promise<string[]>): Promise<Classification> {
    const atIdx = email.lastIndexOf('@');
    const local = email.slice(0, atIdx).toLowerCase().trim();
    const domain = email.slice(atIdx + 1).toLowerCase().trim();

    if (domain === 'googlegroups.com') {
        return { is_role_based: true, alias_status: 'MAYBE_NOT_ALIAS', canonical_email: null, provider: 'GOOGLE_GROUPS', provider_name: 'Google Groups' };
    }

    const isConsumer = CONSUMER_DOMAINS.has(domain);
    const is_role_based = !isConsumer && ROLE_SET.has(local);

    let provider: Provider = 'UNKNOWN';
    let provider_name: string | null = null;

    if (GMAIL_DOMAINS.has(domain))                  { provider = 'GMAIL';               provider_name = 'Gmail'; }
    else if (PROTON_DOMAINS.has(domain))            { provider = 'PROTON';              provider_name = 'Proton Mail'; }
    else if (MICROSOFT_CONSUMER_DOMAINS.has(domain)){ provider = 'MICROSOFT_CONSUMER';  provider_name = 'Microsoft'; }
    else if (APPLE_DOMAINS.has(domain))             { provider = 'APPLE_ICLOUD';        provider_name = 'iCloud'; }
    else if (YAHOO_DOMAINS.has(domain))             { provider = 'YAHOO';               provider_name = 'Yahoo'; }
    else if (FASTMAIL_DOMAINS.has(domain))          { provider = 'FASTMAIL';            provider_name = 'Fastmail'; }
    else if (ZOHO_DOMAINS.has(domain))              { provider = 'ZOHO';                provider_name = 'Zoho Mail'; }
    else if (YANDEX_DOMAINS.has(domain))            { provider = 'YANDEX';              provider_name = 'Yandex Mail'; }
    else {
        const detected = await detectProviderFromDns(domain, await exchanges);
        if (detected === 'GOOGLE_WORKSPACE')  { provider = 'GOOGLE_WORKSPACE'; provider_name = 'Google Workspace'; }
        else if (detected === 'MICROSOFT_365'){ provider = 'MICROSOFT_365';    provider_name = 'Microsoft 365'; }
    }

    let aliasStatus: AliasStatus = 'MAYBE_NOT_ALIAS';
    let realLocal = local;
    let canonicalDomain = domain;
    let equivalentDomains: string[] = [];

    if (provider === 'PROTON')            { canonicalDomain = 'protonmail.com'; equivalentDomains = [...PROTON_DOMAINS]; }
    else if (provider === 'GMAIL')        { canonicalDomain = 'gmail.com';      equivalentDomains = [...GMAIL_DOMAINS]; }
    else if (provider === 'APPLE_ICLOUD') { canonicalDomain = 'icloud.com';     equivalentDomains = [...APPLE_DOMAINS]; }

    if (local.includes('+')) {
        if (['GMAIL', 'MICROSOFT_CONSUMER', 'APPLE_ICLOUD', 'PROTON', 'YAHOO', 'FASTMAIL', 'ZOHO'].includes(provider)) {
            realLocal = local.split('+')[0];
            aliasStatus = 'ALIAS_CONFIRMED';
        } else if (['GOOGLE_WORKSPACE', 'MICROSOFT_365'].includes(provider)) {
            realLocal = local.split('+')[0];
            aliasStatus = 'ALIAS_POSSIBLE';
        } else {
            aliasStatus = 'ALIAS_UNKNOWN';
        }
    }

    if (['GMAIL', 'PROTON'].includes(provider)) {
        const stripped = realLocal.replace(/\./g, '');
        if (stripped !== realLocal) {
            realLocal = stripped;
            if (aliasStatus === 'MAYBE_NOT_ALIAS') aliasStatus = 'ALIAS_CONFIRMED';
        }
    } else if (provider === 'GOOGLE_WORKSPACE' && realLocal.includes('.')) {
        realLocal = realLocal.replace(/\./g, '');
        if (aliasStatus === 'MAYBE_NOT_ALIAS') aliasStatus = 'ALIAS_POSSIBLE';
    }

    const domainChanged = canonicalDomain !== domain;
    const localChanged = realLocal !== local;
    let canonical_email: string | null = null;

    if (localChanged || domainChanged) {
        canonical_email = `${realLocal}@${canonicalDomain}`;
        if (domainChanged && aliasStatus === 'MAYBE_NOT_ALIAS') aliasStatus = 'ALIAS_CONFIRMED';
    }

    return {
        is_role_based,
        alias_status: aliasStatus,
        canonical_email,
        provider,
        provider_name,
        equivalent_domains: equivalentDomains.length > 0 ? equivalentDomains : undefined,
    };
}

// --- validateEmail (mirrors src/index.ts) -----------------------------------

// Same shape as the npm package's ValidationResult, plus the raw DNS answers.
// `records` is null when the pipeline exits before DNS (bad syntax, disposable).
export interface EdgeValidationResult extends ValidationResult {
    records: { a: string[]; cname: string[]; mx: { priority: number; exchange: string }[] } | null;
}

export async function validateEmail(rawEmail: string): Promise<EdgeValidationResult> {
    const start = Date.now();
    const email = rawEmail.trim().replace(/ /g, '+').toLowerCase();

    if (!checkSyntax(email)) {
        return {
            email,
            validations: { syntax: false, domain_exists: false, mx_records: false, is_disposable: false },
            confidence: { score: 0, status: 'INVALID_FORMAT', is_role_based: false, alias_status: 'MAYBE_NOT_ALIAS', canonical_email: null },
            provider: null,
            meta: { latency_ms: Date.now() - start },
            records: null,
        };
    }

    const domain = email.split('@')[1];

    if (DISPOSABLE_DOMAINS.has(domain)) {
        return {
            email,
            validations: { syntax: true, domain_exists: true, mx_records: true, is_disposable: true },
            confidence: { score: 0, status: 'DISPOSABLE', is_role_based: false, alias_status: 'MAYBE_NOT_ALIAS', canonical_email: null },
            provider: null,
            meta: { latency_ms: Date.now() - start },
            records: null,
        };
    }

    const aPromise = lookupA(domain);
    const mxPromise = lookupMx(domain);
    const [aData, mxData, cls] = await Promise.all([
        aPromise,
        mxPromise,
        classify(email, mxPromise.then(m => m.mx.map(r => r.exchange))).catch((): Classification => ({
            is_role_based: false, alias_status: 'MAYBE_NOT_ALIAS', canonical_email: null, provider: 'UNKNOWN', provider_name: null,
        })),
    ]);

    const domain_exists = aData.exists;
    const hasMx = mxData.hasMx;

    let status: ValidationStatus = 'LIKELY';
    if (!domain_exists) status = 'INVALID_DOMAIN';
    else if (!hasMx)    status = 'NO_MX_RECORDS';

    if (status !== 'LIKELY') {
        cls.is_role_based = false;
        cls.alias_status = 'MAYBE_NOT_ALIAS';
        cls.canonical_email = null;
    }

    const confidence_score = score({
        domain_exists,
        mx_records: hasMx,
        is_disposable: false,
        is_role_based: cls.is_role_based,
        alias_status: cls.alias_status,
        status,
    });

    return {
        email,
        validations: { syntax: true, domain_exists, mx_records: hasMx, is_disposable: false },
        confidence: {
            score: confidence_score,
            status,
            is_role_based: cls.is_role_based,
            alias_status: cls.alias_status,
            canonical_email: cls.canonical_email,
            equivalent_domains: cls.equivalent_domains,
        },
        provider: cls.provider !== 'UNKNOWN' ? { id: cls.provider, name: cls.provider_name } : null,
        meta: { latency_ms: Date.now() - start },
        records: { a: aData.a, cname: aData.cname, mx: mxData.mx },
    };
}
