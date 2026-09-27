import type { AliasStatus } from './classify';

export type ValidationStatus = 'LIKELY' | 'RISKY' | 'INVALID' | 'INVALID_FORMAT' | 'INVALID_DOMAIN' | 'NO_MX_RECORDS' | 'DISPOSABLE' | 'UNKNOWN';

interface ScoreInput {
    domain_exists: boolean;
    mx_records: boolean;
    is_disposable: boolean;
    is_role_based: boolean;
    alias_status: AliasStatus;
    status: ValidationStatus;
}

export function score(input: ScoreInput): number {
    const { domain_exists, mx_records, is_disposable, is_role_based, alias_status, status } = input;

    // Hard failures → 0 immediately
    if (
        status === 'DISPOSABLE' || status === 'INVALID_DOMAIN' ||
        status === 'NO_MX_RECORDS' || status === 'INVALID_FORMAT' ||
        is_disposable || !domain_exists || !mx_records
    ) return 0;

    let s = 0;
    if (domain_exists)              s += 20;
    if (mx_records)                 s += 20;
    if (!is_disposable)             s += 20;
    if (alias_status === 'MAYBE_NOT_ALIAS') s += 20;
    else if (alias_status === 'ALIAS_POSSIBLE') s += 10;
    else if (alias_status === 'ALIAS_CONFIRMED') s -= 5;
    if (!is_role_based)             s += 10;

    return Math.max(0, Math.min(100, s));
}
