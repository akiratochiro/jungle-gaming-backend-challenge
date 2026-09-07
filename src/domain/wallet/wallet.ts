import { Money } from '../shared/money';
import { LedgerDirection } from '../wager/enums';
import { BalanceWouldGoNegativeError, WalletCurrencyMismatchError } from './errors';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  /** id of the wager transaction that causes this movement */
  transactionId: string;
  /** id to assign to the produced ledger entry */
  ledgerEntryId: string;
  amount: Money;
  at?: Date;
}

/** The single side effect of a balance movement: exactly one ledger entry. */
export interface WalletMovement {
  entry: WalletLedgerEntry;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet already holding `initialBalance`. Version is 1: establishing
   * the opening balance is part of creation, not a later balance change. The
   * caller is responsible for recording the corresponding OPENING transaction
   * and CREDIT ledger entry in the same SQL transaction (see `openingEntry`).
   */
  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /**
   * Builds the ledger entry that backs a non-zero opening balance. Pure helper;
   * does not mutate the wallet (the balance is already set by `open`).
   */
  openingEntry(props: { transactionId: string; ledgerEntryId: string }): WalletLedgerEntry {
    return WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletMovement {
    this.assertSameCurrency(props.amount);
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(props.amount);
    if (balanceAfter.isNegative()) {
      throw new BalanceWouldGoNegativeError();
    }
    return this.applyMovement(LedgerDirection.Debit, props, balanceBefore, balanceAfter);
  }

  credit(props: MovementProps): WalletMovement {
    this.assertSameCurrency(props.amount);
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(props.amount);
    return this.applyMovement(LedgerDirection.Credit, props, balanceBefore, balanceAfter);
  }

  private applyMovement(
    direction: LedgerDirection,
    props: MovementProps,
    balanceBefore: Money,
    balanceAfter: Money,
  ): WalletMovement {
    const at = props.at ?? new Date();
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.amount,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version += 1; // increments only when the balance changes
    this._updatedAt = at;
    return { entry };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new WalletCurrencyMismatchError(this.currency, money.currency);
    }
  }
}
