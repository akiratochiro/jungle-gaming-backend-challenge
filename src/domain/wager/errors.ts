import { DomainError } from '../shared/domain-error';
import { FailureCode } from './failure-code';
import { WagerTransactionStatus } from './enums';

/** Attempted a state transition that the current (terminal) status forbids. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`Illegal wager transaction transition: ${from} -> ${to}`);
  }
}

/** A domain rule rejected the transaction. Carries a stable, machine-readable code. */
export class WagerRejectedError extends DomainError {
  readonly code = 'WAGER_REJECTED';
  constructor(
    readonly failureCode: FailureCode,
    message?: string,
  ) {
    super(message ?? `Wager rejected: ${failureCode}`);
  }
}

/** Same idempotency key seen with a different business payload. Not a replay. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}
