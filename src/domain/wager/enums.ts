export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: wallet opening credit — never accepted from API/queue
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // accepted, not yet applied
  PendingReference = 'PENDING_REFERENCE', // waiting for the referenced transaction
  Processed = 'PROCESSED', // applied (terminal)
  Rejected = 'REJECTED', // business-rule violation (terminal)
  Failed = 'FAILED', // permanent infrastructure error (terminal, auditable)
}

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return TERMINAL.has(status);
}
