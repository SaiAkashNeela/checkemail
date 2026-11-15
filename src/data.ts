import { readFileSync } from 'fs';
import { join } from 'path';
import { parseList } from './lists';

// Node-only: load sets once at module init — O(1) lookups thereafter
const load = (filename: string): Set<string> => {
    try {
        return parseList(readFileSync(join(__dirname, '..', 'data', filename), 'utf8'));
    } catch {
        return new Set();
    }
};

export const ROLE_SET         = load('role_based.txt');
export const CONSUMER_DOMAINS = load('consumer_domains.txt');
export const DISPOSABLE_DOMAINS = load('disposable.txt');

export {
    GMAIL_DOMAINS, PROTON_DOMAINS, MICROSOFT_CONSUMER_DOMAINS, APPLE_DOMAINS,
    YAHOO_DOMAINS, FASTMAIL_DOMAINS, ZOHO_DOMAINS, YANDEX_DOMAINS
} from './lists';
