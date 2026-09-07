import { Injectable } from '@nestjs/common';
import { Money } from '../../domain/shared/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { LedgerDirection } from '../../domain/wager/enums';
import { FailureCode } from '../../domain/wager/failure-code';
import { validateReversal } from '../../domain/wager/reversal';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { BalanceWouldGoNegativeError } from '../../domain/wallet/errors';
import { IdGenerator } from '../ports/id-generator';
import { WagerTxContext } from '../ports/wager-unit-of-work';

export interface ReversalOutcome {
  rejected: boolean;
  entry?: WalletLedgerEntry;
}

/**
 * Validates and applies a REFUND / ROLLBACK against an already-resolved
 * reference, inside an open wallet lock. Shared by the synchronous submit path
 * and the pending-reference worker so the rules live in exactly one place.
 */
@Injectable()
export class ApplyReversalService {
  constructor(private readonly ids: IdGenerator) {}

  async apply(
    ctx: Pick<WagerTxContext, 'findReversal'>,
    wallet: Wallet,
    tx: WagerTransaction,
    money: Money,
    reference: WagerTransaction,
    now: Date,
  ): Promise<ReversalOutcome> {
    const ruleBreak = validateReversal(tx, reference);
    if (ruleBreak) {
      tx.reject(ruleBreak);
      return { rejected: true };
    }

    // A reference may be reversed at most once per kind (rule 7.4). The DB
    // partial-unique index is the ultimate guard; this gives a clean rejection.
    const existing = await ctx.findReversal(reference.id, tx.kind);
    if (existing && existing.id !== tx.id) {
      tx.reject(FailureCode.ReferenceAlreadyReversed);
      return { rejected: true };
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = { transactionId: tx.id, ledgerEntryId: this.ids.next(), amount: money, at: now };

    try {
      const { entry } =
        direction === LedgerDirection.Credit ? wallet.credit(movement) : wallet.debit(movement);
      tx.markProcessed(reference.id, now);
      return { rejected: false, entry };
    } catch (e) {
      if (e instanceof BalanceWouldGoNegativeError) {
        // Distinct from INSUFFICIENT_FUNDS — a reversal overdraw is operationally
        // different and stays auditable (rule 7.9).
        tx.reject(FailureCode.ReversalWouldOverdraw);
        return { rejected: true };
      }
      throw e;
    }
  }
}
