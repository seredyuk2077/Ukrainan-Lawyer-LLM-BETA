import crypto from 'node:crypto';

/**
 * Deterministic UUID from `nreg` using SHA-256 (truncated to 128 bits).
 *
 * IMPORTANT: This must stay stable forever.
 * Qdrant point IDs cannot be arbitrary strings, so we map nreg -> UUID to keep upserts idempotent and resume-safe.
 */
export function nregToUuid(nreg: string): string {
  // UUID format: 8-4-4-4-12
  const hash = crypto.createHash('sha256').update(nreg).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

