import { DomainError } from '../../domain/shared/domain-error';

/** Structurally invalid request (bad kind, malformed money, missing field). */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}

/** Target wallet does not exist — not persisted as a rejection. */
export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

/** A wallet already exists for this player + currency. */
export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player ${playerId} / ${currency}`);
  }
}

/** Transient infrastructure failure — caller may retry. */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}
