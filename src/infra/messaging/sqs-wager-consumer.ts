import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { InvalidValueError } from '../../domain/shared/domain-error';
import { MoneyCurrencyMismatchError } from '../../domain/shared/money';
import { IdempotencyConflictError } from '../../domain/wager/errors';
import {
  ValidationError,
  WalletNotFoundError,
} from '../../application/wager/errors';
import { SubmitWagerTransactionUseCase } from '../../application/wager/submit-wager-transaction.use-case';
import { SqsClientProvider } from './sqs-client.provider';
import { MalformedMessageError, parseWagerMessage } from './wager-message';

const DLQ_BACKOFF_CAP_SECONDS = 900;

type ErrorClass = 'permanent' | 'transient';

/**
 * Long-polls `wager-transactions.fifo`, feeds each message through the **same**
 * `SubmitWagerTransactionUseCase` the HTTP path uses, and only deletes
 * (acks) a message *after* its SQL transaction has committed.
 *
 * Error handling (challenge §10):
 *  - **business** rejection → the use case returns normally (REJECTED persisted) → ack.
 *  - **permanent** (malformed body, bad money, unknown wallet, idempotency
 *    conflict) → moved straight to the DLQ with a `failureReason` attribute.
 *  - **transient** (deadlock, lost connection, unknown error) → not deleted; the
 *    visibility timeout is extended with exponential backoff. After
 *    `maxReceiveCount` deliveries it is moved to the DLQ.
 *
 * Redelivery is safe: the persistent inbox (`consumer_name`, `messageId`)
 * dedupes and the idempotency key replays the original outcome.
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
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.loop?.catch(() => undefined);
    // Give in-flight handlers a bounded chance to finish (and ack). Anything
    // still running is simply not deleted → SQS makes it visible again.
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
        this.logger.error({ msg: 'sqs receive failed', error: String(e) });
        await sleep(1000);
        continue;
      }

      if (messages.length === 0) continue;

      const batch = messages.map((m) => {
        const p = this.handle(m).catch((e) =>
          this.logger.error({ msg: 'message handler crashed', error: String(e) }),
        );
        this.inFlight.add(p);
        void p.finally(() => this.inFlight.delete(p));
        return p;
      });
      // FIFO: finish the batch before pulling more (respects per-group ordering).
      await Promise.allSettled(batch);
    }
  }

  /** Exposed for tests — process whatever is currently on the queue, once. */
  async drainOnce(): Promise<number> {
    const cfg = this.sqs.config;
    const messages = await this.sqs.receive(cfg.requestQueueUrl, cfg.batchSize, 1, cfg.visibilityTimeoutSeconds);
    await Promise.allSettled(messages.map((m) => this.handle(m)));
    return messages.length;
  }

  private async handle(message: Message): Promise<void> {
    const cfg = this.sqs.config;
    const receipt = message.ReceiptHandle;
    if (!receipt) return;
    const body = message.Body ?? '';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let parsed;
    try {
      parsed = parseWagerMessage(body);
    } catch (e) {
      if (e instanceof MalformedMessageError) {
        await this.toDlq(message, `malformed: ${e.message}`);
        return;
      }
      throw e;
    }

    try {
      const result = await this.submit.execute({
        idempotencyKey: parsed.data.idempotencyKey,
        correlationId: `sqs:${parsed.messageId}`,
        payload: parsed.data,
        inbox: { consumerName: cfg.consumerName, messageId: parsed.messageId },
      });
      // Commit happened → safe to ack.
      await this.sqs.deleteMessage(cfg.requestQueueUrl, receipt);
      this.logger.log({
        msg: 'message processed',
        messageId: parsed.messageId,
        transactionId: result.transactionId,
        status: result.status,
        replay: result.idempotentReplay,
      });
    } catch (e) {
      const klass = classify(e);
      if (klass === 'permanent') {
        await this.toDlq(message, `permanent ${errName(e)}: ${errMessage(e)}`);
        return;
      }
      if (receiveCount >= cfg.maxReceiveCount) {
        await this.toDlq(message, `transient, exhausted after ${receiveCount} deliveries: ${errMessage(e)}`);
        return;
      }
      const backoff = Math.min(
        cfg.retryBackoffBaseSeconds * 2 ** (receiveCount - 1),
        DLQ_BACKOFF_CAP_SECONDS,
      );
      await this.sqs.changeVisibility(cfg.requestQueueUrl, receipt, backoff);
      this.logger.warn({
        msg: 'transient failure, will retry',
        messageId: parsed.messageId,
        receiveCount,
        backoffSeconds: backoff,
        error: errMessage(e),
      });
    }
  }

  private async toDlq(message: Message, reason: string): Promise<void> {
    const body = message.Body ?? '';
    let groupId = message.MessageId ?? 'unknown';
    let messageId = groupId;
    try {
      const parsed = JSON.parse(body) as { messageId?: string; data?: { walletId?: string } };
      if (parsed.messageId) messageId = parsed.messageId;
      if (parsed.data?.walletId) groupId = parsed.data.walletId;
    } catch {
      /* keep fallbacks */
    }

    await this.sqs.sendFifo({
      queueUrl: this.sqs.config.dlqUrl,
      body,
      groupId,
      dedupId: `${messageId}:${Date.now()}`,
      attributes: {
        failureReason: reason.slice(0, 1024),
        failedAt: new Date().toISOString(),
        sourceQueue: this.sqs.config.requestQueueUrl,
      },
    });
    if (message.ReceiptHandle) {
      await this.sqs.deleteMessage(this.sqs.config.requestQueueUrl, message.ReceiptHandle);
    }
    this.logger.warn({ msg: 'moved to DLQ', messageId, reason });
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
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
