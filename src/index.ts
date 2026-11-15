import { createValidator } from './core';
import { nodeResolver } from './dns';
import { withCache } from './resolver';
import { DISPOSABLE_DOMAINS, ROLE_SET, CONSUMER_DOMAINS } from './data';

export type { ValidationResult, ValidatorOptions } from './core';
export type { AliasStatus, ClassificationResult, Provider } from './classify';
export type { ValidationStatus } from './score';
export type { Resolver, MxRecord } from './resolver';
export type { Lists } from './lists';

export { createValidator } from './core';
export { dohResolver } from './doh';
export { withCache } from './resolver';
export { parseList } from './lists';

/** Validate an email using system DNS (DoH fallback) and the bundled domain lists. */
export const validateEmail = createValidator({
    resolver: withCache(nodeResolver),
    lists: { disposable: DISPOSABLE_DOMAINS, role: ROLE_SET, consumer: CONSUMER_DOMAINS },
});
