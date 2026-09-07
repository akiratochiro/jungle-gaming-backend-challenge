import { describe, expect, it } from 'bun:test';
import { WagerTransaction } from './wager-transaction';
import { Money } from '../shared/money';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from './enums';
import { FailureCode } from './failure-code';
import { InvalidTransactionStateError } from './errors';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

const base = {
  id: 'tx1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1',
  payloadHash: 'hash-1',
  walletId: 'w1',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  money: brl('25.00'),
};

const make = (over: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
  WagerTransaction.create({ ...base, kind: WagerTransactionKind.Bet, ...over });

describe('WagerTransaction.create', () => {
  it('is born PENDING', () => {
    expect(make().status).toBe(WagerTransactionStatus.Pending);
  });

  it('requires a reference for REFUND and ROLLBACK', () => {
    expect(() => make({ kind: WagerTransactionKind.Refund })).toThrow();
    expect(() => make({ kind: WagerTransactionKind.Rollback })).toThrow();
    expect(() =>
      make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    ).not.toThrow();
  });
});

describe('WagerTransaction transitions', () => {
  it('PENDING -> PROCESSED', () => {
    const tx = make();
    tx.markProcessed(undefined, new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
  });

  it('terminal states are frozen', () => {
    const tx = make();
    tx.reject(FailureCode.InsufficientFunds);
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
  });

  it('PENDING -> PENDING_REFERENCE -> PROCESSED is allowed', () => {
    const tx = make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    tx.markProcessed('ref-tx', new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });
});

describe('WagerTransaction domain queries', () => {
  it('affectsBalance is false only for LOSS', () => {
    expect(make({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
    expect(make({ kind: WagerTransactionKind.Bet }).affectsBalance()).toBe(true);
  });

  it('ledger direction per kind', () => {
    expect(make({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'x' }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it('ROLLBACK inverts the referenced direction', () => {
    const bet = make({ kind: WagerTransactionKind.Bet });
    const rollback = make({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-1',
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it('matchesPayload compares the stored hash', () => {
    const tx = make();
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('other')).toBe(false);
  });
});
