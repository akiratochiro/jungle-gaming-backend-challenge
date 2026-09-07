import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from 'uuidv7';
import { ensureSchema, startTestApp, TestApp } from '../helpers/test-app';
import { Client, op } from '../helpers/client';
import { PendingReferenceWorker } from '../../src/infra/workers/pending-reference.worker';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Compress the reference-resolution backoff so the worker retries quickly.
const ENV_OVERRIDES = {
  PENDING_REFERENCE_BASE_DELAY_MS: '1',
  PENDING_REFERENCE_CAP_DELAY_MS: '5',
  PENDING_REFERENCE_MAX_ATTEMPTS: '3',
} as const;
const savedEnv: Record<string, string | undefined> = {};

let app: TestApp;
let client: Client;
let worker: PendingReferenceWorker;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await ensureSchema();
  app = await startTestApp();
  client = new Client(app.baseUrl);
  worker = app.get<PendingReferenceWorker>(PendingReferenceWorker);
});

afterAll(async () => {
  await app.close();
  for (const k of Object.keys(ENV_OVERRIDES)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  await app.truncate();
});

async function walletWith(amount: string) {
  const playerId = uuidv7();
  const res = await client.createWallet(playerId, amount);
  return { playerId, walletId: res.body.id as string };
}

describe('REFUND', () => {
  it('reverses a PROCESSED BET once, restoring the balance', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const betExt = uuidv7();
    const b = await client.submit(
      op('BET', { walletId, playerId, externalTransactionId: betExt, money: { amount: '30.00', currency: 'BRL' } }),
    );
    expect(b.body.status).toBe('PROCESSED');
    expect(b.body.balance.amount).toBe('70.00');

    const r = await client.submit(
      op('REFUND', {
        walletId,
        playerId,
        referenceExternalTransactionId: betExt,
        money: { amount: '30.00', currency: 'BRL' },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PROCESSED');
    expect(r.body.balance.amount).toBe('100.00');

    const ledger = await client.ledger(walletId);
    const credits = ledger.body.entries.filter((e: any) => e.direction === 'CREDIT');
    // opening + refund
    expect(credits).toHaveLength(2);

    const recon = await client.reconcile(walletId);
    expect(recon.body.consistent).toBe(true);
  });

  it('a second REFUND of the same BET is rejected', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const betExt = uuidv7();
    await client.submit(
      op('BET', { walletId, playerId, externalTransactionId: betExt, money: { amount: '30.00', currency: 'BRL' } }),
    );
    const refund = () =>
      client.submit(
        op('REFUND', {
          walletId,
          playerId,
          referenceExternalTransactionId: betExt,
          money: { amount: '30.00', currency: 'BRL' },
        }),
      );
    expect((await refund()).body.status).toBe('PROCESSED');
    const second = await refund();
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  });

  it('rejects a partial REFUND (amount != reference)', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const betExt = uuidv7();
    await client.submit(
      op('BET', { walletId, playerId, externalTransactionId: betExt, money: { amount: '30.00', currency: 'BRL' } }),
    );
    const r = await client.submit(
      op('REFUND', {
        walletId,
        playerId,
        referenceExternalTransactionId: betExt,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('REVERSAL_AMOUNT_MISMATCH');
  });

  it('400 when referenceExternalTransactionId is missing', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const r = await client.submit(op('REFUND', { walletId, playerId, money: { amount: '10.00', currency: 'BRL' } }));
    expect(r.status).toBe(400);
  });
});

describe('ROLLBACK', () => {
  it('inverts a WIN (credit -> debit)', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const winExt = uuidv7();
    const w = await client.submit(
      op('WIN', { walletId, playerId, externalTransactionId: winExt, money: { amount: '40.00', currency: 'BRL' } }),
    );
    expect(w.body.balance.amount).toBe('140.00');

    const rb = await client.submit(
      op('ROLLBACK', {
        walletId,
        playerId,
        referenceExternalTransactionId: winExt,
        money: { amount: '40.00', currency: 'BRL' },
      }),
    );
    expect(rb.body.status).toBe('PROCESSED');
    expect(rb.body.balance.amount).toBe('100.00');

    const ledger = await client.ledger(walletId);
    const debits = ledger.body.entries.filter((e: any) => e.direction === 'DEBIT');
    expect(debits).toHaveLength(1);
  });

  it('rejects a ROLLBACK that would overdraw with a distinct failure code', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const winExt = uuidv7();
    await client.submit(
      op('WIN', { walletId, playerId, externalTransactionId: winExt, money: { amount: '40.00', currency: 'BRL' } }),
    );
    // spend the balance so the rollback debit cannot fit
    await client.submit(op('BET', { walletId, playerId, money: { amount: '120.00', currency: 'BRL' } }));

    const rb = await client.submit(
      op('ROLLBACK', {
        walletId,
        playerId,
        referenceExternalTransactionId: winExt,
        money: { amount: '40.00', currency: 'BRL' },
      }),
    );
    expect(rb.status).toBe(422);
    expect(rb.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
  });
});

describe('out-of-order reference (PENDING_REFERENCE)', () => {
  it('parks a REFUND that arrives before its BET, then the worker resolves it', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const betExt = uuidv7();

    const refund = await client.submit(
      op('REFUND', {
        walletId,
        playerId,
        roundId: 'round-9',
        referenceExternalTransactionId: betExt,
        money: { amount: '30.00', currency: 'BRL' },
      }),
    );
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');

    // worker runs while the reference still does not exist -> reschedule
    expect(await worker.drainOnce()).toBe(1);

    // now the BET lands
    await client.submit(
      op('BET', {
        walletId,
        playerId,
        roundId: 'round-9',
        externalTransactionId: betExt,
        money: { amount: '30.00', currency: 'BRL' },
      }),
    );

    expect(await worker.drainOnce()).toBe(1);

    const tx = await client.wallet(walletId);
    expect(tx.body.balance.amount).toBe('100.00'); // 100 - 30 (bet) + 30 (refund)

    const resolved = await fetch(
      `${app.baseUrl}/wagering/transactions/${refund.body.transactionId}`,
    ).then((r) => r.json() as any);
    expect(resolved.status).toBe('PROCESSED');

    const recon = await client.reconcile(walletId);
    expect(recon.body.consistent).toBe(true);
  });

  it('parks a ROLLBACK that arrives before its WIN, then the worker applies the inverse', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const winExt = uuidv7();

    const rollback = await client.submit(
      op('ROLLBACK', {
        walletId,
        playerId,
        roundId: 'round-7',
        referenceExternalTransactionId: winExt,
        money: { amount: '40.00', currency: 'BRL' },
      }),
    );
    expect(rollback.status).toBe(202);
    expect(rollback.body.status).toBe('PENDING_REFERENCE');
    expect((await client.wallet(walletId)).body.balance.amount).toBe('100.00'); // untouched

    await worker.drainOnce(); // reference still absent -> reschedule

    // the WIN lands afterwards
    await client.submit(
      op('WIN', {
        walletId,
        playerId,
        roundId: 'round-7',
        externalTransactionId: winExt,
        money: { amount: '40.00', currency: 'BRL' },
      }),
    );
    expect((await client.wallet(walletId)).body.balance.amount).toBe('140.00');

    await wait(10);
    expect(await worker.drainOnce()).toBe(1);

    const resolved = await fetch(
      `${app.baseUrl}/wagering/transactions/${rollback.body.transactionId}`,
    ).then((r) => r.json() as any);
    expect(resolved.status).toBe('PROCESSED');

    // ROLLBACK inverts the WIN credit -> debit 40
    expect((await client.wallet(walletId)).body.balance.amount).toBe('100.00');
    const ledger = await client.ledger(walletId);
    const debits = ledger.body.entries.filter((e: any) => e.direction === 'DEBIT');
    expect(debits).toHaveLength(1);
    expect((await client.reconcile(walletId)).body.consistent).toBe(true);
  });

  it('the scheduled worker loop (not a manual drain) resolves a parked reversal', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const betExt = uuidv7();

    const refund = await client.submit(
      op('REFUND', {
        walletId,
        playerId,
        roundId: 'round-loop',
        referenceExternalTransactionId: betExt,
        money: { amount: '20.00', currency: 'BRL' },
      }),
    );
    expect(refund.body.status).toBe('PENDING_REFERENCE');

    worker.start(20); // real setInterval-style loop
    try {
      await client.submit(
        op('BET', {
          walletId,
          playerId,
          roundId: 'round-loop',
          externalTransactionId: betExt,
          money: { amount: '20.00', currency: 'BRL' },
        }),
      );

      // poll until the loop picks it up
      let status = 'PENDING_REFERENCE';
      for (let i = 0; i < 100 && status !== 'PROCESSED'; i++) {
        await wait(20);
        status = await fetch(`${app.baseUrl}/wagering/transactions/${refund.body.transactionId}`)
          .then((r) => r.json() as any)
          .then((b) => b.status);
      }
      expect(status).toBe('PROCESSED');
      expect((await client.wallet(walletId)).body.balance.amount).toBe('100.00');
    } finally {
      worker.stop();
    }
  });

  it('rejects with REFERENCE_NOT_FOUND after the retry budget is exhausted', async () => {
    const { walletId, playerId } = await walletWith('100.00');
    const refund = await client.submit(
      op('REFUND', {
        walletId,
        playerId,
        referenceExternalTransactionId: uuidv7(), // never submitted
        money: { amount: '30.00', currency: 'BRL' },
      }),
    );
    expect(refund.body.status).toBe('PENDING_REFERENCE');

    // MAX_ATTEMPTS = 3 → three worker passes reach the budget and reject.
    for (let i = 0; i < 3; i++) {
      await wait(10);
      await worker.drainOnce();
    }

    const resolved = await fetch(
      `${app.baseUrl}/wagering/transactions/${refund.body.transactionId}`,
    ).then((r) => r.json() as any);
    expect(resolved.status).toBe('REJECTED');
    expect(resolved.failureCode).toBe('REFERENCE_NOT_FOUND');

    const recon = await client.reconcile(walletId);
    expect(recon.body.consistent).toBe(true);
  });
});
