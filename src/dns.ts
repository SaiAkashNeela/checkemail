import dns from 'dns';
import { dohResolver } from './doh';
import type { Resolver } from './resolver';

const dnsPromises = dns.promises;

/**
 * Node resolver: system DNS first, DNS-over-HTTPS fallback
 * (in case UDP port 53 is blocked or the ISP resolver flakes).
 */
export const nodeResolver: Resolver = {
    async resolveMx(domain) {
        try {
            return await dnsPromises.resolveMx(domain);
        } catch {
            const fallback = await dohResolver.resolveMx(domain).catch(() => []);
            if (fallback.length > 0) return fallback;
            throw new Error('MX lookup failed');
        }
    },
    async resolveTxt(domain) {
        try {
            return await dnsPromises.resolveTxt(domain);
        } catch {
            return dohResolver.resolveTxt(domain);
        }
    },
    async domainExists(domain) {
        // ENODATA = the name exists but has no record of that type: try AAAA (IPv6-only hosts).
        // Any other error (timeout, refused, NXDOMAIN) falls back to DoH as before.
        const noData = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENODATA';
        try {
            if ((await dnsPromises.resolve4(domain)).length > 0) return true;
        } catch (err) {
            if (!noData(err)) return dohResolver.domainExists(domain);
        }
        try {
            return (await dnsPromises.resolve6(domain)).length > 0;
        } catch (err) {
            return noData(err) ? false : dohResolver.domainExists(domain);
        }
    },
};
