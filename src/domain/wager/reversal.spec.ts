import { describe, expect, it } from 'bun:test';
import { validateReversal } from './reversal';
import { WagerTransaction } from './wager-transaction';
import { Money } from '../shared/money';
import { WagerTransactionKind } from './enums';
import { FailureCode } from './failure-code';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

const tx = (over: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
  WagerTransaction.create({
    id: over.id ?? 'id-' + Math.random(),
    providerId: 'provider-a',
    externalTransactionId: 'ext',
    idempotencyKey: 'k',
    payloadHash: 'h',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    ...over,
  });

const processed = (over: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) => {
  const t = tx(over);
  t.markProcessed(undefined, new Date());
  return t;
};

describe('validateReversal', () => {
  it('accepts a REFUND of a PROCESSED BET with the same attributes and amount', () => {
    const bet = processed({ kind: WagerTransactionKind.Bet });
    const refund = tx({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext',
    });
    expect(validateReversal(refund, bet)).toBeNull();
  });

  it('rejects a REFUND that does not target a BET', () => {
    const win = processed({ kind: WagerTransactionKind.Win });
    const refund = tx({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext' });
    expect(validateReversal(refund, win)).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  it('ROLLBACK may target BET, WIN or REFUND', () => {
    const rb = () => tx({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext' });
    expect(validateReversal(rb(), processed({ kind: WagerTransactionKind.Bet }))).toBeNull();
    expect(validateReversal(rb(), processed({ kind: WagerTransactionKind.Win }))).toBeNull();
    expect(validateReversal(rb(), processed({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'x' }))).toBeNull();
    expect(validateReversal(rb(), processed({ kind: WagerTransactionKind.Loss }))).toBe(
      FailureCode.ReferenceKindNotAllowed,
    );
  });

  it('rejects when the reference is not PROCESSED', () => {
    const pendingBet = tx({ kind: WagerTransactionKind.Bet });
    const refund = tx({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext' });
    expect(validateReversal(refund, pendingBet)).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('rejects a cross-wallet / cross-player / cross-round reference', () => {
    const bet = processed({ kind: WagerTransactionKind.Bet, walletId: 'other' });
    const refund = tx({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext' });
    expect(validateReversal(refund, bet)).toBe(FailureCode.ReferenceMismatch);
  });

  it('rejects a partial reversal (amount differs from the reference)', () => {
    const bet = processed({ kind: WagerTransactionKind.Bet, money: brl('25.00') });
    const refund = tx({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext',
      money: brl('10.00'),
    });
    expect(validateReversal(refund, bet)).toBe(FailureCode.ReversalAmountMismatch);
  });
});
