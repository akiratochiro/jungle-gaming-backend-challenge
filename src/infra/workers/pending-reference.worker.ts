import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { uuidv7 } from 'uuidv7';
import { ResolvePendingReferenceUseCase } from '../../application/wager/resolve-pending-reference.use-case';
import { runWithCorrelation } from '../observability/correlation';

/**
 * Scheduled scan for REFUND/ROLLBACK transactions parked as PENDING_REFERENCE
 * (out-of-order delivery, rule 7.1). Picks the ones whose backoff window has
 * elapsed and re-runs resolution one at a time under the wallet lock. Safe to
 * run on multiple instances — each transaction is resolved inside its own
 * wallet-locked SQL transaction and a stale pick is a no-op.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;

  constructor(
    private readonly em: EntityManager,
    private readonly resolve: ResolvePendingReferenceUseCase,
  ) {}

  start(intervalMs = Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 5000)): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drainOnce();
      } catch (e) {
        this.logger.error({ msg: 'pending-reference tick failed', error: String(e) });
      }
      if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Processes one batch of due transactions. Returns how many were touched. */
  async drainOnce(batchSize = Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 20)): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await this.em.execute<Array<{ id: string; wallet_id: string }>>(
        `SELECT id, wallet_id FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY created_at ASC
         LIMIT ?`,
        [batchSize],
      );

      let touched = 0;
      for (const row of rows) {
        await runWithCorrelation(
          { correlationId: uuidv7(), transactionId: row.id, walletId: row.wallet_id },
          async () => {
            try {
              const res = await this.resolve.execute({
                transactionId: row.id,
                walletId: row.wallet_id,
              });
              if (res.outcome !== 'noop') touched += 1;
            } catch (e) {
              this.logger.error({
                msg: 'pending-reference resolve failed',
                error: e instanceof Error ? e.name : 'Error',
              });
            }
          },
        );
      }
      return touched;
    } finally {
      this.running = false;
    }
  }
}
