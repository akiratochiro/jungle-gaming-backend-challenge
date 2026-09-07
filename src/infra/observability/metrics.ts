import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from './prometheus';

/** A wallet-lock acquisition slower than this counts as contended. */
export const LOCK_CONTENTION_THRESHOLD_SECONDS = 0.02;

/**
 * The fixed metric set for the wagering processor (challenge §12).
 * Exposed at `GET /metrics` in Prometheus text format.
 */
@Injectable()
export class Metrics {
  private readonly registry = new Registry();

  /** Transactions by terminal status and kind. */
  readonly wagerTransactions: Counter = this.registry.counter(
    'wager_transactions_total',
    'Wager transactions by terminal status and kind',
    ['status', 'kind'],
  );

  /** Idempotent replays served (duplicates detected). */
  readonly idempotencyReplays: Counter = this.registry.counter(
    'wager_idempotency_replays_total',
    'Idempotent replays served because a duplicate request/message was detected',
  );

  /** SQS messages returned for retry after a transient failure. */
  readonly sqsRetries: Counter = this.registry.counter(
    'sqs_message_retries_total',
    'SQS messages whose visibility was extended for a transient-failure retry',
  );

  /** SQS messages moved to the DLQ, by reason. */
  readonly sqsDlq: Counter = this.registry.counter(
    'sqs_messages_dlq_total',
    'SQS messages moved to the dead-letter queue',
    ['reason'],
  );

  /** Pending-reference resolution attempts by outcome. */
  readonly pendingReferenceRetries: Counter = this.registry.counter(
    'pending_reference_retries_total',
    'Pending-reference worker resolution attempts by outcome',
    ['outcome'],
  );

  /** Wallet locks that had to wait for another holder (lock contention). */
  readonly walletLockContended: Counter = this.registry.counter(
    'wallet_lock_contended_total',
    'Pessimistic wallet-row locks that had to wait for another transaction',
  );

  /** Time spent acquiring the pessimistic wallet lock. */
  readonly walletLockWait: Histogram = this.registry.histogram(
    'wallet_lock_wait_seconds',
    'Time spent acquiring the pessimistic wallet-row lock',
    [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
  );

  /** Delay between an event's occurredAt and its publishedAt (outbox lag). */
  readonly outboxLag: Histogram = this.registry.histogram(
    'outbox_lag_seconds',
    'Delay between integration-event occurredAt and publishedAt',
    [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
  );

  /** End-to-end wager processing latency. */
  readonly processing: Histogram = this.registry.histogram(
    'wager_processing_seconds',
    'End-to-end wager processing latency in the shared use case',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    ['source', 'outcome'],
  );

  /** Unpublished outbox rows (evaluated at scrape time). */
  readonly outboxPending: Gauge = this.registry.gauge(
    'outbox_pending_messages',
    'Integration events written to the outbox but not yet published',
  );

  /** Reconciliation checks by result. */
  readonly reconciliationChecks: Counter = this.registry.counter(
    'wallet_reconciliation_checks_total',
    'Wallet reconciliation checks by result',
    ['result'],
  );

  /** Reconciliation checks that found stored balance ≠ ledger-rebuilt balance. */
  readonly reconciliationDivergences: Counter = this.registry.counter(
    'wallet_reconciliation_divergences_total',
    'Wallet reconciliation checks where the stored balance did not match the ledger',
  );

  render(): Promise<string> {
    return this.registry.render();
  }

  /** Test-only. */
  reset(): void {
    this.registry.reset();
  }
}
