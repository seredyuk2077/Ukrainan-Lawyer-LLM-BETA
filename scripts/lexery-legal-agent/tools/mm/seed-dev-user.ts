/**
 * DEV SEED — bootstrap memory for Andrii (dev tester) using the production write path.
 *
 * What it does:
 *   1. Ensures tenant + chat_session exist for dev IDs
 *   2. Inserts a mm_outbox event (index_memory) with Andrii's identity fact
 *   3. Runs MM Outbox Worker to process the event
 *   4. Verifies mm_memory_items + Qdrant have the fact
 *   5. Reports summary
 *
 * Usage: pnpm brain:mm:seed-dev-user
 * Idempotent: safe to run multiple times (dedup by content_hash).
 */
import { getSupabaseClient } from '../../lib/supabase.js';
import { config } from '../../lib/config.js';
import { runOutboxWorkerBatch } from '../../mm/outboxWorker.js';

// Dev IDs (stable, deterministic). Override run for offload test: MM_SEED_RUN_ID=dev-seed-offload-v12
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const CONV_ID = '00000000-0000-0000-0000-000000000003';
const RUN_ID = process.env.MM_SEED_RUN_ID || 'dev-seed-andrii-v1';
/** When set (e.g. v12-proof), append a long unique fact so extraction produces one fact > offload threshold for R2 proof. */
const UNIQUE_SUFFIX = process.env.MM_SEED_UNIQUE_SUFFIX ?? '';

const SEED_FACTS = [
  "User's name is Andrii, he is the lead developer and tester of Lexery Legal Agent platform.",
  'User works in software engineering and legal tech, not as a licensed lawyer.',
  'Preferred jurisdiction: Ukraine. Preferred language: Ukrainian.',
];

/** Long unique sentence so extractor returns one fact > MM_OFFLOAD_THRESHOLD_CHARS; used when MM_SEED_UNIQUE_SUFFIX is set. */
function getOffloadProofFact(): string {
  return `Unique offload verification fact for seed run: ${UNIQUE_SUFFIX}. This single fact is intentionally longer than the offload threshold to prove R2 storage. End of verification blob.`;
}

async function ensureTenantAndSession(): Promise<void> {
  const sb = getSupabaseClient();

  // Upsert tenant
  await sb
    .from('tenants')
    .upsert({ id: TENANT_ID, name: 'Dev Tenant (Andrii)', settings: {}, updated_at: new Date().toISOString() })
    .throwOnError();
  console.log('[seed] tenant upserted:', TENANT_ID);

  // Upsert chat_session
  await sb
    .from('chat_sessions')
    .upsert({
      id: CONV_ID,
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      updated_at: new Date().toISOString(),
    })
    .throwOnError();
  console.log('[seed] chat_session upserted:', CONV_ID);
}

async function insertSeedOutboxEvent(): Promise<string | null> {
  const sb = getSupabaseClient();

  // Check if already processed (idempotent)
  const { data: existing } = await sb
    .from('mm_outbox')
    .select('id, status')
    .eq('run_id', RUN_ID)
    .eq('event_type', 'index_memory')
    .maybeSingle();

  if (existing?.status === 'done') {
    console.log('[seed] outbox event already processed (done) — skipping insert');
    return existing.id;
  }

  if (existing?.status === 'pending' || existing?.status === 'processing') {
    console.log('[seed] outbox event exists (status:', existing.status, ') — will process');
    return existing.id;
  }

  const answerSummary = UNIQUE_SUFFIX
    ? SEED_FACTS.join(' ') + ' ' + getOffloadProofFact()
    : SEED_FACTS.join(' ');
  const { data: inserted, error } = await sb
    .from('mm_outbox')
    .insert({
      conversation_id: CONV_ID,
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      event_type: 'index_memory',
      payload: {
        conversation_id: CONV_ID,
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        run_id: RUN_ID,
        answer_summary: answerSummary,
      },
      status: 'pending',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !inserted) {
    console.error('[seed] failed to insert outbox event:', error?.message);
    return null;
  }

  console.log('[seed] outbox event inserted:', inserted.id);
  return inserted.id;
}

async function verifyResults(): Promise<void> {
  const sb = getSupabaseClient();

  // Check mm_memory_items (include r2_key for offload proof)
  const { data: items, error: itemsErr } = await sb
    .from('mm_memory_items')
    .select('id, content, created_at, r2_key, content_size')
    .eq('conversation_id', CONV_ID)
    .order('created_at', { ascending: false })
    .limit(10);

  if (itemsErr) {
    console.error('[verify] mm_memory_items query error:', itemsErr.message);
    return;
  }

  console.log('\n[verify] mm_memory_items for conv-dev-andrii:');
  if (!items || items.length === 0) {
    console.log('  (none — extraction may have failed or no API key configured)');
  } else {
    const withR2 = (items as Array<{ id: string; content: string; created_at: string; r2_key?: string | null; content_size?: number | null }>).filter((i) => i.r2_key);
    items.forEach((item: { id: string; content: string; created_at: string; r2_key?: string | null; content_size?: number | null }, i: number) => {
      const r2 = item.r2_key ? ` | r2_key=${item.r2_key.slice(0, 50)}... content_size=${item.content_size ?? 'n/a'}` : '';
      console.log(`  ${i + 1}. [${item.id.slice(0, 8)}] "${item.content.slice(0, 80)}"${r2}`);
    });
    console.log(`  Total: ${items.length} items${withR2.length > 0 ? ` (${withR2.length} offloaded to R2)` : ''}`);
  }

  // Check mm_outbox status
  const { data: outbox } = await sb
    .from('mm_outbox')
    .select('id, status, processed_at')
    .eq('run_id', RUN_ID)
    .maybeSingle();

  console.log('\n[verify] mm_outbox event:');
  if (outbox) {
    console.log(`  id: ${outbox.id} | status: ${outbox.status} | processed_at: ${outbox.processed_at ?? 'null'}`);
  } else {
    console.log('  (not found)');
  }

  // Check mm_summaries
  const { data: summaries } = await sb
    .from('mm_summaries')
    .select('id, summary_text')
    .eq('conversation_id', CONV_ID)
    .maybeSingle();

  console.log('\n[verify] mm_summaries:');
  if (summaries) {
    console.log(`  "${(summaries.summary_text as string).slice(0, 100)}"`);
  } else {
    console.log('  (none)');
  }

  // Check Qdrant point count (informational)
  if (config.memoryQdrantUrl) {
    try {
      const res = await fetch(
        `${config.memoryQdrantUrl}/collections/${config.memoryQdrantCollection}/points/count`,
        {
          method: 'POST',
          headers: { 'api-key': config.memoryQdrantApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: { must: [{ key: 'conversation_id', match: { value: CONV_ID } }] } }),
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { result?: { count: number } };
        console.log('\n[verify] Qdrant memory points for conv-dev-andrii:', data.result?.count ?? 0);
      }
    } catch (e) {
      console.log('[verify] Qdrant check failed (non-fatal):', String(e));
    }
  }
}

async function main(): Promise<void> {
  console.log('=== DEV SEED — Andrii tester memory bootstrap ===\n');

  // Step 1: Ensure tenant + session
  await ensureTenantAndSession();

  // Step 2: Insert seed outbox event
  await insertSeedOutboxEvent();

  // Step 3: Run outbox worker
  console.log('\n[worker] processing mm_outbox batch...');
  const workerResult = await runOutboxWorkerBatch({ batchSize: 5, runId: 'seed-worker' });
  console.log(
    `[worker] done: processed=${workerResult.processed} failed=${workerResult.failed} ` +
      `facts_inserted=${workerResult.factsInserted} qdrant_upserted=${workerResult.qdrantUpserted}`
  );

  // Step 4: Verify
  await verifyResults();

  console.log('\n=== SEED COMPLETE ===');
  console.log('Next: run pnpm brain:verify:u5 with MEMORY_RECENT_ENABLED=true to see memory in U9 assembled_prompt');
}

main().catch((err) => {
  console.error('[seed] FATAL:', err);
  process.exit(1);
});
