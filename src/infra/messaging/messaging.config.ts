export interface MessagingConfig {
  region: string;
  endpoint?: string;
  requestQueueUrl: string;
  dlqUrl: string;
  eventsQueueUrl: string;
  consumerName: string;
}

export function loadMessagingConfig(env: NodeJS.ProcessEnv = process.env): MessagingConfig {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.SQS_ENDPOINT,
    requestQueueUrl:
      env.SQS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo',
    dlqUrl: env.SQS_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    eventsQueueUrl:
      env.SQS_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo',
    consumerName: env.CONSUMER_NAME ?? 'wager-consumer',
  };
}
