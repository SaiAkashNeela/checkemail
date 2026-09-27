import { readFileSync } from 'fs';
import { join } from 'path';

// Load sets once at module init — O(1) lookups thereafter
const load = (filename: string): Set<string> => {
    try {
        const content = readFileSync(join(__dirname, '..', 'data', filename), 'utf8');
        return new Set(
            content.split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#'))
        );
    } catch {
        return new Set();
    }
};

export const ROLE_SET         = load('role_based.txt');
export const CONSUMER_DOMAINS = load('consumer_domains.txt');
export const DISPOSABLE_DOMAINS = load('disposable.txt');

// Provider domain constants
export const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
export const PROTON_DOMAINS = new Set(['proton.me', 'protonmail.com', 'pm.me', 'protonmail.ch']);
export const MICROSOFT_CONSUMER_DOMAINS = new Set(['outlook.com', 'live.com', 'hotmail.com', 'msn.com']);
export const APPLE_DOMAINS = new Set(['icloud.com', 'me.com', 'mac.com']);
export const YAHOO_DOMAINS = new Set(['yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com']);
export const FASTMAIL_DOMAINS = new Set(['fastmail.com', 'fastmail.fm']);
export const ZOHO_DOMAINS = new Set(['zoho.com', 'zohomail.com']);
export const YANDEX_DOMAINS = new Set(['yandex.com', 'yandex.ru', 'yandex.ua']);
