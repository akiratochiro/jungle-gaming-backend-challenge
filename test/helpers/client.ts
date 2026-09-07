import { uuidv7 } from 'uuidv7';

export class Client {
  constructor(private readonly baseUrl: string) {}

  async createWallet(playerId: string, amount: string, currency = 'BRL') {
    const res = await fetch(`${this.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  async submit(payload: Record<string, unknown>, idempotencyKey?: string) {
    const key = idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`;
    const res = await fetch(`${this.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async wallet(walletId: string) {
    const res = await fetch(`${this.baseUrl}/wallets/${walletId}`);
    return { status: res.status, body: (await res.json()) as any };
  }

  async ledger(walletId: string) {
    const res = await fetch(`${this.baseUrl}/wallets/${walletId}/ledger?limit=200`);
    return { status: res.status, body: (await res.json()) as any };
  }

  async reconcile(walletId: string) {
    const res = await fetch(`${this.baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
    return { status: res.status, body: (await res.json()) as any };
  }
}

export const op = (kind: string, over: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: uuidv7(),
  playerId: over.playerId ?? uuidv7(),
  walletId: over.walletId,
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind,
  money: { amount: '80.00', currency: 'BRL' },
  ...over,
});

export const bet = (over: Record<string, unknown> = {}) => op('BET', over);

