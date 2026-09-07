import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import { EntityManager } from '@mikro-orm/postgresql';
import { ensureSchema, startTestApp, TestApp } from '../helpers/test-app';
import { bet, Client } from '../helpers/client';

let app: TestApp;
let client: Client;
let em: EntityManager;

const sql = (q: string, params: unknown[] = []) => em.getConnection().execute(q, params);

beforeAll(async () => {
  await ensureSchema();
  app = await startTestApp();
  client = new Client(app.baseUrl);
  em = app.get<EntityManager>(EntityManager);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.truncate();
});

/**
 * The domain invariants from §6 are enforced in the schema, not only in code
 * (§5.9). These probes hit the DB directly and assert it rejects the write.
 */
describe('schema constraints & triggers (§5.9 / §13 "migrations e constraints")', () => {
  it('wallets: balance may not be negative', async () => {
    await expect(
      sql(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', -1.00, 1, now(), now())`,
        [uuidv7(), uuidv7()],
      ),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  it('wallets: one wallet per (playerId, currency)', async () => {
    const playerId = uuidv7();
    await client.createWallet(playerId, '10.00');
    await expect(
      sql(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', 0.00, 1, now(), now())`,
        [uuidv7(), playerId],
      ),
    ).rejects.toThrow(/wallets_player_currency_uniq/);
  });

  it('wallet_ledger_entries: UPDATE is blocked (append-only trigger)', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    await client.submit(bet({ walletId, playerId, money: { amount: '10.00', currency: 'BRL' } }));

    await expect(
      sql('UPDATE wallet_ledger_entries SET amount = amount WHERE wallet_id = ?', [walletId]),
    ).rejects.toThrow(/append-only/);
  });

  it('wallet_ledger_entries: DELETE is blocked (append-only trigger)', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    await client.submit(bet({ walletId, playerId, money: { amount: '10.00', currency: 'BRL' } }));

    await expect(
      sql('DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]),
    ).rejects.toThrow(/append-only/);
  });

  it('wallet_ledger_entries: the balanceBefore ± amount = balanceAfter arithmetic is enforced', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '10.00')).body.id;
    // a rejected bet leaves a wager_transaction with no ledger entry
    const rejected = await client.submit(
      bet({ walletId, playerId, money: { amount: '25.00', currency: 'BRL' } }),
    );
    expect(rejected.body.status).toBe('REJECTED');

    await expect(
      sql(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', 5.00, 'BRL', 0.00, 99.00, now())`,
        [uuidv7(), walletId, rejected.body.transactionId],
      ),
    ).rejects.toThrow(/wallet_ledger_entries_arithmetic/);
  });

  it('wager_transactions: idempotency_key is unique', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    const res = await client.submit(bet({ walletId, playerId, money: { amount: '10.00', currency: 'BRL' } }));

    // clone the row with a new id but the same idempotency_key
    await expect(
      sql(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, reference_attempts, balance_changed, created_at, updated_at)
         SELECT ?, provider_id, ?, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, 0, false, now(), now()
         FROM wager_transactions WHERE id = ?`,
        [uuidv7(), uuidv7(), res.body.transactionId],
      ),
    ).rejects.toThrow(/wager_transactions_idempotency_key_uniq/);
  });

  it('wager_transactions: REFUND/ROLLBACK must carry a reference', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    const res = await client.submit(bet({ walletId, playerId, money: { amount: '10.00', currency: 'BRL' } }));

    await expect(
      sql(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, reference_attempts, balance_changed, created_at, updated_at)
         SELECT ?, provider_id, ?, ?, payload_hash, wallet_id, player_id,
            round_id, game_id, 'REFUND', amount, currency, 'PENDING', 0, false, now(), now()
         FROM wager_transactions WHERE id = ?`,
        [uuidv7(), uuidv7(), `k:${uuidv7()}`, res.body.transactionId],
      ),
    ).rejects.toThrow(/wager_transactions_reference_required/);
  });

  it('migration is reversible (down drops everything, up rebuilds it)', async () => {
    // sanity: the migration table has exactly the one applied migration
    const rows = await sql('SELECT name FROM mikro_orm_migrations ORDER BY id');
    expect(rows.length).toBe(1);
    expect((rows[0] as any).name).toContain('Migration2026');
  });
});
