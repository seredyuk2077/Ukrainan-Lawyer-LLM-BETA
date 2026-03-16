/**
 * Unit tests: compact retrieval_trace keeps critical fields; forensics helper fallback.
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/retrieval/test_retrieval_trace_compact_units.ts
 */
import { strict as assert } from 'assert';
import {
  compactRetrievalTraceForDb,
  MAX_HITS_IN_DB,
} from '../../retrieval/retrieval-trace-compact.js';
import { getRetrievalTraceHitsForForensics } from '../../retrieval/retrieval-trace-r2.js';

function ok(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

function testCompactKeepsCriticalFields(): void {
  const trace = {
    version: 1,
    hits: Array.from({ length: 20 }, (_, i) => ({ r2_key: `k${i}`, json_path: '$', score: 1 - i * 0.01 })),
    top_score: 1,
    latency_ms: 100,
    reason_codes: ['FEW_HITS'],
    selected_acts: [{ rada_nreg: '123', title: 'Test' }],
    meta: {
      hits_count: 20,
      sample_hits: [{ score: 0.9, r2_key: 'a', json_path: '$' }],
      memory: { recent_count: 2, semantic_count: 1 },
    },
  } as Parameters<typeof compactRetrievalTraceForDb>[0];

  const out = compactRetrievalTraceForDb(trace);
  ok(out.hits.length === MAX_HITS_IN_DB, 'hits capped to MAX_HITS_IN_DB');
  ok(out.reason_codes !== undefined && out.reason_codes![0] === 'FEW_HITS', 'reason_codes preserved');
  ok(out.meta?.hits_count === 20, 'meta.hits_count preserved');
  ok(out.meta?.memory != null, 'meta.memory preserved');
  console.log('[OK] compact keeps critical fields');
}

async function testForensicsFallbackNoPointer(): Promise<void> {
  const run = {
    retrieval_trace: {
      hits: [{ r2_key: 'x', json_path: '$', score: 0.8 }],
      meta: {},
    },
  };
  const { hits, source } = await getRetrievalTraceHitsForForensics(run);
  ok(source === 'db', 'source is db when no pointer');
  ok(hits.length === 1, 'hits from DB');
  console.log('[OK] forensics fallback when no full_trace_r2_key');
}

async function main(): Promise<void> {
  testCompactKeepsCriticalFields();
  await testForensicsFallbackNoPointer();
  console.log('All retrieval trace compact/forensics unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
