import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ReferenceResolutionPolicy } from './reference-resolution-policy';

// Pin the defaults for this file regardless of ambient env, then restore.
const KEYS = [
  'PENDING_REFERENCE_MAX_ATTEMPTS',
  'PENDING_REFERENCE_BASE_DELAY_MS',
  'PENDING_REFERENCE_CAP_DELAY_MS',
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.PENDING_REFERENCE_MAX_ATTEMPTS;
  delete process.env.PENDING_REFERENCE_BASE_DELAY_MS;
  delete process.env.PENDING_REFERENCE_CAP_DELAY_MS;
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('ReferenceResolutionPolicy (defaults)', () => {
  const at = (n: number) => new ReferenceResolutionPolicy().nextAttemptAt(n, new Date(0)).getTime();

  it('first look is immediate', () => {
    expect(at(0)).toBe(0);
  });

  it('backs off exponentially from 2s, capped at 5min', () => {
    expect(at(1)).toBe(2_000);
    expect(at(2)).toBe(4_000);
    expect(at(3)).toBe(8_000);
    expect(at(9)).toBe(300_000); // 2s * 2^8 = 512s -> capped
  });

  it('the total window before REFERENCE_NOT_FOUND is ~13.5 minutes', () => {
    const policy = new ReferenceResolutionPolicy();
    let total = 0;
    for (let n = 0; n < policy.maxAttempts; n++) total += policy.nextAttemptAt(n, new Date(0)).getTime();
    expect(Math.round(total / 1000)).toBe(810); // 0+2+4+8+16+32+64+128+256+300
  });

  it('maxAttempts gates rejection', () => {
    expect(new ReferenceResolutionPolicy().maxAttempts).toBe(10);
  });
});
