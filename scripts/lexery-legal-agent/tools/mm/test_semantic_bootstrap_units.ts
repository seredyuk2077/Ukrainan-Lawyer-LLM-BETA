/**
 * Memory collection payload index bootstrap unit tests (mock fetch).
 * Run: pnpm brain:test:semantic-bootstrap-units
 */
process.env.QDRANT_MEMORY_URL = 'http://qdrant.test';
process.env.QDRANT_MEMORY_API_KEY = 'test-key';
process.env.MEMORY_QDRANT_COLLECTION = 'lexery_memory_semantic_v1';

import { strict as assert } from 'assert';
import {
  ensureMemoryCollectionPayloadIndexes,
  resetMemoryBootstrapForTesting,
} from '../../mm/semanticSearch.js';

function assertOk(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

async function testBootstrapCollectionMissing(): Promise<void> {
  resetMemoryBootstrapForTesting();
  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/collections/') && !url.includes('/index')) {
      return new Response('', { status: 404 });
    }
    return new Response('', { status: 200 });
  };
  const result = await ensureMemoryCollectionPayloadIndexes(mockFetch);
  assertOk(result.ok === false, 'result.ok is false when collection 404');
  assertOk(result.reason_code === 'COLLECTION_MISSING', 'reason_code is COLLECTION_MISSING');
  console.log('[OK] bootstrap returns COLLECTION_MISSING when collection GET 404');
}

async function testBootstrapSuccess(): Promise<void> {
  resetMemoryBootstrapForTesting();
  const mockFetch: typeof fetch = async (input) => {
    return new Response('', { status: 200 });
  };
  const result = await ensureMemoryCollectionPayloadIndexes(mockFetch);
  assertOk(result.ok === true, 'result.ok is true when GET and PUTs succeed');
  console.log('[OK] bootstrap returns ok when collection exists and indexes created');
}

async function main(): Promise<void> {
  await testBootstrapCollectionMissing();
  await testBootstrapSuccess();
  console.log('All semantic bootstrap unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
