import { MoneyProps } from '../../domain/shared/money';
import { sha256CanonicalHex } from '../../domain/shared/canonical-json';
import { WagerTransactionKind } from '../../domain/wager/enums';

/**
 * The business subset of a wager submission. Transport metadata (the
 * Idempotency-Key header, SQS envelope fields) is deliberately excluded — only
 * these fields feed the payload hash.
 */
export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash algorithm (documented in ARCHITECTURE.md):
 *   sha256( canonicalJSON( businessPayload ) )
 * where canonicalJSON sorts object keys at every level and drops undefined.
 */
export function computePayloadHash(payload: WagerBusinessPayload): string {
  return sha256CanonicalHex({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

export function defaultIdempotencyKey(payload: WagerBusinessPayload): string {
  return `${payload.providerId}:${payload.externalTransactionId}`;
}
