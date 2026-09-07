import { WagerTransactionKind } from '../../domain/wager/enums';
import { WagerBusinessPayload } from '../../application/wager/wager-payload';

export const WAGER_REQUESTED_TYPE = 'WagerTransactionRequested';

export interface WagerTransactionRequestedMessage {
  messageId: string;
  type: typeof WAGER_REQUESTED_TYPE;
  occurredAt: string;
  data: WagerBusinessPayload & { idempotencyKey: string };
}

/** Thrown for a message we can never process — goes straight to the DLQ. */
export class MalformedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedMessageError';
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new MalformedMessageError(`missing or invalid "${field}"`);
  }
  return v;
}

/**
 * Structurally validates the SQS body. Domain validation (money format, wallet
 * existence, currency, …) still happens inside the shared use case.
 */
export function parseWagerMessage(raw: string): WagerTransactionRequestedMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MalformedMessageError('body is not valid JSON');
  }
  if (typeof json !== 'object' || json === null) {
    throw new MalformedMessageError('body is not an object');
  }
  const env = json as Record<string, unknown>;
  if (env.type !== WAGER_REQUESTED_TYPE) {
    throw new MalformedMessageError(`unexpected type ${String(env.type)}`);
  }
  const messageId = str(env.messageId, 'messageId');
  const data = env.data;
  if (typeof data !== 'object' || data === null) {
    throw new MalformedMessageError('missing "data"');
  }
  const d = data as Record<string, unknown>;
  const kind = str(d.kind, 'data.kind') as WagerTransactionKind;
  if (!Object.values(WagerTransactionKind).includes(kind)) {
    throw new MalformedMessageError(`unknown kind ${kind}`);
  }
  if (typeof d.money !== 'object' || d.money === null) {
    throw new MalformedMessageError('missing "data.money"');
  }
  const money = d.money as Record<string, unknown>;

  return {
    messageId,
    type: WAGER_REQUESTED_TYPE,
    occurredAt: typeof env.occurredAt === 'string' ? env.occurredAt : new Date().toISOString(),
    data: {
      providerId: str(d.providerId, 'data.providerId'),
      externalTransactionId: str(d.externalTransactionId, 'data.externalTransactionId'),
      idempotencyKey:
        typeof d.idempotencyKey === 'string' && d.idempotencyKey.length > 0
          ? d.idempotencyKey
          : `${str(d.providerId, 'data.providerId')}:${str(d.externalTransactionId, 'data.externalTransactionId')}`,
      playerId: str(d.playerId, 'data.playerId'),
      walletId: str(d.walletId, 'data.walletId'),
      roundId: str(d.roundId, 'data.roundId'),
      gameId: str(d.gameId, 'data.gameId'),
      kind,
      money: {
        amount: str(money.amount, 'data.money.amount'),
        currency: str(money.currency, 'data.money.currency'),
      },
      referenceExternalTransactionId:
        typeof d.referenceExternalTransactionId === 'string'
          ? d.referenceExternalTransactionId
          : undefined,
    },
  };
}
