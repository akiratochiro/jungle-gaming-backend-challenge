import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The correlation fields carried alongside every log line and threaded through
 * HTTP requests, the SQS consumer and the background workers. Only identifiers
 * and message ids — never monetary values or raw payloads.
 */
export interface CorrelationFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export const CORRELATION_KEYS = [
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
] as const;

const als = new AsyncLocalStorage<CorrelationFields>();

/** Run `fn` with a fresh correlation scope seeded from `seed`. */
export function runWithCorrelation<T>(seed: CorrelationFields, fn: () => T): T {
  return als.run({ ...seed }, fn);
}

/** The current scope's fields (empty object when outside any scope). */
export function currentCorrelation(): CorrelationFields {
  return als.getStore() ?? {};
}

/** Merge more fields into the current scope as they become known (walletId, transactionId, …). */
export function enrichCorrelation(patch: CorrelationFields): void {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}
