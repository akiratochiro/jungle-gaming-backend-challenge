import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation: object keys are sorted lexicographically at
 * every level, arrays keep their order, `undefined` members are dropped.
 * Used as the pre-image for payload hashing so that two structurally equal
 * payloads always hash identically regardless of key order.
 */
export function canonicalJSONStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) {
      out[key] = canonicalize(v);
    }
  }
  return out;
}

/** SHA-256 hex digest of the canonical JSON of `value`. */
export function sha256CanonicalHex(value: unknown): string {
  return createHash('sha256').update(canonicalJSONStringify(value)).digest('hex');
}
