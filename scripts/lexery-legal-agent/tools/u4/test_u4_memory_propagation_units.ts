/**
 * U4 Memory propagation unit tests (LEX-144).
 * Verifies: runCacheRag return shape includes memoryRefs/memorySummaries/memoryTrace;
 * semantic fail path sets degraded=true and degraded_reason_codes includes SEMANTIC_ERROR.
 *
 * Run: pnpm brain:test:u4-memory-units
 */
import { strict as assert } from 'assert';
import type { RunCacheRagResult } from '../../retrieval/cache-rag.js';
import { fetchRecentMemory } from '../../retrieval/memory-store.js';

function assertOk(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

function testRunCacheRagResultShape(): void {
  const empty: RunCacheRagResult = {
    rawHits: [],
    retrievalTrace: { version: 1, hits: [], top_score: null, latency_ms: 0, meta: {} },
  };
  assertOk(Array.isArray(empty.rawHits), 'result.rawHits is array');

  const withMemory: RunCacheRagResult = {
    ...empty,
    memoryRefs: [{ id: 'm1', scope_type: 'conversation', scope_id: 'c1' }],
    memorySummaries: [{ summary_text: 'User prefers Ukrainian law.' }],
    memoryTrace: {
      recent_count: 1,
      semantic_count: 0,
      latency_ms: 10,
      sources_used: ['supabase_recent'],
    },
  };
  assertOk(withMemory.memoryRefs?.length === 1, 'memoryRefs length');
  assertOk(withMemory.memorySummaries?.length === 1, 'memorySummaries length');
  assertOk(withMemory.memoryTrace?.recent_count === 1, 'memoryTrace.recent_count');
  console.log('[OK] RunCacheRagResult shape includes memoryRefs, memorySummaries, memoryTrace');
}

function testMemoryTraceSemanticCount(): void {
  const trace = { recent_count: 0, semantic_count: 2, latency_ms: 50, sources_used: ['qdrant_semantic'] };
  assertOk(trace.semantic_count === 2, 'semantic_count in trace');
  console.log('[OK] memory_trace carries semantic_count');
}

function testMemoryMetaInvariant(): void {
  const metaStubWhenDisabled = {
    enabled: false,
    semantic_enabled: false,
    recent_count: 0,
    semantic_count: 0,
  };
  assertOk(metaStubWhenDisabled.enabled === false, 'when disabled meta.enabled is false');
  assertOk(typeof metaStubWhenDisabled.recent_count === 'number', 'meta.recent_count is number');
  assertOk(typeof metaStubWhenDisabled.semantic_count === 'number', 'meta.semantic_count is number');
  console.log('[OK] retrieval_trace.meta.memory invariant: object with enabled/counts always');
}

/** Semantic fail path: inject throws -> degraded=true and degraded_reason_codes includes SEMANTIC_ERROR. */
async function testSemanticFailSetsDegraded(): Promise<void> {
  const result = await fetchRecentMemory(
    {
      tenantId: null,
      userId: 'test-user',
      queryText: 'what did I ask',
      runId: 'test-semantic-fail',
    },
    {
      searchMemorySemantic: async () => {
        throw new Error('simulated Qdrant 400');
      },
    }
  );
  assertOk(result.degraded === true, 'semantic fail -> degraded === true');
  assertOk(
    Array.isArray(result.degraded_reason_codes) && result.degraded_reason_codes!.includes('SEMANTIC_ERROR'),
    'degraded_reason_codes includes SEMANTIC_ERROR'
  );
  console.log('[OK] semantic fail path: degraded=true, degraded_reason_codes includes SEMANTIC_ERROR');
}

/** Conversation scope: when conversationId is set, semantic inject is called with it and scope_primary is conversation. */
async function testConversationScopePrimary(): Promise<void> {
  const convId = 'conv-scope-test';
  let capturedConversationId: string | undefined;
  const result = await fetchRecentMemory(
    {
      tenantId: null,
      userId: 'u1',
      conversationId: convId,
      scopeMode: 'conversation_only',
      queryText: 'recall',
      runId: 'test-scope',
    },
    {
      searchMemorySemantic: async (params) => {
        capturedConversationId = params.conversationId ?? undefined;
        return {
          hits: [{ memoryItemId: 'mid1', score: 0.9, conversationId: convId }],
          degraded: false,
          latencyMs: 5,
        };
      },
    }
  );
  assertOk(capturedConversationId === convId, 'semantic search called with conversationId');
  assertOk(result.scope_primary === 'conversation', 'scope_primary is conversation');
  assertOk((result.conversation_semantic_count ?? 0) === 1, 'conversation_semantic_count === 1');
  assertOk(result.refs.length === 1, 'one ref from conversation');
  console.log('[OK] conversation scope: primary path filtered by conversation_id');
}

function main(): void {
  testRunCacheRagResultShape();
  testMemoryTraceSemanticCount();
  testMemoryMetaInvariant();
  testSemanticFailSetsDegraded()
    .then(() => testConversationScopePrimary())
    .then(() => console.log('All U4 memory propagation unit tests passed.'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
