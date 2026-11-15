export function isDisposable(email: string, disposableDomains: Set<string>): boolean {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return disposableDomains.has(domain);
}
