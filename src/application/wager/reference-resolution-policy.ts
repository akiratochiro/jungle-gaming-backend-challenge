import { Injectable } from '@nestjs/common';

/**
 * How hard and how long the system chases a missing reference before giving up
 * (rules 7.1 / 7.8). Exponential backoff from `baseDelayMs`, doubling per
 * attempt, capped at `capDelayMs`; after `maxAttempts` unsuccessful attempts the
 * transaction is REJECTED with REFERENCE_NOT_FOUND.
 *
 * Defaults: 10 attempts, 2s → 5min cap ≈ up to ~40min of out-of-order tolerance.
 * Justified in ARCHITECTURE.md §Pending reference.
 */
@Injectable()
export class ReferenceResolutionPolicy {
  readonly maxAttempts = Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 10);
  readonly baseDelayMs = Number(process.env.PENDING_REFERENCE_BASE_DELAY_MS ?? 2_000);
  readonly capDelayMs = Number(process.env.PENDING_REFERENCE_CAP_DELAY_MS ?? 300_000);

  /**
   * When to next look for the reference. The first look (attemptsSoFar <= 0) is
   * immediate — the referenced transaction may already be in flight; subsequent
   * looks back off exponentially from `baseDelayMs`, capped at `capDelayMs`.
   */
  nextAttemptAt(attemptsSoFar: number, now: Date = new Date()): Date {
    const delay =
      attemptsSoFar <= 0
        ? 0
        : Math.min(this.baseDelayMs * 2 ** (attemptsSoFar - 1), this.capDelayMs);
    return new Date(now.getTime() + delay);
  }
}
