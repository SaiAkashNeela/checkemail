// RFC 5321/5322 compliant syntax check — no dependencies
const LOCAL_RE = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const QUOTED_LOCAL_RE = /^"[^"\\]*(?:\\.[^"\\]*)*"$/;
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export function checkSyntax(email: string): boolean {
    if (!email || email.length > 254) return false;

    const atIdx = email.lastIndexOf('@');
    if (atIdx < 1) return false;

    const local = email.slice(0, atIdx);
    const domain = email.slice(atIdx + 1);

    if (local.length > 64 || !domain) return false;

    const localOk = LOCAL_RE.test(local) || QUOTED_LOCAL_RE.test(local);
    const domainOk = DOMAIN_RE.test(domain);

    return localOk && domainOk;
}
