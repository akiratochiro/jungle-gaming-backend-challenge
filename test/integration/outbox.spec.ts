import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { ensureSchema, startTestApp, TestApp } from '../helpers/test-app';
import { bet, Client } from '../helpers/client';
import { OutboxRelay } from '../../src/infra/outbox/outbox-relay';
import { SqsClientProvider } from '../../src/infra/messaging/sqs-client.provider';

let app: TestApp;
let client: Client;
let relay: OutboxRelay;
let sqs: SqsClientProvider;
let em: EntityManager;

beforeAll(async () => {
  await ensureSchema();
  app = await startTestApp();
  client = new Client(app.baseUrl);
  relay = app.get<OutboxRelay>(OutboxRelay);
  sqs = app.get<SqsClientProvider>(SqsClientProvider);
  em = app.get<EntityManager>(EntityManager);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.truncate();
  await sqs.client.send(new PurgeQueueCommand({ QueueUrl: sqs.config.eventsQueueUrl })).catch(() => {});
});

describe('transactional outbox', () => {
  it('writes events in the same transaction and the relay publishes them exactly once', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    await client.submit(bet({ walletId, playerId, money: { amount: '25.00', currency: 'BRL' } }));

    // events are already durably in the outbox, still unpublished
    const pendingBefore = await em.getConnection().execute(
      'SELECT event_type FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at',
    );
    const types = pendingBefore.map((r: any) => r.event_type);
    expect(types).toContain('WagerTransactionProcessed');
    expect(types).toContain('WalletBalanceChanged');

    // relay runs (twice — second pass must publish nothing new)
    const first = await relay.drainOnce();
    const second = await relay.drainOnce();
    expect(first).toBeGreaterThanOrEqual(2);
    expect(second).toBe(0);

    const pendingAfter = await em.getConnection().execute(
      'SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(pendingAfter[0]?.n).toBe(0);

    // messages actually landed on the queue
    const received = await sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: sqs.config.eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    const bodies = (received.Messages ?? []).map((m) => JSON.parse(m.Body ?? '{}'));
    expect(bodies.some((b) => b.eventType === 'WagerTransactionProcessed')).toBe(true);
    for (const m of received.Messages ?? []) {
      await sqs.client.send(
        new DeleteMessageCommand({
          QueueUrl: sqs.config.eventsQueueUrl,
          ReceiptHandle: m.ReceiptHandle!,
        }),
      );
    }
  });

  it('a rejected bet still emits WagerTransactionRejected and no ledger entry', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '10.00')).body.id;
    await em.getConnection().execute('TRUNCATE outbox_messages'); // drop the opening events
    const res = await client.submit(bet({ walletId, playerId, money: { amount: '25.00', currency: 'BRL' } }));
    expect(res.body.status).toBe('REJECTED');

    const rows = await em.getConnection().execute(
      'SELECT event_type FROM outbox_messages ORDER BY occurred_at',
    );
    const types = rows.map((r: any) => r.event_type);
    expect(types).toContain('WagerTransactionRejected');
    expect(types).not.toContain('WalletBalanceChanged');

    const ledger = await em.getConnection().execute('SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
    expect(ledger[0]?.n).toBe(1); // only the opening credit
  });
});
