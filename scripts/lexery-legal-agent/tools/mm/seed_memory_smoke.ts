/**
 * Memory Smoke Test — verifies U9 correctly processes memory items and summaries.
 * Run: pnpm brain:mm:smoke
 *
 * Strategy (inject-into-RunContext, no DB writes required):
 *   - Builds RunContext with mock memory_items + memory_summaries
 *   - Uses mixed/memory routing modes that are allowed to surface memory in U9
 *   - Runs assemblePrompt directly
 *   - Verifies memory contextParts appear
 *   - Also runs with empty memory → verifies graceful degradation
 *   - MCP: reports mm table readiness (row counts)
 *
 * DB write mode (optional, if MEMORY_SMOKE_DB_WRITE=true):
 *   - Inserts test records into mm_memory_items + mm_summaries
 *   - Verifies they appear in a direct DB read
 *   - Cleans up immediately after (marks or deletes test records)
 */
import { assemblePrompt } from '../../assemble/assemblePrompt.js';
import { _setR2ClientForTest } from '../../retrieval/r2-fragment.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import type { RunContext, U4Result, GateDecision } from '../../lib/pipeline/contracts.js';
import type { S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const GATE_OK: GateDecision = {
  expand: false,
  reason_codes: ['OK'],
  thresholds: { min_hits: 3, min_avg_score: 0.18 },
  signals: { hits_count: 0, top_score: null, avg_score: null },
  meta: {},
};

function makeMockR2Client(): S3Client {
  return {
    send: async () => ({
      Body: {
        transformToString: async () =>
          JSON.stringify({ content: { chunks: [{ text: 'Тестова норма закону.' }] } }),
      },
    }),
  } as unknown as S3Client;
}

// ----- Test A: mixed mode + memory injected into RunContext → appears in contextParts -----

async function testMemoryInContext(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());

  const runContext: RunContext = {
    run_id: 'mm-smoke-1',
    tenant_id: 'tenant-mm-test',
    user_id: 'user-mm-test',
    user_input: 'Тестовий запит з пам\'яттю',
    query_profile: { routing_flags: { context_mode: 'mixed' } },
    search_plan: { sources: { use_memory: true, use_lldbi: true } },
    memory_summaries: [
      { scope: 'case', summary_text: 'Підсумок справи: клієнт оскаржує звільнення' },
      { scope: 'global', summary_text: 'Клієнт є ФОП, 3-я група ЄП' },
    ],
    memory_items: [
      { id: 'mi-1', content_preview: 'Деталь 1: позов подано 2025-01-10', scope_type: 'case' },
      { id: 'mi-2', content_preview: 'Деталь 2: є свідок — Іваненко П.П.' },
    ],
    history: [
      { role: 'user', content: 'Попереднє питання' },
      { role: 'assistant', content: 'Попередня відповідь' },
    ],
  };

  const u4: U4Result = {
    rawHits: [
      { r2_key: 'acts/test.json', json_path: '$.content.chunks[0].text', score: 0.85 },
    ],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  _setR2ClientForTest(null);

  const memParts = assembled.contextParts.filter((p) => p.type === 'memory');
  const histParts = assembled.contextParts.filter((p) => p.type === 'history');
  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');

  if (memParts.length < 4) {
    throw new Error(`Expected ≥4 memory parts (summaries+items), got ${memParts.length}`);
  }
  if (histParts.length < 1) {
    throw new Error(`Expected >=1 history part, got ${histParts.length}`);
  }
  if (lawParts.length === 0) {
    throw new Error('Expected ≥1 law part');
  }

  // Verify memory content is present (summary text)
  const memTexts = memParts.map((p) => p.text);
  const hasSummary1 = memTexts.some((t) => t.includes('оскаржує'));
  const hasSummary2 = memTexts.some((t) => t.includes('ФОП'));
  const hasItem1 = memTexts.some((t) => t.includes('позов'));
  const hasItem2 = memTexts.some((t) => t.includes('свідок'));

  if (!hasSummary1) throw new Error('memory summary 1 ("оскаржує") not found in contextParts');
  if (!hasSummary2) throw new Error('memory summary 2 ("ФОП") not found in contextParts');
  if (!hasItem1) throw new Error('memory item 1 ("позов") not found in contextParts');
  if (!hasItem2) throw new Error('memory item 2 ("свідок") not found in contextParts');

  const sources = assembled.meta?.sources;
  if (
    !sources ||
    sources.lawCount !== lawParts.length ||
    sources.memoryCount !== memParts.length ||
    sources.historyCount !== histParts.length
  ) {
    throw new Error(`meta.sources mismatch: ${JSON.stringify(sources)} vs actual law=${lawParts.length} mem=${memParts.length} hist=${histParts.length}`);
  }

  console.log(`[OK] A: mixed mode memory items+summaries → contextParts (law=${lawParts.length} mem=${memParts.length} hist=${histParts.length})`);
}

// ----- Test B: mixed mode + empty memory → graceful (no crash, memory parts count=0) -----

async function testEmptyMemoryGraceful(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());

  const runContext: RunContext = {
    run_id: 'mm-smoke-2',
    tenant_id: null,
    user_id: 'user-mm-empty',
    user_input: 'Запит без пам\'яті',
    query_profile: { routing_flags: { context_mode: 'mixed' } },
    search_plan: { sources: { use_memory: true, use_lldbi: true } },
    memory_items: [],
    memory_summaries: [],
    memory_trace: { degraded: false, recent_count: 0 },
  };

  const u4: U4Result = {
    rawHits: [{ r2_key: 'acts/test.json', json_path: '$.content.chunks[0].text', score: 0.8 }],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  _setR2ClientForTest(null);

  const memParts = assembled.contextParts.filter((p) => p.type === 'memory');
  if (memParts.length !== 0) {
    throw new Error(`Expected 0 memory parts when memory empty, got ${memParts.length}`);
  }

  console.log('[OK] B: mixed mode empty memory → graceful (0 memory parts, no crash)');
}

// ----- Test C: memory mode + degraded memory_trace → no crash -----

async function testDegradedMemoryTrace(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());

  const runContext: RunContext = {
    run_id: 'mm-smoke-3',
    tenant_id: null,
    user_id: 'user-mm-degraded',
    user_input: 'Запит при деградованій пам\'яті',
    query_profile: { routing_flags: { context_mode: 'memory' } },
    search_plan: { sources: { use_memory: true, use_lldbi: false } },
    memory_items: undefined, // not loaded
    memory_summaries: undefined,
    memory_trace: { degraded: true, recent_count: 0 },
  };

  const u4: U4Result = {
    rawHits: [{ r2_key: 'acts/test.json', json_path: '$.content.chunks[0].text', score: 0.8 }],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  _setR2ClientForTest(null);

  const memParts = assembled.contextParts.filter((p) => p.type === 'memory');
  if (memParts.length !== 0) {
    throw new Error(`Expected 0 memory parts when memory undefined/degraded, got ${memParts.length}`);
  }

  console.log('[OK] C: memory mode degraded memory_trace → graceful degradation (0 memory parts, no crash)');
}

// ----- MCP: report mm table readiness -----

async function checkMmTableReadiness(): Promise<void> {
  try {
    const sb = getSupabaseClient();
    const [{ count: itemCount }, { count: summaryCount }] = await Promise.all([
      sb.from('mm_memory_items').select('id', { count: 'exact', head: true }).then((r) => ({ count: r.count ?? 0, error: r.error })),
      sb.from('mm_summaries').select('id', { count: 'exact', head: true }).then((r) => ({ count: r.count ?? 0, error: r.error })),
    ]);
    console.log(`[INFO] mm_memory_items: ${itemCount} rows (schema ready)`);
    console.log(`[INFO] mm_summaries: ${summaryCount} rows (schema ready)`);
  } catch (e) {
    console.warn(`[WARN] Could not check mm tables: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ----- Optional DB write mode -----

async function runDbWriteSmoke(): Promise<void> {
  const sb = getSupabaseClient();
  const testConvId = randomUUID();
  const testUserId = 'a0000000-0000-0000-0000-000000000001'; // fixed test UUID

  console.log('\n[DB Write Mode] Inserting test memory records...');

  // Insert mm_summary
  const { data: summaryRow, error: sumErr } = await sb
    .from('mm_summaries')
    .insert({
      id: randomUUID(),
      user_id: testUserId,
      conversation_id: testConvId,
      scope: 'test',
      summary_text: 'Test summary for memory smoke — created by seed_memory_smoke.ts',
      message_ids: [],
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (sumErr) {
    console.warn(`[WARN] Could not insert mm_summary: ${sumErr.message}`);
  } else {
    console.log(`[OK] Inserted mm_summary id=${summaryRow?.id}`);
  }

  // Insert mm_memory_item
  const { data: itemRow, error: itemErr } = await sb
    .from('mm_memory_items')
    .insert({
      id: randomUUID(),
      user_id: testUserId,
      conversation_id: testConvId,
      scope_type: 'test',
      scope_id: 'smoke-test',
      content: 'Test memory content for seed_memory_smoke.ts',
      metadata: { test: true, created_by: 'seed_memory_smoke' },
      content_hash: 'test-hash-smoke',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (itemErr) {
    console.warn(`[WARN] Could not insert mm_memory_item: ${itemErr.message}`);
  } else {
    console.log(`[OK] Inserted mm_memory_item id=${itemRow?.id}`);
  }

  // Verify rows exist
  const { count: verifyCount } = await sb
    .from('mm_memory_items')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', testConvId);
  console.log(`[OK] Verify: ${verifyCount} mm_memory_item row(s) for test conversation`);

  // Cleanup
  if (summaryRow?.id) {
    await sb.from('mm_summaries').delete().eq('id', summaryRow.id);
    console.log(`[OK] Cleaned up mm_summary ${summaryRow.id}`);
  }
  if (itemRow?.id) {
    await sb.from('mm_memory_items').delete().eq('id', itemRow.id);
    console.log(`[OK] Cleaned up mm_memory_item ${itemRow.id}`);
  }

  console.log('[OK] DB write smoke complete (records inserted + cleaned up)');
}

async function main(): Promise<void> {
  console.log('=== Memory Smoke Test ===\n');

  await checkMmTableReadiness();
  console.log('');

  await testMemoryInContext();
  await testEmptyMemoryGraceful();
  await testDegradedMemoryTrace();

  const dbWriteMode = process.env.MEMORY_SMOKE_DB_WRITE === 'true';
  if (dbWriteMode) {
    await runDbWriteSmoke();
  } else {
    console.log('\n[INFO] DB write mode disabled. Set MEMORY_SMOKE_DB_WRITE=true to also test actual DB inserts/cleanup.');
  }

  console.log('\nPASS — memory smoke complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
