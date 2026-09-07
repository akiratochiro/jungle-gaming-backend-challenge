import { DomainError } from '../shared/domain-error';

export class WalletCurrencyMismatchError extends DomainError {
  readonly code = 'WALLET_CURRENCY_MISMATCH';
  constructor(walletCurrency: string, opCurrency: string) {
    super(`Operation currency ${opCurrency} does not match wallet currency ${walletCurrency}`);
  }
}

/**
 * Structural guard on the aggregate: a movement would drive the balance below
 * zero. The application layer is expected to catch the specific business case
 * (insufficient funds vs. reversal overdraw) earlier and attach a FailureCode;
 * this is the last line of defence so the invariant can never be violated.
 */
export class BalanceWouldGoNegativeError extends DomainError {
  readonly code = 'BALANCE_WOULD_GO_NEGATIVE';
  constructor() {
    super('Wallet movement would result in a negative balance');
  }
}
