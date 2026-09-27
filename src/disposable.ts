import { DISPOSABLE_DOMAINS } from './data';

export function isDisposable(email: string): boolean {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return DISPOSABLE_DOMAINS.has(domain);
}
