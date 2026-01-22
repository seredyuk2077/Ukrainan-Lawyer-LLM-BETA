#!/usr/bin/env node
/**
 * Minimal unit test for deterministic Qdrant IDs.
 *
 * Run:
 *   pnpm tsx scripts/legislation/test/test_qdrant_ids.ts
 */
import { assertDeterministicIds, qdrantActId, qdrantChunkId } from '../lib/qdrantIds.js';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assertDeterministicIds();

const act1 = qdrantActId({ radaNreg: '254к/96-вр', contentHash: 'a'.repeat(64) });
const act2 = qdrantActId({ radaNreg: '254к/96-вр', contentHash: 'a'.repeat(64) });
assert(act1 === act2, 'Act ID must be deterministic');

const c1 = qdrantChunkId({ radaNreg: '254к/96-вр', contentHash: 'a'.repeat(64), chunkIndex: 0 });
const c2 = qdrantChunkId({ radaNreg: '254к/96-вр', contentHash: 'a'.repeat(64), chunkIndex: 1 });
assert(c1 !== c2, 'Chunk IDs must differ for different chunk_index');

console.log('✅ qdrantIds: OK');

