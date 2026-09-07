import { WagerTransactionKind, WagerTransactionStatus } from './enums';
import { FailureCode } from './failure-code';
import { WagerTransaction } from './wager-transaction';

/** Which reference kinds each reversal kind is allowed to target (rule 7.3). */
const ALLOWED_REFERENCE_KINDS: Record<string, ReadonlySet<WagerTransactionKind>> = {
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

/**
 * Pure validation of a REFUND / ROLLBACK against its resolved reference.
 * Returns a `FailureCode` when a rule is broken, or `null` when the reversal is
 * allowed to be applied. Does NOT check "already reversed" (needs a repository
 * lookup) nor overdraft (needs the wallet) — those are handled by the caller.
 */
export function validateReversal(
  reversal: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | null {
  const allowed = ALLOWED_REFERENCE_KINDS[reversal.kind];
  if (!allowed) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (!allowed.has(reference.kind)) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  // Same provider, player, wallet, currency and round (rule 7.2).
  if (
    reference.providerId !== reversal.providerId ||
    reference.playerId !== reversal.playerId ||
    reference.walletId !== reversal.walletId ||
    reference.roundId !== reversal.roundId ||
    reference.money.currency !== reversal.money.currency
  ) {
    return FailureCode.ReferenceMismatch;
  }
  // Full reversal only — the amount must equal the reference (rule 7.5).
  if (!reversal.money.equals(reference.money)) {
    return FailureCode.ReversalAmountMismatch;
  }
  return null;
}
