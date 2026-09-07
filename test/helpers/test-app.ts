import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/http/domain-exception.filter';
import ormConfig from '../../src/infra/database/mikro-orm.config';

export interface TestApp {
  baseUrl: string;
  close: () => Promise<void>;
  truncate: () => Promise<void>;
  get: <T>(token: unknown) => T;
}

export async function startTestApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0);
  const url = await app.getUrl();
  // getUrl() sometimes reports ::1 — normalise to IPv4 loopback.
  const baseUrl = url.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  const orm = app.get(MikroORM);

  return {
    baseUrl,
    get: <T>(token: unknown) => app.get(token as never) as T,
    close: () => app.close(),
    truncate: async () => {
      await orm
        .em.getConnection()
        .execute(
          'TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages RESTART IDENTITY CASCADE',
        );
    },
  };
}

export async function ensureSchema(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}
