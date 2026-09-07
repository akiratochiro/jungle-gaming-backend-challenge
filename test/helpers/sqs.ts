import { uuidv7 } from 'uuidv7';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { SqsClientProvider } from '../../src/infra/messaging/sqs-client.provider';

export function wagerMessage(over: Record<string, unknown> = {}) {
  const messageId = (over.messageId as string) ?? `msg-${uuidv7()}`;
  const data = {
    providerId: 'provider-a',
    externalTransactionId: uuidv7(),
    playerId: uuidv7(),
    walletId: uuidv7(),
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...(over.data as Record<string, unknown>),
  };
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
  };
}

export async function enqueue(sqs: SqsClientProvider, message: Record<string, unknown>, dedupId?: string) {
  const groupId = (message.data as { walletId?: string })?.walletId ?? 'g';
  await sqs.sendFifo({
    queueUrl: sqs.config.requestQueueUrl,
    body: JSON.stringify(message),
    groupId,
    dedupId: dedupId ?? uuidv7(),
  });
}

export async function drainQueue(sqs: SqsClientProvider, queueUrl: string) {
  const out: Array<{ body: any; attributes: Record<string, string> }> = [];
  for (let i = 0; i < 10; i++) {
    const res = await sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    if (!res.Messages?.length) break;
    for (const m of res.Messages) {
      out.push({
        body: JSON.parse(m.Body ?? '{}'),
        attributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
        ),
      });
      await sqs.client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }),
      );
    }
  }
  return out;
}

export async function purge(sqs: SqsClientProvider) {
  for (const q of [sqs.config.requestQueueUrl, sqs.config.dlqUrl]) {
    await sqs.client.send(new PurgeQueueCommand({ QueueUrl: q })).catch(() => {});
  }
  // purge is async on the broker — also do a best-effort receive-drain
  await drainQueue(sqs, sqs.config.requestQueueUrl).catch(() => {});
  await drainQueue(sqs, sqs.config.dlqUrl).catch(() => {});
}
