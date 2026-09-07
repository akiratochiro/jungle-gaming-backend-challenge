import { MikroORM } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import ormConfig from '../../src/infra/database/mikro-orm.config';

export interface DbAdmin {
  truncate(): Promise<unknown>;
  /** stored wallet balance vs. the balance rebuilt from the ledger. */
  walletVsLedger(walletId: string): Promise<{ stored: string; rebuilt: string; equal: boolean }>;
  debitCount(walletId: string): Promise<number>;
  betRows(walletId: string): Promise<Array<{ id: string; status: string; failure_code: string | null }>>;
  close(): Promise<void>;
}

/**
 * A dedicated MikroORM connection owned by the *test* process — separate from
 * every spawned application instance — used only for fixture reset and for
 * reading back the final invariant straight from SQL.
 */
export async function openDbAdmin(): Promise<DbAdmin> {
  const orm = await MikroORM.init(ormConfig);
  const conn = orm.em.getConnection();

  return {
    truncate: () =>
      conn.execute(
        'TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages RESTART IDENTITY CASCADE',
      ),

    async walletVsLedger(walletId) {
      const wallet = await conn.execute<Array<{ balance_amount: string }>>(
        'SELECT balance_amount FROM wallets WHERE id = ?',
        [walletId],
      );
      const ledger = await conn.execute<Array<{ sum: string }>>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS sum
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [walletId],
      );
      const stored = new Decimal(wallet[0]?.balance_amount ?? '0');
      const rebuilt = new Decimal(ledger[0]?.sum ?? '0');
      return { stored: stored.toFixed(2), rebuilt: rebuilt.toFixed(2), equal: stored.equals(rebuilt) };
    },

    async debitCount(walletId) {
      const rows = await conn.execute<Array<{ n: number }>>(
        "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [walletId],
      );
      return rows[0]?.n ?? 0;
    },

    async betRows(walletId) {
      return conn.execute(
        "SELECT id, status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' ORDER BY created_at",
        [walletId],
      );
    },

    close: () => orm.close(true),
  };
}
