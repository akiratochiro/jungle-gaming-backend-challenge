import { Injectable } from '@nestjs/common';
import { Money, MoneyProps } from '../../domain/shared/money';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager/enums';
import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { IdempotencyConflictError } from '../../domain/wager/errors';
import { IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wager-events';
import { IdGenerator } from '../ports/id-generator';
import { WagerTxContext, WagerUnitOfWork } from '../ports/wager-unit-of-work';
import { WagerBusinessPayload, computePayloadHash } from './wager-payload';
import { ValidationError, WalletNotFoundError } from './errors';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: WagerBusinessPayload;
  correlationId: string;
  /** SQS path only: dedup key for the persistent inbox. */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/** Kinds a provider is allowed to submit (OPENING is internal). */
const SUBMITTABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** MVP slice: BET / WIN / LOSS applied synchronously. */
const SUPPORTED_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
]);

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: WagerUnitOfWork,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const { payload } = cmd;

    if (!SUBMITTABLE_KINDS.has(payload.kind)) {
      throw new ValidationError(`Kind ${payload.kind} cannot be submitted`);
    }
    if (!SUPPORTED_KINDS.has(payload.kind)) {
      throw new ValidationError(`Kind ${payload.kind} is not supported yet in this build`);
    }

    // Entry-contract validation of the monetary amount.
    const money = Money.from(payload.money);
    const payloadHash = computePayloadHash(payload);

    return this.uow.runForWallet(payload.walletId, (ctx) =>
      this.process(ctx, cmd, money, payloadHash),
    );
  }

  private async process(
    ctx: WagerTxContext,
    cmd: SubmitWagerCommand,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const { payload, correlationId } = cmd;

    // ---- SQS inbox dedup (no-op for the HTTP path) ----------------------
    if (cmd.inbox && ctx.claimInbox) {
      const fresh = await ctx.claimInbox(cmd.inbox.consumerName, cmd.inbox.messageId, payloadHash);
      if (!fresh) {
        const replay = await this.replayByKey(ctx, cmd.idempotencyKey, payloadHash);
        if (replay) return replay;
        // Row existed but original not yet visible — treat as transient.
        throw new Error('Inbox row present but original outcome not found; retry');
      }
    }

    // ---- persistent idempotency --------------------------------------------
    const replay = await this.replayByKey(ctx, cmd.idempotencyKey, payloadHash);
    if (replay) {
      if (cmd.inbox && ctx.markInboxProcessed) {
        await ctx.markInboxProcessed(cmd.inbox.consumerName, cmd.inbox.messageId);
      }
      return replay;
    }

    // ---- wallet must exist -----------------------------------------------
    const wallet = ctx.wallet;
    if (!wallet) {
      throw new WalletNotFoundError(payload.walletId);
    }

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: payload.walletId,
      playerId: payload.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money,
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    });

    const events: IntegrationEvent<unknown>[] = [];
    const eventCtx = { correlationId, causationId: tx.id };

    // ---- domain guards that produce a persisted REJECTED -----------------
    let outcome: { rejected: boolean; entry?: WalletLedgerEntry };
    if (wallet.playerId !== payload.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch);
      outcome = { rejected: true };
    } else if (money.currency !== wallet.currency) {
      tx.reject(FailureCode.CurrencyMismatch);
      outcome = { rejected: true };
    } else {
      outcome = this.applyKind(wallet, tx, money);
    }

    const resultBalance = wallet.balance.toJSON();

    if (outcome.rejected) {
      events.push(WagerTransactionRejected.from(tx, eventCtx));
      await ctx.insertWagerTransaction(tx, resultBalance);
    } else {
      events.push(WagerTransactionProcessed.from(tx, eventCtx));
      if (outcome.entry) {
        events.push(WalletBalanceChanged.from(wallet, outcome.entry, eventCtx));
      }
      await ctx.insertWagerTransaction(tx, resultBalance);
      if (outcome.entry) {
        await ctx.insertLedgerEntry(outcome.entry);
        await ctx.saveWallet(wallet);
      }
    }
    await ctx.enqueueOutbox(events);

    if (cmd.inbox && ctx.markInboxProcessed) {
      await ctx.markInboxProcessed(cmd.inbox.consumerName, cmd.inbox.messageId);
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: resultBalance,
      failureCode: tx.failureCode,
      idempotentReplay: false,
    };
  }

  /**
   * Applies BET / WIN / LOSS to the (locked) wallet aggregate. Pure in-memory:
   * mutates `wallet` and `tx`, returns the ledger entry to persist (if any).
   */
  private applyKind(
    wallet: NonNullable<WagerTxContext['wallet']>,
    tx: WagerTransaction,
    money: Money,
  ): { rejected: boolean; entry?: WalletLedgerEntry } {
    const now = new Date();
    switch (tx.kind) {
      case WagerTransactionKind.Loss:
        tx.markProcessed(undefined, now);
        return { rejected: false };

      case WagerTransactionKind.Bet: {
        if (wallet.balance.isLessThan(money)) {
          tx.reject(FailureCode.InsufficientFunds);
          return { rejected: true };
        }
        const { entry } = wallet.debit({
          transactionId: tx.id,
          ledgerEntryId: this.ids.next(),
          amount: money,
          at: now,
        });
        tx.markProcessed(undefined, now);
        return { rejected: false, entry };
      }

      case WagerTransactionKind.Win: {
        const { entry } = wallet.credit({
          transactionId: tx.id,
          ledgerEntryId: this.ids.next(),
          amount: money,
          at: now,
        });
        tx.markProcessed(undefined, now);
        return { rejected: false, entry };
      }

      default:
        throw new ValidationError(`Unsupported kind ${tx.kind}`);
    }
  }

  private async replayByKey(
    ctx: WagerTxContext,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<SubmitWagerResult | null> {
    const existing = await ctx.findByIdempotencyKey(idempotencyKey);
    if (!existing) return null;

    if (!existing.transaction.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return {
      transactionId: existing.transaction.id,
      status: existing.transaction.status,
      balance: existing.resultBalance,
      failureCode: existing.transaction.failureCode,
      idempotentReplay: true,
    };
  }
}
