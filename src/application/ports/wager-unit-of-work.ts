import { IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransactionKind } from '../../domain/wager/enums';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/** Snapshot of an already-persisted wager transaction, enough to replay it. */
export interface PersistedWagerSnapshot {
  transaction: WagerTransaction;
  resultBalance?: { amount: string; currency: string };
}

/**
 * Everything a use case needs to do inside one SQL transaction. All writes here
 * — wager transaction, wallet, ledger, inbox, outbox — commit or roll back
 * together. The wallet row is already locked FOR UPDATE when this context is
 * handed over.
 */
export interface WagerTxContext {
  /** The wallet, locked FOR UPDATE. `null` if it does not exist. */
  readonly wallet: Wallet | null;

  findByIdempotencyKey(idempotencyKey: string): Promise<PersistedWagerSnapshot | null>;

  findById(transactionId: string): Promise<WagerTransaction | null>;

  /** Find a sibling transaction by provider + external id (reference resolution). */
  findByProviderRef(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;

  /**
   * An existing PROCESSED reversal of `referenceTransactionId` by the given
   * kind, if any (rule 7.4). Used to reject a second REFUND/ROLLBACK of the same
   * reference before the DB partial-unique index would.
   */
  findReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null>;

  insertWagerTransaction(tx: WagerTransaction, resultBalance?: { amount: string; currency: string }): Promise<void>;
  updateWagerTransaction(tx: WagerTransaction, resultBalance?: { amount: string; currency: string }): Promise<void>;

  saveWallet(wallet: Wallet): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;

  /** Append integration events to the outbox in the same transaction. */
  enqueueOutbox(events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void>;

  /**
   * Register an inbox row for the SQS path. Returns false when the row already
   * exists and is processed (duplicate delivery — caller should ack and skip).
   */
  claimInbox?(consumerName: string, messageId: string, payloadHash: string): Promise<boolean>;
  markInboxProcessed?(consumerName: string, messageId: string): Promise<void>;
}

export abstract class WagerUnitOfWork {
  /**
   * Opens a SQL transaction, acquires a pessimistic write lock on the wallet
   * identified by `walletId`, then runs `fn`. Commits on success; rolls back and
   * rethrows on error.
   */
  abstract runForWallet<T>(walletId: string, fn: (ctx: WagerTxContext) => Promise<T>): Promise<T>;
}
