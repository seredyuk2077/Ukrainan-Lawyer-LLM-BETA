/**
 * Deterministic Qdrant IDs (UUID-shaped).
 *
 * Qdrant cluster in this project accepts UUID IDs reliably.
 * We still need determinism for idempotent re-runs.
 */
import { createHash } from 'crypto';

export function deterministicUuidFromString(input: string): string {
  const hash = createHash('sha256').update(input, 'utf-8').digest(); // 32 bytes
  const b = Buffer.from(hash.subarray(0, 16)); // 16 bytes

  // RFC 4122 variant + version 5 (namespace/name based)
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;

  const hex = b.toString('hex');
  // 8-4-4-4-12
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function qdrantChunkId(params: { radaNreg: string; contentHash: string; chunkIndex: number }): string {
  return deterministicUuidFromString(`${params.radaNreg}|${params.contentHash}|${params.chunkIndex}`);
}

export function qdrantActId(params: { radaNreg: string; contentHash: string }): string {
  return deterministicUuidFromString(`${params.radaNreg}|${params.contentHash}`);
}

export function assertDeterministicIds(): void {
  const a1 = qdrantChunkId({ radaNreg: 'X', contentHash: 'H', chunkIndex: 1 });
  const a2 = qdrantChunkId({ radaNreg: 'X', contentHash: 'H', chunkIndex: 1 });
  const b = qdrantChunkId({ radaNreg: 'X', contentHash: 'H', chunkIndex: 2 });
  if (a1 !== a2) throw new Error('Determinism check failed (same input produced different IDs)');
  if (a1 === b) throw new Error('Uniqueness check failed (different input produced same ID)');
}

