import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { OutboxMessageEntity } from './entities/outbox-message.entity';

const url = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';

export default defineConfig({
  clientUrl: url,
  entities: [
    WalletEntity,
    WalletLedgerEntryEntity,
    WagerTransactionEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: './src/infra/database/migrations',
    pathTs: './src/infra/database/migrations',
    transactional: true,
    disableForeignKeys: false,
    snapshot: false,
  },
  pool: {
    min: Number(process.env.DB_POOL_MIN ?? 2),
    max: Number(process.env.DB_POOL_MAX ?? 10),
  },
  // Domain never touches ORM identity map; we always map explicitly in repos.
  forceUtcTimezone: true,
  debug: process.env.MIKRO_ORM_DEBUG === 'true',
});
