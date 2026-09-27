import { checkSyntax } from './syntax';
import { checkMx, domainExists } from './dns';
import { isDisposable } from './disposable';
import { classify } from './classify';
import { score, ValidationStatus } from './score';

export type { AliasStatus, ClassificationResult, Provider } from './classify';
export type { ValidationStatus } from './score';

export interface ValidationResult {
    email: string;
    validations: {
        syntax: boolean;
        domain_exists: boolean;
        mx_records: boolean;
        is_disposable: boolean;
    };
    confidence: {
        score: number;
        status: ValidationStatus;
        is_role_based: boolean;
        alias_status: string;
        canonical_email: string | null;
        equivalent_domains?: string[];
    };
    provider: {
        id: string;
        name: string | null;
    } | null;
    meta: {
        latency_ms: number;
    };
}

export async function validateEmail(rawEmail: string): Promise<ValidationResult> {
    const start = Date.now();
    // Normalise: spaces before @ are often encoded + signs
    const email = rawEmail.trim().replace(/ /g, '+').toLowerCase();

    // 1. Syntax — fast, sync, no I/O
    const syntaxOk = checkSyntax(email);
    if (!syntaxOk) {
        return {
            email,
            validations: { syntax: false, domain_exists: false, mx_records: false, is_disposable: false },
            confidence: { score: 0, status: 'INVALID_FORMAT', is_role_based: false, alias_status: 'MAYBE_NOT_ALIAS', canonical_email: null },
            provider: null,
            meta: { latency_ms: Date.now() - start }
        };
    }

    const domain = email.split('@')[1];

    // 2. Disposable check — sync O(1), no I/O
    const disposable = isDisposable(email);
    if (disposable) {
        return {
            email,
            validations: { syntax: true, domain_exists: true, mx_records: true, is_disposable: true },
            confidence: { score: 0, status: 'DISPOSABLE', is_role_based: false, alias_status: 'MAYBE_NOT_ALIAS', canonical_email: null },
            provider: null,
            meta: { latency_ms: Date.now() - start }
        };
    }

    // 3. DNS + classification in parallel — the only async work
    const [existsResult, mxResult, cls] = await Promise.allSettled([
        domainExists(domain),
        checkMx(domain),
        classify(email)
    ]);

    const domain_exists = existsResult.status === 'fulfilled' ? existsResult.value : false;
    const mxData        = mxResult.status === 'fulfilled' ? mxResult.value : { hasMx: false, exchanges: [] as string[] };
    const hasMx         = mxData.hasMx;
    const classification = cls.status === 'fulfilled' ? cls.value : {
        is_role_based: false, alias_status: 'MAYBE_NOT_ALIAS' as const,
        canonical_email: null, provider: 'UNKNOWN' as const, provider_name: null
    };

    // 4. Determine status
    let status: ValidationStatus = 'LIKELY';
    if (!domain_exists) status = 'INVALID_DOMAIN';
    else if (!hasMx)    status = 'NO_MX_RECORDS';

    // 5. Reset alias/role signals on bad domain — no point showing them
    if (status !== 'LIKELY') {
        classification.is_role_based = false;
        classification.alias_status = 'MAYBE_NOT_ALIAS';
        classification.canonical_email = null;
    }

    // 6. Confidence score
    const confidence_score = score({
        domain_exists,
        mx_records: hasMx,
        is_disposable: false,
        is_role_based: classification.is_role_based,
        alias_status: classification.alias_status,
        status
    });

    return {
        email,
        validations: {
            syntax: true,
            domain_exists,
            mx_records: hasMx,
            is_disposable: false
        },
        confidence: {
            score: confidence_score,
            status,
            is_role_based: classification.is_role_based,
            alias_status: classification.alias_status,
            canonical_email: classification.canonical_email,
            equivalent_domains: classification.equivalent_domains
        },
        provider: classification.provider !== 'UNKNOWN'
            ? { id: classification.provider, name: classification.provider_name }
            : null,
        meta: { latency_ms: Date.now() - start }
    };
}
