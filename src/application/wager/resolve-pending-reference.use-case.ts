import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { WagerTransactionStatus } from '../../domain/wager/enums';
import { FailureCode } from '../../domain/wager/failure-code';
import { IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wager-events';
import { WagerUnitOfWork } from '../ports/wager-unit-of-work';
import { ApplyReversalService } from './apply-reversal.service';
import { ReferenceResolutionPolicy } from './reference-resolution-policy';

export interface ResolvePendingReferenceCommand {
  transactionId: string;
  walletId: string;
}

export type ResolvePendingReferenceResult =
  | { outcome: 'noop' }
  | { outcome: 'rescheduled'; attempts: number }
  | { outcome: 'processed' | 'rejected'; status: WagerTransactionStatus; failureCode?: FailureCode };

/**
 * Re-attempts one PENDING_REFERENCE transaction, under the wallet lock. Called
 * by the scheduled worker. Reuses `ApplyReversalService` so REFUND/ROLLBACK
 * rules stay in one place.
 */
@Injectable()
export class ResolvePendingReferenceUseCase {
  private readonly logger = new Logger(ResolvePendingReferenceUseCase.name);

  constructor(
    private readonly uow: WagerUnitOfWork,
    private readonly reversals: ApplyReversalService,
    private readonly policy: ReferenceResolutionPolicy,
  ) {}

  execute(cmd: ResolvePendingReferenceCommand): Promise<ResolvePendingReferenceResult> {
    return this.uow.runForWallet(cmd.walletId, async (ctx) => {
      const tx = await ctx.findById(cmd.transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
        return { outcome: 'noop' };
      }
      const wallet = ctx.wallet;
      if (!wallet) return { outcome: 'noop' };

      const now = new Date();
      const eventCtx = { correlationId: uuidv7(), causationId: tx.id };
      const events: IntegrationEvent<unknown>[] = [];

      const reference = await ctx.findByProviderRef(
        tx.providerId,
        tx.referenceExternalTransactionId as string,
      );

      if (!reference) {
        if (tx.hasExhaustedReferenceResolution(this.policy.maxAttempts)) {
          tx.reject(FailureCode.ReferenceNotFound);
          events.push(WagerTransactionRejected.from(tx, eventCtx));
          await ctx.updateWagerTransaction(tx, wallet.balance.toJSON());
          await ctx.enqueueOutbox(events);
          return { outcome: 'rejected', status: tx.status, failureCode: tx.failureCode };
        }
        tx.markPendingReference(this.policy.nextAttemptAt(tx.referenceResolutionAttempts, now));
        await ctx.updateWagerTransaction(tx);
        return { outcome: 'rescheduled', attempts: tx.referenceResolutionAttempts };
      }

      const result = await this.reversals.apply(ctx, wallet, tx, tx.money, reference, now);

      if (result.rejected) {
        events.push(WagerTransactionRejected.from(tx, eventCtx));
        await ctx.updateWagerTransaction(tx, wallet.balance.toJSON());
      } else {
        events.push(WagerTransactionProcessed.from(tx, eventCtx));
        if (result.entry) {
          events.push(WalletBalanceChanged.from(wallet, result.entry, eventCtx));
        }
        await ctx.updateWagerTransaction(tx, wallet.balance.toJSON());
        if (result.entry) {
          await ctx.insertLedgerEntry(result.entry);
          await ctx.saveWallet(wallet);
        }
      }
      await ctx.enqueueOutbox(events);
      return {
        outcome: result.rejected ? 'rejected' : 'processed',
        status: tx.status,
        failureCode: tx.failureCode,
      };
    });
  }
}
