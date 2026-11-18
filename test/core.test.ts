// Library behaviour with a fake resolver, so these run offline and deterministically.
import { describe, expect, test } from 'bun:test';
import { createValidator, withCache, parseList, type Resolver } from '../src/edge';
import { checkSyntax } from '../src/syntax';

const lists = {
    disposable: parseList('mailinator.com\n# comment\n'),
    role: parseList('support\nadmin\n'),
    consumer: parseList('gmail.com\n'),
};

const fakeResolver = (zones: Record<string, { a?: boolean; mx?: string[]; txt?: string[] }>): Resolver => ({
    async resolveMx(d) {
        const z = zones[d];
        if (!z) throw new Error('NXDOMAIN');
        return (z.mx ?? []).map((exchange, i) => ({ priority: 10 * (i + 1), exchange }));
    },
    async resolveTxt(d) { return (zones[d]?.txt ?? []).map(t => [t]); },
    async domainExists(d) { return Boolean(zones[d]?.a); },
});

const validate = createValidator({
    lists,
    resolver: fakeResolver({
        'gmail.com': { a: true, mx: ['gmail-smtp-in.l.google.com'] },
        'acme.test': { a: true, mx: ['aspmx.l.google.com'] },
        'nomail.test': { a: true },
    }),
});

describe('checkSyntax', () => {
    test.each([
        ['john@example.com', true],
        ['john.doe+tag@sub.example.co.uk', true],
        ['"quoted name"@example.com', true],
        ['no-at-sign', false],
        ['@example.com', false],
        ['john@', false],
        ['john..doe@example.com', false],
        ['john@-bad.com', false],
        [`${'a'.repeat(65)}@example.com`, false],
        [`a@${'b'.repeat(250)}.com`, false],
    ])('%s -> %p', (email, ok) => expect(checkSyntax(email)).toBe(ok));

    test('long hostile input is rejected quickly (no ReDoS)', () => {
        const start = performance.now();
        expect(checkSyntax('a'.repeat(50_000) + '!')).toBe(false);
        expect(checkSyntax('a.'.repeat(60) + '@' + 'a-'.repeat(60))).toBe(false);
        expect(performance.now() - start).toBeLessThan(50);
    });
});

describe('createValidator', () => {
    test('Gmail alias is canonicalised', async () => {
        const r = await validate('John.Doe+test@gmail.com');
        expect(r.email).toBe('john.doe+test@gmail.com');
        expect(r.confidence).toMatchObject({ status: 'LIKELY', alias_status: 'ALIAS_CONFIRMED', canonical_email: 'johndoe@gmail.com', score: 65 });
        expect(r.provider).toEqual({ id: 'GMAIL', name: 'Gmail' });
    });

    test('role inbox on a Google Workspace domain', async () => {
        const r = await validate('support@acme.test');
        expect(r.confidence).toMatchObject({ status: 'LIKELY', is_role_based: true, score: 80 });
        expect(r.provider?.id).toBe('GOOGLE_WORKSPACE');
    });

    test('statuses for bad addresses', async () => {
        expect((await validate('nope')).confidence.status).toBe('INVALID_FORMAT');
        expect((await validate('x@mailinator.com')).confidence.status).toBe('DISPOSABLE');
        expect((await validate('x@missing.test')).confidence.status).toBe('INVALID_DOMAIN');
        expect((await validate('x@nomail.test')).confidence).toMatchObject({ status: 'NO_MX_RECORDS', score: 0 });
    });
});

describe('withCache', () => {
    const counting = (impl: Partial<Resolver> = {}) => {
        const calls = { mx: 0, txt: 0, exists: 0 };
        const resolver: Resolver = {
            resolveMx: async d => { calls.mx++; return impl.resolveMx ? impl.resolveMx(d) : [{ priority: 10, exchange: 'mx.' + d }]; },
            resolveTxt: async d => { calls.txt++; return impl.resolveTxt ? impl.resolveTxt(d) : []; },
            domainExists: async d => { calls.exists++; return impl.domainExists ? impl.domainExists(d) : true; },
        };
        return { resolver, calls };
    };

    test('caches successful lookups', async () => {
        const { resolver, calls } = counting();
        const cached = withCache(resolver);
        await cached.resolveMx('a.test');
        await cached.resolveMx('a.test');
        await cached.domainExists('a.test');
        await cached.domainExists('a.test');
        expect(calls).toEqual({ mx: 1, txt: 0, exists: 1 });
    });

    test('concurrent lookups for the same name share one request', async () => {
        const { resolver, calls } = counting();
        const cached = withCache(resolver);
        await Promise.all([cached.resolveMx('a.test'), cached.resolveMx('a.test'), cached.resolveMx('a.test')]);
        expect(calls.mx).toBe(1);
    });

    test('failed lookups are not cached', async () => {
        let fail = true;
        const { resolver, calls } = counting({
            resolveMx: async () => { if (fail) throw new Error('timeout'); return [{ priority: 10, exchange: 'mx.test' }]; },
        });
        const cached = withCache(resolver);
        await expect(cached.resolveMx('a.test')).rejects.toThrow('timeout');
        fail = false;
        expect(await cached.resolveMx('a.test')).toEqual([{ priority: 10, exchange: 'mx.test' }]);
        expect(calls.mx).toBe(2);
    });

    test('negative answers expire sooner than positive ones', async () => {
        let exists = false;
        const { resolver, calls } = counting({ domainExists: async () => exists });
        const realNow = Date.now;
        let t = 1_000_000;
        Date.now = () => t;
        try {
            const cached = withCache(resolver, 60 * 60 * 1000, 60 * 1000);
            expect(await cached.domainExists('a.test')).toBe(false); // e.g. a transient DoH failure
            exists = true;
            t += 30 * 1000;
            expect(await cached.domainExists('a.test')).toBe(false); // still cached
            t += 31 * 1000;
            expect(await cached.domainExists('a.test')).toBe(true); // negative entry expired
            t += 30 * 60 * 1000;
            expect(await cached.domainExists('a.test')).toBe(true); // positive entry still cached
            expect(calls.exists).toBe(2);
        } finally {
            Date.now = realNow;
        }
    });
});
