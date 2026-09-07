import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import { EntityManager } from '@mikro-orm/postgresql';
import { ensureSchema, startTestApp, TestApp } from '../helpers/test-app';
import { Client } from '../helpers/client';
import { SqsClientProvider } from '../../src/infra/messaging/sqs-client.provider';
import { SqsWagerConsumer } from '../../src/infra/messaging/sqs-wager-consumer';
import { SubmitWagerTransactionUseCase } from '../../src/application/wager/submit-wager-transaction.use-case';
import { drainQueue, enqueue, purge, wagerMessage } from '../helpers/sqs';

let app: TestApp;
let client: Client;
let sqs: SqsClientProvider;
let consumer: SqsWagerConsumer;
let submit: SubmitWagerTransactionUseCase;
let em: EntityManager;

beforeAll(async () => {
  await ensureSchema();
  app = await startTestApp();
  client = new Client(app.baseUrl);
  sqs = app.get<SqsClientProvider>(SqsClientProvider);
  consumer = app.get<SqsWagerConsumer>(SqsWagerConsumer);
  submit = app.get<SubmitWagerTransactionUseCase>(SubmitWagerTransactionUseCase);
  em = app.get<EntityManager>(EntityManager);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.truncate();
  await purge(sqs);
});

async function walletWith(amount: string) {
  const playerId = uuidv7();
  const walletId = (await client.createWallet(playerId, amount)).body.id as string;
  return { playerId, walletId };
}

describe('SQS consumer', () => {
  it('processes a BET message through the shared use case and acks after commit', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const msg = wagerMessage({ data: { walletId, playerId, money: { amount: '30.00', currency: 'BRL' } } });
    await enqueue(sqs, msg);

    expect(await consumer.drainOnce()).toBe(1);

    const wallet = await client.wallet(walletId);
    expect(wallet.body.balance.amount).toBe('70.00');

    // message acked (source queue empty), nothing on the DLQ
    expect(await drainQueue(sqs, sqs.config.requestQueueUrl)).toHaveLength(0);
    expect(await drainQueue(sqs, sqs.config.dlqUrl)).toHaveLength(0);

    const inbox = await em.getConnection().execute(
      'SELECT * FROM inbox_messages WHERE message_id = ?',
      [msg.messageId],
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.processed_at).not.toBeNull();
  });

  it('redelivery of the same messageId does not double-apply', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const msg = wagerMessage({ data: { walletId, playerId, money: { amount: '30.00', currency: 'BRL' } } });

    await enqueue(sqs, msg, 'dedup-a');
    expect(await consumer.drainOnce()).toBe(1);
    // same business message delivered again (new SQS dedup id)
    await enqueue(sqs, msg, 'dedup-b');
    expect(await consumer.drainOnce()).toBe(1);

    const wallet = await client.wallet(walletId);
    expect(wallet.body.balance.amount).toBe('70.00');

    const debits = await em.getConnection().execute(
      "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    );
    expect(debits[0]?.n).toBe(1);
  });

  it('crash after commit, before ack: redelivery replays and does not double-apply', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const msg = wagerMessage({
      data: { walletId, playerId, money: { amount: '40.00', currency: 'BRL' } },
    });

    // Simulate: the use case committed (wallet + ledger + inbox row) but the
    // process died before deleting the SQS message.
    const first = await submit.execute({
      idempotencyKey: msg.data.idempotencyKey,
      correlationId: 'crash-test',
      payload: msg.data as never,
      inbox: { consumerName: sqs.config.consumerName, messageId: msg.messageId },
    });
    expect(String(first.status)).toBe('PROCESSED');

    // The message is still on the queue and gets redelivered.
    await enqueue(sqs, msg);
    expect(await consumer.drainOnce()).toBe(1);

    const wallet = await client.wallet(walletId);
    expect(wallet.body.balance.amount).toBe('60.00'); // applied exactly once

    const debits = await em.getConnection().execute(
      "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    );
    expect(debits[0]?.n).toBe(1);
    // redelivery was acked, nothing on the DLQ
    expect(await drainQueue(sqs, sqs.config.requestQueueUrl)).toHaveLength(0);
    expect(await drainQueue(sqs, sqs.config.dlqUrl)).toHaveLength(0);
  });

  it('a business rejection is acked, not sent to the DLQ', async () => {
    const { walletId, playerId } = await walletWith('10.00');
    await enqueue(
      sqs,
      wagerMessage({ data: { walletId, playerId, money: { amount: '25.00', currency: 'BRL' } } }),
    );

    await consumer.drainOnce();

    expect(await drainQueue(sqs, sqs.config.dlqUrl)).toHaveLength(0);
    const txs = await em.getConnection().execute(
      "SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'",
      [walletId],
    );
    expect(txs[0]?.status).toBe('REJECTED');
    expect(txs[0]?.failure_code).toBe('INSUFFICIENT_FUNDS');
  });

  it('a malformed body goes straight to the DLQ with a reason', async () => {
    await sqs.sendFifo({
      queueUrl: sqs.config.requestQueueUrl,
      body: JSON.stringify({ type: 'Nonsense', foo: 1 }),
      groupId: 'g',
      dedupId: uuidv7(),
    });

    await consumer.drainOnce();

    const dlq = await drainQueue(sqs, sqs.config.dlqUrl);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.attributes.failureClass).toBe('malformed');
    expect(dlq[0]?.attributes.errorName).toBe('MalformedMessageError');
    expect(dlq[0]?.attributes.sourceQueue).toBe(sqs.config.requestQueueUrl);
  });

  it('an unknown wallet is a permanent failure -> DLQ', async () => {
    await enqueue(
      sqs,
      wagerMessage({ data: { walletId: uuidv7(), playerId: uuidv7() } }),
    );

    await consumer.drainOnce();

    const dlq = await drainQueue(sqs, sqs.config.dlqUrl);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.attributes.failureClass).toBe('permanent');
    expect(dlq[0]?.attributes.errorName).toBe('WalletNotFoundError');
    expect(await drainQueue(sqs, sqs.config.requestQueueUrl)).toHaveLength(0);
  });

  it('OPENING submitted via the queue is rejected as permanent', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    await enqueue(sqs, wagerMessage({ data: { walletId, playerId, kind: 'OPENING' } }));

    await consumer.drainOnce();

    const dlq = await drainQueue(sqs, sqs.config.dlqUrl);
    expect(dlq).toHaveLength(1);
  });
});
