import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { InvalidValueError } from '../../domain/shared/domain-error';
import { MoneyCurrencyMismatchError } from '../../domain/shared/money';
import { IdempotencyConflictError } from '../../domain/wager/errors';
import { ValidationError, WalletNotFoundError } from '../../application/wager/errors';
import { SubmitWagerTransactionUseCase } from '../../application/wager/submit-wager-transaction.use-case';
import { Metrics } from '../observability/metrics';
import { runWithCorrelation } from '../observability/correlation';
import { SqsClientProvider } from './sqs-client.provider';
import { MalformedMessageError, parseWagerMessage } from './wager-message';

const DLQ_BACKOFF_CAP_SECONDS = 900;

type ErrorClass = 'permanent' | 'transient';
type DlqReason = 'malformed' | 'permanent' | 'exhausted';

/**
 * Long-polls `wager-transactions.fifo`, feeds each message through the **same**
 * `SubmitWagerTransactionUseCase` the HTTP path uses, and only deletes (acks) a
 * message *after* its SQL transaction has committed.
 *
 * Error handling (challenge §10):
 *  - **business** rejection → the use case returns normally (REJECTED persisted) → ack.
 *  - **permanent** (malformed body, bad money, unknown wallet, idempotency
 *    conflict) → moved straight to the DLQ.
 *  - **transient** (deadlock, lost connection, unknown error) → not deleted; the
 *    visibility timeout is extended with exponential backoff. After
 *    `maxReceiveCount` deliveries it is moved to the DLQ.
 *
 * DLQ metadata carries only a `failureClass` + exception name — never the
 * exception message (it could echo an invalid amount from the payload). The
 * original message body is on the DLQ for full detail.
 */
@Injectable()
export class SqsWagerConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private stopped = false;
  private loop?: Promise<void>;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly sqs: SqsClientProvider,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.loop?.catch(() => undefined);
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((r) => setTimeout(r, this.sqs.config.visibilityTimeoutSeconds * 1000)),
    ]);
  }

  private async run(): Promise<void> {
    const cfg = this.sqs.config;
    while (!this.stopped) {
      let messages: Message[];
      try {
        messages = await this.sqs.receive(
          cfg.requestQueueUrl,
          cfg.batchSize,
          cfg.waitTimeSeconds,
          cfg.visibilityTimeoutSeconds,
        );
      } catch (e) {
        this.logger.error({ msg: 'sqs receive failed', error: errName(e) });
        await sleep(1000);
        continue;
      }
      if (messages.length === 0) continue;

      const batch = messages.map((m) => {
        const p = this.handle(m).catch((e) =>
          this.logger.error({ msg: 'message handler crashed', error: errName(e) }),
        );
        this.inFlight.add(p);
        void p.finally(() => this.inFlight.delete(p));
        return p;
      });
      await Promise.allSettled(batch);
    }
  }

  /** Exposed for tests — process whatever is currently on the queue, once. */
  async drainOnce(): Promise<number> {
    const cfg = this.sqs.config;
    const messages = await this.sqs.receive(
      cfg.requestQueueUrl,
      cfg.batchSize,
      1,
      cfg.visibilityTimeoutSeconds,
    );
    await Promise.allSettled(messages.map((m) => this.handle(m)));
    return messages.length;
  }

  private async handle(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (!receipt) return;
    const body = message.Body ?? '';

    let parsed;
    try {
      parsed = parseWagerMessage(body);
    } catch (e) {
      if (e instanceof MalformedMessageError) {
        await this.toDlq(message, 'malformed', 'MalformedMessageError');
        return;
      }
      throw e;
    }

    await runWithCorrelation(
      {
        correlationId: `sqs:${parsed.messageId}`,
        messageId: parsed.messageId,
        providerId: parsed.data.providerId,
        walletId: parsed.data.walletId,
      },
      () => this.process(message, receipt, parsed),
    );
  }

  private async process(
    message: Message,
    receipt: string,
    parsed: ReturnType<typeof parseWagerMessage>,
  ): Promise<void> {
    const cfg = this.sqs.config;
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    try {
      const result = await this.submit.execute({
        idempotencyKey: parsed.data.idempotencyKey,
        correlationId: `sqs:${parsed.messageId}`,
        payload: parsed.data,
        inbox: { consumerName: cfg.consumerName, messageId: parsed.messageId },
      });
      await this.sqs.deleteMessage(cfg.requestQueueUrl, receipt); // ack after commit
      this.logger.log({
        msg: 'sqs message processed',
        transactionId: result.transactionId,
        status: result.status,
        replay: result.idempotentReplay,
      });
    } catch (e) {
      if (classify(e) === 'permanent') {
        await this.toDlq(message, 'permanent', errName(e));
        return;
      }
      if (receiveCount >= cfg.maxReceiveCount) {
        await this.toDlq(message, 'exhausted', errName(e));
        return;
      }
      const backoff = Math.min(
        cfg.retryBackoffBaseSeconds * 2 ** (receiveCount - 1),
        DLQ_BACKOFF_CAP_SECONDS,
      );
      await this.sqs.changeVisibility(cfg.requestQueueUrl, receipt, backoff);
      this.metrics.sqsRetries.inc();
      this.logger.warn({
        msg: 'sqs transient failure, will retry',
        receiveCount,
        backoffSeconds: backoff,
        error: errName(e),
      });
    }
  }

  private async toDlq(message: Message, reason: DlqReason, errorName: string): Promise<void> {
    const body = message.Body ?? '';
    let groupId = message.MessageId ?? 'unknown';
    let messageId = groupId;
    try {
      const p = JSON.parse(body) as { messageId?: string; data?: { walletId?: string } };
      if (p.messageId) messageId = p.messageId;
      if (p.data?.walletId) groupId = p.data.walletId;
    } catch {
      /* keep fallbacks */
    }

    await this.sqs.sendFifo({
      queueUrl: this.sqs.config.dlqUrl,
      body,
      groupId,
      dedupId: `${messageId}:${Date.now()}`,
      attributes: {
        failureClass: reason,
        errorName,
        failedAt: new Date().toISOString(),
        sourceQueue: this.sqs.config.requestQueueUrl,
      },
    });
    if (message.ReceiptHandle) {
      await this.sqs.deleteMessage(this.sqs.config.requestQueueUrl, message.ReceiptHandle);
    }
    this.metrics.sqsDlq.inc({ reason });
    this.logger.warn({ msg: 'sqs message moved to DLQ', messageId, failureClass: reason, errorName });
  }
}

function classify(e: unknown): ErrorClass {
  if (
    e instanceof ValidationError ||
    e instanceof InvalidValueError ||
    e instanceof WalletNotFoundError ||
    e instanceof IdempotencyConflictError ||
    e instanceof MoneyCurrencyMismatchError
  ) {
    return 'permanent';
  }
  // Everything else (deadlocks, dropped connections, unexpected bugs) is retried
  // and capped by maxReceiveCount before hitting the DLQ.
  return 'transient';
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'Error';
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
