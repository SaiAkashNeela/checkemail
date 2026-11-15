// Domain/prefix lists the validator needs. Loaded differently per runtime:
// Node reads data/*.txt from disk, the Cloudflare function bundles them as text.
export interface Lists {
    disposable: Set<string>;
    role: Set<string>;
    consumer: Set<string>;
}

export const parseList = (text: string): Set<string> =>
    new Set(text.split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#')));

// Provider domain constants
export const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
export const PROTON_DOMAINS = new Set(['proton.me', 'protonmail.com', 'pm.me', 'protonmail.ch']);
export const MICROSOFT_CONSUMER_DOMAINS = new Set(['outlook.com', 'live.com', 'hotmail.com', 'msn.com']);
export const APPLE_DOMAINS = new Set(['icloud.com', 'me.com', 'mac.com']);
export const YAHOO_DOMAINS = new Set(['yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com']);
export const FASTMAIL_DOMAINS = new Set(['fastmail.com', 'fastmail.fm']);
export const ZOHO_DOMAINS = new Set(['zoho.com', 'zohomail.com']);
export const YANDEX_DOMAINS = new Set(['yandex.com', 'yandex.ru', 'yandex.ua']);
