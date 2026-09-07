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
import { Metrics } from '../../src/infra/observability/metrics';

let app: TestApp;
let client: Client;
let relay: OutboxRelay;
let sqs: SqsClientProvider;
let em: EntityManager;
let metrics: Metrics;

const pendingOutbox = async () => {
  const rows = await em
    .getConnection()
    .execute<Array<{ n: number }>>('SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL');
  return rows[0]?.n ?? 0;
};

beforeAll(async () => {
  await ensureSchema();
  app = await startTestApp();
  client = new Client(app.baseUrl);
  relay = app.get<OutboxRelay>(OutboxRelay);
  sqs = app.get<SqsClientProvider>(SqsClientProvider);
  em = app.get<EntityManager>(EntityManager);
  metrics = app.get<Metrics>(Metrics);
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

  it('two concurrent publishers share the outbox with no loss and no double-publish (§13.6)', async () => {
    const playerId = uuidv7();
    const walletId = (await client.createWallet(playerId, '10000.00')).body.id;
    for (let i = 0; i < 11; i++) {
      await client.submit(bet({ walletId, playerId, money: { amount: '1.00', currency: 'BRL' } }));
    }
    const total = await pendingOutbox();
    expect(total).toBeGreaterThanOrEqual(20); // opening (2) + 11 bets * 2

    // A second publisher on its own connection, running alongside the app's relay.
    const relayB = new OutboxRelay(em.fork(), sqs, metrics);

    let byA = 0;
    let byB = 0;
    for (let round = 0; round < 25; round++) {
      const [a, b] = await Promise.all([relay.drainOnce(3), relayB.drainOnce(3)]);
      byA += a;
      byB += b;
      if ((await pendingOutbox()) === 0) break;
    }

    // Every row published exactly once — the sum equals the total, never more.
    expect(byA + byB).toBe(total);
    // FOR UPDATE SKIP LOCKED actually split the work between the two publishers.
    expect(byA).toBeGreaterThan(0);
    expect(byB).toBeGreaterThan(0);
    expect(await pendingOutbox()).toBe(0);

    // No duplicate delivery: distinct eventIds on the queue == total.
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const res = await sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: sqs.config.eventsQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      if (!res.Messages?.length) break;
      for (const m of res.Messages) {
        seen.add(JSON.parse(m.Body ?? '{}').eventId);
        await sqs.client.send(
          new DeleteMessageCommand({
            QueueUrl: sqs.config.eventsQueueUrl,
            ReceiptHandle: m.ReceiptHandle!,
          }),
        );
      }
    }
    expect(seen.size).toBe(total);
  });
});
