import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import { ensureSchema } from '../helpers/test-app';
import { Cluster, startCluster } from '../helpers/cluster';
import { DbAdmin, openDbAdmin } from '../helpers/db-admin';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: DbAdmin;
let running: Cluster | undefined;

beforeAll(async () => {
  await ensureSchema();
  db = await openDbAdmin();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncate();
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function createWallet(baseUrl: string, playerId: string, amount: string): Promise<string> {
  const res = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status !== 201) throw new Error(`createWallet ${res.status}: ${JSON.stringify(body)}`);
  return body.id;
}

async function bet(baseUrl: string, walletId: string, playerId: string, amount: string) {
  const ext = uuidv7();
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${ext}` },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('service restart — consistency survives (challenge §13.8)', () => {
  it('a fresh process continues correctly and picks up the outbox work the old one left', async () => {
    const playerId = uuidv7();

    // ── instance 1: outbox relay OFF, so events pile up unpublished ──
    running = await startCluster(1, { OUTBOX_RELAY_ENABLED: 'false' });
    const url1 = running.baseUrls[0]!;
    const walletId = await createWallet(url1, playerId, '500.00');
    for (let i = 0; i < 5; i++) {
      expect((await bet(url1, walletId, playerId, '10.00')).body.status).toBe('PROCESSED');
    }
    expect(await db.pendingOutbox()).toBeGreaterThan(0);
    const invMid = await db.walletVsLedger(walletId);
    expect(invMid.stored).toBe('450.00');
    expect(invMid.equal).toBe(true);

    // ── restart: SIGTERM instance 1, bring up instance 2 with the relay ON ──
    await running.stop();
    running = await startCluster(1, {
      OUTBOX_RELAY_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: '200',
    });
    const url2 = running.baseUrls[0]!;

    // instance 2's relay drains what instance 1 committed but never published
    for (let i = 0; i < 60 && (await db.pendingOutbox()) > 0; i++) await wait(100);
    expect(await db.pendingOutbox()).toBe(0);

    // instance 2 keeps processing correctly against the same wallet
    for (let i = 0; i < 3; i++) {
      expect((await bet(url2, walletId, playerId, '10.00')).body.status).toBe('PROCESSED');
    }

    // ── final invariant ──
    const wallet = (await fetch(`${url2}/wallets/${walletId}`).then((r) => r.json())) as any;
    expect(wallet.balance).toEqual({ amount: '420.00', currency: 'BRL' }); // 500 − 8×10

    const inv = await db.walletVsLedger(walletId);
    expect(inv.equal).toBe(true);
    expect(inv.stored).toBe('420.00');
    expect(await db.debitCount(walletId)).toBe(8);

    const recon = (await fetch(`${url2}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    }).then((r) => r.json())) as any;
    expect(recon.consistent).toBe(true);
  });
});
