import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './http/domain-exception.filter';
import { OutboxRelay } from './infra/outbox/outbox-relay';
import { PendingReferenceWorker } from './infra/workers/pending-reference.worker';
import { SqsWagerConsumer } from './infra/messaging/sqs-wager-consumer';
import { JsonLogger } from './infra/observability/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  // Background workers run in-process by default; each is also safe standalone
  // and safe to run on multiple instances. `WORKERS_ENABLED=false` turns off all
  // three at once (HTTP-only mode); the per-worker flags override individually.
  const workersEnabled = process.env.WORKERS_ENABLED !== 'false';
  if (workersEnabled && process.env.OUTBOX_RELAY_ENABLED !== 'false') {
    app.get(OutboxRelay).start();
  }
  if (workersEnabled && process.env.PENDING_REFERENCE_WORKER_ENABLED !== 'false') {
    app.get(PendingReferenceWorker).start();
  }
  if (workersEnabled && process.env.SQS_CONSUMER_ENABLED !== 'false') {
    app.get(SqsWagerConsumer).start();
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('bootstrap').log(`HTTP listening on :${port}`);
}

void bootstrap();
