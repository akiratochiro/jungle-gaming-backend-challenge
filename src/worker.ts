import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { OutboxRelay } from './infra/outbox/outbox-relay';
import { PendingReferenceWorker } from './infra/workers/pending-reference.worker';
import { SqsWagerConsumer } from './infra/messaging/sqs-wager-consumer';

/**
 * Headless worker process — the SQS consumer, the outbox relay and the
 * pending-reference worker without the HTTP server. Run as many replicas as you
 * like: the wallet lock, `FOR UPDATE SKIP LOCKED` and the inbox make them safe.
 *
 *   bun run worker
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  const log = new Logger('worker');

  if (process.env.OUTBOX_RELAY_ENABLED !== 'false') {
    app.get(OutboxRelay).start();
    log.log('outbox relay started');
  }
  if (process.env.PENDING_REFERENCE_WORKER_ENABLED !== 'false') {
    app.get(PendingReferenceWorker).start();
    log.log('pending-reference worker started');
  }
  if (process.env.SQS_CONSUMER_ENABLED !== 'false') {
    app.get(SqsWagerConsumer).start();
    log.log('sqs consumer started');
  }

  log.log('worker ready');
}

void bootstrap();
