import { describe, expect, it } from 'bun:test';
import { Wallet } from './wallet';
import { Money } from '../shared/money';
import { BalanceWouldGoNegativeError, WalletCurrencyMismatchError } from './errors';
import { LedgerDirection } from '../wager/enums';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

const openWith = (amount: string) =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount) });

describe('Wallet.open', () => {
  it('is born at version 1 already holding the opening balance', () => {
    const w = openWith('100.00');
    expect(w.version).toBe(1);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });

  it('openingEntry backs the opening balance with a balanced CREDIT', () => {
    const w = openWith('100.00');
    const entry = w.openingEntry({ transactionId: 't0', ledgerEntryId: 'l0' });
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('100.00');
    expect(entry.isBalanced()).toBe(true);
    expect(w.version).toBe(1); // not a balance change
  });
});

describe('Wallet movements', () => {
  it('credit increases balance and bumps version', () => {
    const w = openWith('0.00');
    expect(w.version).toBe(1);
    const { entry } = w.credit({ transactionId: 't1', ledgerEntryId: 'l1', amount: brl('100.00') });
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('100.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('debit decreases balance and produces a balanced entry', () => {
    const w = openWith('0.00');
    w.credit({ transactionId: 't1', ledgerEntryId: 'l1', amount: brl('100.00') });
    const { entry } = w.debit({ transactionId: 't2', ledgerEntryId: 'l2', amount: brl('80.00') });
    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(3);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects a debit that would go negative — invariant guard', () => {
    const w = openWith('0.00');
    w.credit({ transactionId: 't1', ledgerEntryId: 'l1', amount: brl('50.00') });
    expect(() => w.debit({ transactionId: 't2', ledgerEntryId: 'l2', amount: brl('80.00') })).toThrow(
      BalanceWouldGoNegativeError,
    );
    expect(w.balance.toString()).toBe('50.00');
    expect(w.version).toBe(2); // unchanged
  });

  it('rejects a movement in a different currency', () => {
    const w = openWith('0.00');
    expect(() =>
      w.credit({ transactionId: 't1', ledgerEntryId: 'l1', amount: Money.from({ amount: '1.00', currency: 'USD' }) }),
    ).toThrow(WalletCurrencyMismatchError);
  });

  it('allows draining to exactly zero', () => {
    const w = openWith('0.00');
    w.credit({ transactionId: 't1', ledgerEntryId: 'l1', amount: brl('30.00') });
    w.debit({ transactionId: 't2', ledgerEntryId: 'l2', amount: brl('30.00') });
    expect(w.balance.toString()).toBe('0.00');
  });
});
