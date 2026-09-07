import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessageEntity } from '../database/entities/outbox-message.entity';
import { SqsClientProvider } from '../messaging/sqs-client.provider';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/**
 * Polls the outbox and publishes pending events to SQS. Safe with multiple
 * concurrent relays: each batch is claimed with `FOR UPDATE SKIP LOCKED`, so two
 * publishers never grab the same row. A row is marked published only *after* the
 * send succeeds — a crash between commit and publish just leaves the row pending
 * for another relay to pick up. Duplicate publishes are made safe downstream by
 * the FIFO MessageDeduplicationId (the event id).
 */
@Injectable()
export class OutboxRelay implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsClientProvider,
  ) {}

  start(intervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000)): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drainOnce();
      } catch (e) {
        this.logger.error({ msg: 'outbox relay tick failed', error: String(e) });
      }
      if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Publishes one batch. Returns the number of events published. */
  async drainOnce(batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 20)): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.em.transactional(async (em) => {
        const rows = await em.execute<Array<Record<string, unknown>>>(
          `SELECT * FROM outbox_messages
             WHERE published_at IS NULL
               AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             ORDER BY occurred_at ASC
             LIMIT ? FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );

        let published = 0;
        for (const row of rows) {
          const id = row.id as string;
          const payload = row.payload as Record<string, unknown>;
          const eventId = (payload.eventId as string) ?? id;
          try {
            await this.sqs.sendFifo({
              queueUrl: this.sqs.config.eventsQueueUrl,
              body: JSON.stringify(payload),
              groupId: row.aggregate_id as string,
              dedupId: eventId,
            });
            await em.execute('UPDATE outbox_messages SET published_at = now() WHERE id = ?', [id]);
            published += 1;
          } catch (e) {
            const attempts = Number(row.attempts ?? 0) + 1;
            const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
            await em.execute(
              `UPDATE outbox_messages
                 SET attempts = ?, next_attempt_at = now() + (? || ' milliseconds')::interval
                 WHERE id = ?`,
              [attempts, delay, id],
            );
            this.logger.warn({ msg: 'outbox publish failed', id, attempts, error: String(e) });
          }
        }
        return published;
      });
    } finally {
      this.running = false;
    }
  }
}
