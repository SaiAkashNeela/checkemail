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
        try {
            await dnsPromises.resolve(domain);
            return true;
        } catch {
            return dohResolver.domainExists(domain);
        }
    },
};
