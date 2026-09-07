/**
 * Migration runner (Bun-friendly, no CLI transpile step).
 *   bun run scripts/db.ts up        apply all pending migrations
 *   bun run scripts/db.ts down      revert the last migration
 *   bun run scripts/db.ts fresh     drop everything and re-apply
 *   bun run scripts/db.ts pending   list pending migrations
 */
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/database/mikro-orm.config';

const cmd = process.argv[2] ?? 'up';

const orm = await MikroORM.init(config);
const migrator = orm.getMigrator();

try {
  switch (cmd) {
    case 'up':
      await migrator.up();
      console.log('migrations applied');
      break;
    case 'down':
      await migrator.down();
      console.log('last migration reverted');
      break;
    case 'fresh': {
      const gen = orm.getSchemaGenerator();
      await gen.dropSchema({ dropMigrationsTable: true });
      await migrator.up();
      console.log('schema dropped and migrations re-applied');
      break;
    }
    case 'pending': {
      const pending = await migrator.getPendingMigrations();
      console.log(pending.length ? pending.map((m) => m.name).join('\n') : 'none');
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
