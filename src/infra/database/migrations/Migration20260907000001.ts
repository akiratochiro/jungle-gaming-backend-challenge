import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. The domain invariants (uniqueness, immutability,
 * non-negativity, ledger arithmetic) are enforced here in the database, not
 * only in application code.
 */
export class Migration20260907000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(/* sql */ `
      CREATE TABLE "wallets" (
        "id" uuid NOT NULL,
        "player_id" uuid NOT NULL,
        "currency" varchar(3) NOT NULL,
        "balance_amount" numeric(20,2) NOT NULL,
        "version" int NOT NULL,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        CONSTRAINT "wallets_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "wallets_balance_non_negative" CHECK ("balance_amount" >= 0),
        CONSTRAINT "wallets_version_positive" CHECK ("version" >= 1)
      );
    `);
    this.addSql(/* sql */ `
      CREATE UNIQUE INDEX "wallets_player_currency_uniq"
        ON "wallets" ("player_id", "currency");
    `);

    this.addSql(/* sql */ `
      CREATE TABLE "wager_transactions" (
        "id" uuid NOT NULL,
        "provider_id" varchar(128) NOT NULL,
        "external_transaction_id" varchar(128) NOT NULL,
        "idempotency_key" varchar(320) NOT NULL,
        "payload_hash" varchar(64) NOT NULL,
        "wallet_id" uuid NOT NULL,
        "player_id" uuid NOT NULL,
        "round_id" varchar(128) NOT NULL,
        "game_id" varchar(128) NOT NULL,
        "kind" varchar(12) NOT NULL,
        "amount" numeric(20,2) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "reference_external_transaction_id" varchar(128) NULL,
        "status" varchar(20) NOT NULL,
        "reference_transaction_id" uuid NULL,
        "failure_code" varchar(48) NULL,
        "reference_attempts" int NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NULL,
        "processed_at" timestamptz NULL,
        "result_balance_amount" numeric(20,2) NULL,
        "balance_changed" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        CONSTRAINT "wager_transactions_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "wager_transactions_wallet_fk"
          FOREIGN KEY ("wallet_id") REFERENCES "wallets" ("id"),
        CONSTRAINT "wager_transactions_reference_fk"
          FOREIGN KEY ("reference_transaction_id") REFERENCES "wager_transactions" ("id"),
        CONSTRAINT "wager_transactions_amount_non_negative" CHECK ("amount" >= 0),
        CONSTRAINT "wager_transactions_kind_valid"
          CHECK ("kind" IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT "wager_transactions_status_valid"
          CHECK ("status" IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT "wager_transactions_reference_required"
          CHECK ("kind" NOT IN ('REFUND','ROLLBACK')
                 OR "reference_external_transaction_id" IS NOT NULL)
      );
    `);
    this.addSql(/* sql */ `
      CREATE UNIQUE INDEX "wager_transactions_idempotency_key_uniq"
        ON "wager_transactions" ("idempotency_key");
    `);
    this.addSql(/* sql */ `
      CREATE UNIQUE INDEX "wager_transactions_provider_external_uniq"
        ON "wager_transactions" ("provider_id", "external_transaction_id");
    `);
    // A reference may be reversed at most once per operation kind.
    this.addSql(/* sql */ `
      CREATE UNIQUE INDEX "wager_transactions_reversal_once_uniq"
        ON "wager_transactions" ("reference_transaction_id", "kind")
        WHERE "reference_transaction_id" IS NOT NULL
          AND "status" = 'PROCESSED'
          AND "kind" IN ('REFUND','ROLLBACK');
    `);
    this.addSql(/* sql */ `
      CREATE INDEX "wager_transactions_pending_reference_scan"
        ON "wager_transactions" ("status", "next_attempt_at")
        WHERE "status" = 'PENDING_REFERENCE';
    `);

    this.addSql(/* sql */ `
      CREATE TABLE "wallet_ledger_entries" (
        "id" uuid NOT NULL,
        "wallet_id" uuid NOT NULL,
        "transaction_id" uuid NOT NULL,
        "direction" varchar(6) NOT NULL,
        "amount" numeric(20,2) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "balance_before" numeric(20,2) NOT NULL,
        "balance_after" numeric(20,2) NOT NULL,
        "created_at" timestamptz NOT NULL,
        CONSTRAINT "wallet_ledger_entries_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "wallet_ledger_entries_wallet_fk"
          FOREIGN KEY ("wallet_id") REFERENCES "wallets" ("id"),
        CONSTRAINT "wallet_ledger_entries_transaction_fk"
          FOREIGN KEY ("transaction_id") REFERENCES "wager_transactions" ("id"),
        CONSTRAINT "wallet_ledger_entries_direction_valid"
          CHECK ("direction" IN ('DEBIT','CREDIT')),
        CONSTRAINT "wallet_ledger_entries_amount_non_negative" CHECK ("amount" >= 0),
        CONSTRAINT "wallet_ledger_entries_balance_after_non_negative"
          CHECK ("balance_after" >= 0),
        CONSTRAINT "wallet_ledger_entries_arithmetic"
          CHECK (
            ("direction" = 'CREDIT' AND "balance_before" + "amount" = "balance_after")
            OR
            ("direction" = 'DEBIT' AND "balance_before" - "amount" = "balance_after")
          )
      );
    `);
    // At most one ledger entry per wallet per transaction.
    this.addSql(/* sql */ `
      CREATE UNIQUE INDEX "wallet_ledger_entries_wallet_tx_uniq"
        ON "wallet_ledger_entries" ("wallet_id", "transaction_id");
    `);
    this.addSql(/* sql */ `
      CREATE INDEX "wallet_ledger_entries_pagination"
        ON "wallet_ledger_entries" ("wallet_id", "created_at", "id");
    `);
    // Ledger entries are append-only: block UPDATE and DELETE at the schema level.
    this.addSql(/* sql */ `
      CREATE OR REPLACE FUNCTION "wallet_ledger_entries_reject_mutation"()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(/* sql */ `
      CREATE TRIGGER "wallet_ledger_entries_no_update_delete"
        BEFORE UPDATE OR DELETE ON "wallet_ledger_entries"
        FOR EACH ROW EXECUTE FUNCTION "wallet_ledger_entries_reject_mutation"();
    `);

    this.addSql(/* sql */ `
      CREATE TABLE "inbox_messages" (
        "consumer_name" varchar(64) NOT NULL,
        "message_id" varchar(128) NOT NULL,
        "payload_hash" varchar(64) NOT NULL,
        "received_at" timestamptz NOT NULL,
        "processed_at" timestamptz NULL,
        CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("consumer_name", "message_id")
      );
    `);

    this.addSql(/* sql */ `
      CREATE TABLE "outbox_messages" (
        "id" uuid NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "event_type" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "attempts" int NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NULL,
        "published_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL,
        CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
      );
    `);
    this.addSql(/* sql */ `
      CREATE INDEX "outbox_messages_relay_scan"
        ON "outbox_messages" ("published_at", "next_attempt_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS "outbox_messages";');
    this.addSql('DROP TABLE IF EXISTS "inbox_messages";');
    this.addSql(
      'DROP TRIGGER IF EXISTS "wallet_ledger_entries_no_update_delete" ON "wallet_ledger_entries";',
    );
    this.addSql('DROP FUNCTION IF EXISTS "wallet_ledger_entries_reject_mutation"();');
    this.addSql('DROP TABLE IF EXISTS "wallet_ledger_entries";');
    this.addSql('DROP TABLE IF EXISTS "wager_transactions";');
    this.addSql('DROP TABLE IF EXISTS "wallets";');
  }
}
