import { IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletProvisioningContext {
  insertWallet(wallet: Wallet): Promise<void>;
  insertWagerTransaction(tx: WagerTransaction, resultBalance: { amount: string; currency: string }): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  enqueueOutbox(events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void>;
}

export abstract class WalletProvisioningUnitOfWork {
  /**
   * Runs `fn` in a single SQL transaction. The unique (playerId, currency)
   * constraint enforces "one wallet per player+currency" — a violation surfaces
   * as WalletAlreadyExistsError.
   */
  abstract run<T>(fn: (ctx: WalletProvisioningContext) => Promise<T>): Promise<T>;
}
