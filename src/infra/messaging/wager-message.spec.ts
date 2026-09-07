import { describe, expect, it } from 'bun:test';
import { MalformedMessageError, parseWagerMessage } from './wager-message';

const valid = {
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    idempotencyKey: 'provider-a:tx-1',
    playerId: 'p1',
    walletId: 'w1',
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

describe('parseWagerMessage', () => {
  it('parses a well-formed envelope', () => {
    const m = parseWagerMessage(JSON.stringify(valid));
    expect(m.messageId).toBe('msg-1');
    expect(String(m.data.kind)).toBe('BET');
    expect(m.data.idempotencyKey).toBe('provider-a:tx-1');
  });

  it('derives the idempotency key when absent', () => {
    const { idempotencyKey, ...rest } = valid.data;
    const m = parseWagerMessage(JSON.stringify({ ...valid, data: rest }));
    expect(m.data.idempotencyKey).toBe('provider-a:tx-1');
  });

  it.each([
    '{not json',
    JSON.stringify({ type: 'Other', data: {} }),
    JSON.stringify({ ...valid, messageId: '' }),
    JSON.stringify({ ...valid, data: { ...valid.data, kind: 'NONSENSE' } }),
    JSON.stringify({ ...valid, data: { ...valid.data, money: undefined } }),
    JSON.stringify({ ...valid, data: { ...valid.data, walletId: undefined } }),
  ])('rejects malformed input %#', (raw) => {
    expect(() => parseWagerMessage(raw)).toThrow(MalformedMessageError);
  });
});
