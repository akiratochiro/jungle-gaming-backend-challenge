export interface MessagingConfig {
  region: string;
  endpoint?: string;
  requestQueueUrl: string;
  dlqUrl: string;
  eventsQueueUrl: string;
  consumerName: string;
  /** SQS long-poll wait (seconds). */
  waitTimeSeconds: number;
  /** Visibility timeout applied while a message is being processed (seconds). */
  visibilityTimeoutSeconds: number;
  /** Max deliveries of a transient failure before it is moved to the DLQ. */
  maxReceiveCount: number;
  /** Base for the exponential re-visibility backoff on transient errors (seconds). */
  retryBackoffBaseSeconds: number;
  /** How many messages to pull per poll. */
  batchSize: number;
}

const DEFAULT_ENDPOINT = 'http://localhost:4566/000000000000';

export function loadMessagingConfig(env: NodeJS.ProcessEnv = process.env): MessagingConfig {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.SQS_ENDPOINT,
    requestQueueUrl: env.SQS_QUEUE_URL ?? `${DEFAULT_ENDPOINT}/wager-transactions.fifo`,
    dlqUrl: env.SQS_DLQ_URL ?? `${DEFAULT_ENDPOINT}/wager-transactions-dlq.fifo`,
    eventsQueueUrl: env.SQS_EVENTS_QUEUE_URL ?? `${DEFAULT_ENDPOINT}/wager-events.fifo`,
    consumerName: env.CONSUMER_NAME ?? 'wager-consumer',
    waitTimeSeconds: Number(env.SQS_WAIT_TIME_SECONDS ?? 20),
    visibilityTimeoutSeconds: Number(env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30),
    maxReceiveCount: Number(env.SQS_MAX_RECEIVE_COUNT ?? 5),
    retryBackoffBaseSeconds: Number(env.SQS_RETRY_BACKOFF_BASE_SECONDS ?? 2),
    batchSize: Number(env.SQS_CONSUMER_BATCH_SIZE ?? 10),
  };
}
