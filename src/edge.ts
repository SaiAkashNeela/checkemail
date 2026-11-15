// Entry point for runtimes without Node built-ins (Cloudflare Workers/Pages, Deno, browsers).
// Nothing here imports fs or dns: bring your own lists and use DNS-over-HTTPS.
//
//   import { createValidator, dohResolver, withCache, parseList } from '@isan3/checkemail/dist/edge';
//   const validateEmail = createValidator({
//       resolver: withCache(dohResolver),
//       lists: { disposable: parseList(disposableTxt), role: parseList(roleTxt), consumer: parseList(consumerTxt) },
//   });
export type { ValidationResult, ValidatorOptions } from './core';
export type { AliasStatus, ClassificationResult, Provider } from './classify';
export type { ValidationStatus } from './score';
export type { Resolver, MxRecord } from './resolver';
export type { Lists } from './lists';

export { createValidator } from './core';
export { dohResolver } from './doh';
export { withCache } from './resolver';
export { parseList } from './lists';
