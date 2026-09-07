import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import { ensureSchema, startTestApp, TestApp } from '../helpers/test-app';
import { bet, Client } from '../helpers/client';

let app: TestApp;
let client: Client;

beforeAll(async () => {
  await ensureSchema();
  app = await startTestApp();
  client = new Client(app.baseUrl);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.truncate();
});

describe('hot wallet — section 8 mandatory scenario', () => {
  it('two simultaneous 80.00 bets against a 100.00 balance', async () => {
    const playerId = uuidv7();
    const created = await client.createWallet(playerId, '100.00');
    expect(created.status).toBe(201);
    const walletId = created.body.id;

    const [a, b] = await Promise.all([
      client.submit(bet({ walletId, playerId, roundId: 'r1' })),
      client.submit(bet({ walletId, playerId, roundId: 'r2' })),
    ]);

    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const rejected = [a, b].find((r) => r.body.status === 'REJECTED')!;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const processed = [a, b].find((r) => r.body.status === 'PROCESSED')!;
    expect(processed.status).toBe(200);
    expect(processed.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const wallet = await client.wallet(walletId);
    expect(wallet.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const ledger = await client.ledger(walletId);
    const debits = ledger.body.entries.filter((e: any) => e.direction === 'DEBIT');
    expect(debits).toHaveLength(1);

    const recon = await client.reconcile(walletId);
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('the same bet submitted 50x in parallel produces exactly one debit', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;

    const payload = bet({ walletId, playerId, money: { amount: '30.00', currency: 'BRL' } });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => client.submit(payload)),
    );

    const processed = results.filter((r) => r.body.status === 'PROCESSED');
    const replays = results.filter((r) => r.body.idempotentReplay === true);
    expect(processed).toHaveLength(50); // all report PROCESSED (original or replayed)
    expect(replays.length).toBe(49);

    const ids = new Set(results.map((r) => r.body.transactionId));
    expect(ids.size).toBe(1);

    const ledger = await client.ledger(walletId);
    const debits = ledger.body.entries.filter((e: any) => e.direction === 'DEBIT');
    expect(debits).toHaveLength(1);

    const wallet = await client.wallet(walletId);
    expect(wallet.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });

    const recon = await client.reconcile(walletId);
    expect(recon.body.consistent).toBe(true);
  });

  it('rejects the same idempotency key with a different payload as a conflict', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    const key = `provider-a:${uuidv7()}`;

    const first = await client.submit(
      bet({ walletId, playerId, money: { amount: '10.00', currency: 'BRL' } }),
      key,
    );
    expect(first.body.status).toBe('PROCESSED');

    const conflict = await client.submit(
      bet({ walletId, playerId, money: { amount: '11.00', currency: 'BRL' } }),
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('IDEMPOTENCY_CONFLICT');
  });
});
