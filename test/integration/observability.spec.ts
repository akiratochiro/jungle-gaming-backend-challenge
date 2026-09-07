import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import { captureLogs, ensureSchema, startTestApp, TestApp } from '../helpers/test-app';
import { Client } from '../helpers/client';
import { Metrics } from '../../src/infra/observability/metrics';
import { SqsClientProvider } from '../../src/infra/messaging/sqs-client.provider';
import { SqsWagerConsumer } from '../../src/infra/messaging/sqs-wager-consumer';
import { purge } from '../helpers/sqs';

let app: TestApp;
let client: Client;
let metrics: Metrics;
let sqs: SqsClientProvider;
let consumer: SqsWagerConsumer;
let logs: ReturnType<typeof captureLogs>;

beforeAll(async () => {
  await ensureSchema();
  logs = captureLogs(); // install sink before the app so its logs are captured, not printed
  app = await startTestApp({ jsonLogs: true });
  client = new Client(app.baseUrl);
  metrics = app.get<Metrics>(Metrics);
  sqs = app.get<SqsClientProvider>(SqsClientProvider);
  consumer = app.get<SqsWagerConsumer>(SqsWagerConsumer);
});

afterAll(async () => {
  logs.stop();
  await app.close();
});

beforeEach(async () => {
  await app.truncate();
  metrics.reset();
  logs.lines.length = 0;
});

const PLAYER = () => uuidv7();

function bet(walletId: string, playerId: string, amount: string, ext = uuidv7()) {
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

/** Value of `name{labels}` from Prometheus text, or undefined. */
function metricValue(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  const wanted = Object.entries(labels)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  const prefix = wanted ? `${name}{${wanted}}` : name;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    if (line.startsWith(prefix + ' ')) return Number(line.slice(prefix.length + 1));
  }
  return undefined;
}

describe('structured logging', () => {
  it('every log line carries the ambient correlation fields', async () => {
    const playerId = PLAYER();
    const walletId = (
      await fetch(`${app.baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'obs-corr-1' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      }).then((r) => r.json() as any)
    ).id;

    const res = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'provider-a:obs-1',
        'x-correlation-id': 'obs-corr-1',
      },
      body: JSON.stringify({ ...bet(walletId, playerId, '12.00', 'obs-1') }),
    });
    expect(res.headers.get('x-correlation-id')).toBe('obs-corr-1');

    const settled = logs
      .records()
      .find((r) => r.msg === 'wager transaction settled' && r.correlationId === 'obs-corr-1');
    expect(settled).toBeDefined();
    expect(settled!.walletId).toBe(walletId);
    expect(typeof settled!.transactionId).toBe('string');
    expect(settled!.providerId).toBe('provider-a');
    expect(settled!.status).toBe('PROCESSED');
  });

  it('mints a correlationId when the request has none', async () => {
    const res = await fetch(`${app.baseUrl}/health/live`);
    const cid = res.headers.get('x-correlation-id');
    expect(cid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never writes a Money amount or the raw payload into a log line', async () => {
    const playerId = PLAYER();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    const amount = '61.73'; // distinctive
    await client.submit(bet(walletId, playerId, amount), 'provider-a:leak-check');

    const blob = logs.lines.join('\n');
    expect(blob).not.toContain(amount);
    expect(blob).not.toContain('"initialBalance"');
    expect(blob).not.toContain('"gameId"'); // raw payload marker
  });
});

describe('metrics', () => {
  it('counts transactions by status/kind and records processing latency', async () => {
    const playerId = PLAYER();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    await client.submit(bet(walletId, playerId, '30.00'));

    const text = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metricValue(text, 'wager_transactions_total', { kind: 'BET', status: 'PROCESSED' })).toBe(1);
    expect(metricValue(text, 'wager_transactions_total', { kind: 'OPENING', status: 'PROCESSED' })).toBe(1);
    expect(
      metricValue(text, 'wager_processing_seconds_count', { outcome: 'processed', source: 'http' }),
    ).toBeGreaterThanOrEqual(1);
    expect(metricValue(text, 'wallet_lock_wait_seconds_count')).toBeGreaterThanOrEqual(1);
  });

  it('increments the idempotency-replay counter on a duplicate submission', async () => {
    const playerId = PLAYER();
    const walletId = (await client.createWallet(playerId, '100.00')).body.id;
    const payload = bet(walletId, playerId, '20.00');
    await client.submit(payload, 'provider-a:dup');
    await client.submit(payload, 'provider-a:dup');

    const text = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metricValue(text, 'wager_idempotency_replays_total')).toBe(1);
  });

  it('counts a business rejection under status="REJECTED"', async () => {
    const playerId = PLAYER();
    const walletId = (await client.createWallet(playerId, '10.00')).body.id;
    const r = await client.submit(bet(walletId, playerId, '25.00'));
    expect(r.body.status).toBe('REJECTED');

    const text = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metricValue(text, 'wager_transactions_total', { kind: 'BET', status: 'REJECTED' })).toBe(1);
  });

  it('counts DLQ messages by reason', async () => {
    await purge(sqs);
    await sqs.sendFifo({
      queueUrl: sqs.config.requestQueueUrl,
      body: JSON.stringify({ type: 'Garbage' }),
      groupId: 'g',
      dedupId: uuidv7(),
    });
    await consumer.drainOnce();

    const text = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metricValue(text, 'sqs_messages_dlq_total', { reason: 'malformed' })).toBe(1);
  });

  it('/metrics is unauthenticated and served as Prometheus text', async () => {
    const res = await fetch(`${app.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# HELP wager_transactions_total');
    expect(text).toContain('# TYPE outbox_pending_messages gauge');
  });
});

describe('health checks', () => {
  it('/health/live needs no auth and reports ok', async () => {
    const res = await fetch(`${app.baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe('ok');
  });

  it('/health/ready needs no auth and covers Postgres + SQS', async () => {
    const res = await fetch(`${app.baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.sqs).toBe('ok');
  });
});
