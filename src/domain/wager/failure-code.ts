/**
 * Machine-readable, stable rejection taxonomy. A provider can branch on these
 * without parsing human text: decide whether to resend, fix the payload or give up.
 */
export enum FailureCode {
  /** BET could not be applied: wallet balance is lower than the bet amount. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A reversal (ROLLBACK) would drive the wallet balance below zero. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** REFUND/ROLLBACK: the referenced transaction was never found within the TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference exists but is not PROCESSED (e.g. itself rejected/pending). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference belongs to a different provider/player/wallet/currency/round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND targeting a non-BET, or ROLLBACK targeting an unsupported kind. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** The reference was already reversed by an operation of this same kind. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** REFUND/ROLLBACK amount differs from the referenced amount (no partials). */
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  /** Operation currency does not match the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** REFUND/ROLLBACK submitted without referenceExternalTransactionId. */
  MissingReference = 'MISSING_REFERENCE',
  /** Target wallet does not exist. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** Payload names a player that does not own the target wallet. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Permanent infrastructure error while applying an accepted transaction. */
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}
