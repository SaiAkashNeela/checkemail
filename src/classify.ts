import {
    ROLE_SET, CONSUMER_DOMAINS,
    GMAIL_DOMAINS, PROTON_DOMAINS, MICROSOFT_CONSUMER_DOMAINS,
    APPLE_DOMAINS, YAHOO_DOMAINS, FASTMAIL_DOMAINS, ZOHO_DOMAINS, YANDEX_DOMAINS
} from './data';
import { detectProviderFromDns } from './dns';

export type AliasStatus = 'MAYBE_NOT_ALIAS' | 'ALIAS_CONFIRMED' | 'ALIAS_POSSIBLE' | 'ALIAS_UNKNOWN';
export type Provider =
    | 'GMAIL' | 'PROTON' | 'MICROSOFT_CONSUMER' | 'MICROSOFT_365'
    | 'APPLE_ICLOUD' | 'GOOGLE_WORKSPACE' | 'GOOGLE_GROUPS'
    | 'YAHOO' | 'FASTMAIL' | 'ZOHO' | 'YANDEX'
    | 'DISPOSABLE' | 'UNKNOWN';

export interface ClassificationResult {
    is_role_based: boolean;
    alias_status: AliasStatus;
    canonical_email: string | null;
    provider: Provider;
    provider_name: string | null;
    equivalent_domains?: string[];
}

export async function classify(email: string): Promise<ClassificationResult> {
    const atIdx = email.lastIndexOf('@');
    const local = email.slice(0, atIdx).toLowerCase().trim();
    const domain = email.slice(atIdx + 1).toLowerCase().trim();

    // Google Groups — role-based by nature, no alias logic needed
    if (domain === 'googlegroups.com') {
        return { is_role_based: true, alias_status: 'MAYBE_NOT_ALIAS', canonical_email: null, provider: 'GOOGLE_GROUPS', provider_name: 'Google Groups' };
    }

    // Role-based: only flag for non-consumer domains (consumer emails like admin@gmail.com are personal)
    const isConsumer = CONSUMER_DOMAINS.has(domain);
    const is_role_based = !isConsumer && ROLE_SET.has(local);

    // Identify provider — known domains first (no DNS needed), then DNS fallback
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
        // Custom domain — check MX/SPF to identify Google Workspace or Microsoft 365
        const detected = await detectProviderFromDns(domain);
        if (detected === 'GOOGLE_WORKSPACE')  { provider = 'GOOGLE_WORKSPACE'; provider_name = 'Google Workspace'; }
        else if (detected === 'MICROSOFT_365'){ provider = 'MICROSOFT_365';    provider_name = 'Microsoft 365'; }
    }

    // --- Alias & canonical email analysis ---
    let aliasStatus: AliasStatus = 'MAYBE_NOT_ALIAS';
    let realLocal = local;
    let canonicalDomain = domain;
    let equivalentDomains: string[] = [];

    // Domain normalization (equivalent domain sets)
    if (provider === 'PROTON')       { canonicalDomain = 'protonmail.com'; equivalentDomains = [...PROTON_DOMAINS]; }
    else if (provider === 'GMAIL')   { canonicalDomain = 'gmail.com';      equivalentDomains = [...GMAIL_DOMAINS]; }
    else if (provider === 'APPLE_ICLOUD') { canonicalDomain = 'icloud.com'; equivalentDomains = [...APPLE_DOMAINS]; }

    // Plus addressing — RFC 5233 sub-addressing (user+tag@domain)
    if (local.includes('+')) {
        if (['GMAIL', 'MICROSOFT_CONSUMER', 'APPLE_ICLOUD', 'PROTON', 'YAHOO', 'FASTMAIL', 'ZOHO'].includes(provider)) {
            realLocal = local.split('+')[0];
            aliasStatus = 'ALIAS_CONFIRMED';
        } else if (['GOOGLE_WORKSPACE', 'MICROSOFT_365'].includes(provider)) {
            realLocal = local.split('+')[0];
            aliasStatus = 'ALIAS_POSSIBLE'; // Workspace may or may not have plus addressing enabled
        } else {
            aliasStatus = 'ALIAS_UNKNOWN';
        }
    }

    // Dot stripping — Gmail and Proton ignore dots in local part (john.doe == johndoe)
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
        equivalent_domains: equivalentDomains.length > 0 ? equivalentDomains : undefined
    };
}
