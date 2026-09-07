import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import { ensureSchema } from '../helpers/test-app';
import { Cluster, startCluster } from '../helpers/cluster';
import { DbAdmin, openDbAdmin } from '../helpers/db-admin';

const INSTANCES = 3;

let cluster: Cluster;
let db: DbAdmin;

beforeAll(async () => {
  await ensureSchema();
  db = await openDbAdmin();
  cluster = await startCluster(INSTANCES);
}, 90_000);

afterAll(async () => {
  await cluster?.stop();
  await db?.close();
});

beforeEach(async () => {
  await db.truncate();
});

async function createWallet(baseUrl: string, playerId: string, amount: string): Promise<string> {
  const res = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status !== 201) throw new Error(`createWallet failed: ${res.status} ${JSON.stringify(body)}`);
  return body.id;
}

function betBody(walletId: string, playerId: string, amount: string, externalId: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function submit(baseUrl: string, body: unknown, key: string) {
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe(`${INSTANCES} real application instances — one Postgres + LocalStack (challenge §13.4)`, () => {
  it('§8 scenario: two 80.00 bets, each sent to a different instance', async () => {
    const playerId = uuidv7();
    const walletId = await createWallet(cluster.pick(0), playerId, '100.00');

    const ext1 = uuidv7();
    const ext2 = uuidv7();
    const [a, b] = await Promise.all([
      submit(cluster.pick(1), betBody(walletId, playerId, '80.00', ext1), `provider-a:${ext1}`),
      submit(cluster.pick(2), betBody(walletId, playerId, '80.00', ext2), `provider-a:${ext2}`),
    ]);

    expect([a.body.status, b.body.status].sort()).toEqual(['PROCESSED', 'REJECTED']);

    const rejected = [a, b].find((r) => r.body.status === 'REJECTED')!;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const processed = [a, b].find((r) => r.body.status === 'PROCESSED')!;
    expect(processed.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    expect(await db.debitCount(walletId)).toBe(1);

    const inv = await db.walletVsLedger(walletId);
    expect(inv.stored).toBe('20.00');
    expect(inv.equal).toBe(true);

    // the documented reconciliation endpoint, queried on a third instance, agrees
    const recon = (await fetch(`${cluster.pick(0)}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    }).then((r) => r.json())) as any;
    expect(recon.consistent).toBe(true);
    expect(recon.difference).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('idempotency: the same bet 50× in parallel, round-robined across all instances → one debit', async () => {
    const playerId = uuidv7();
    const walletId = await createWallet(cluster.pick(0), playerId, '100.00');

    const ext = uuidv7();
    const key = `provider-a:${ext}`;
    const body = betBody(walletId, playerId, '30.00', ext);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(cluster.pick(i), body, key)),
    );

    const ids = new Set(results.map((r) => r.body.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);

    expect(await db.debitCount(walletId)).toBe(1);

    const inv = await db.walletVsLedger(walletId);
    expect(inv.stored).toBe('70.00');
    expect(inv.equal).toBe(true);
  });

  it('distinct wallets driven in parallel across instances stay independent and consistent', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const playerId = uuidv7();
        return { walletId: await createWallet(cluster.pick(0), playerId, '100.00'), playerId };
      }),
    );

    await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 5 }, (_, i) => {
          const ext = uuidv7();
          return submit(
            cluster.pick(wi + i),
            betBody(w.walletId, w.playerId, '10.00', ext),
            `provider-a:${ext}`,
          );
        }),
      ),
    );

    for (const w of wallets) {
      const inv = await db.walletVsLedger(w.walletId);
      expect(inv.equal).toBe(true);
      expect(inv.stored).toBe('50.00'); // 100 - 5 × 10
      expect(await db.debitCount(w.walletId)).toBe(5);
    }
  });
});
