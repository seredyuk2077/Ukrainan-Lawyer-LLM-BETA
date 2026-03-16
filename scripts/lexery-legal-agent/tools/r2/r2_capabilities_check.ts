#!/usr/bin/env node
/**
 * R2 capability check for memory offload (Lexery Brain).
 * 1) Queries Supabase for a recent mm_memory_items row with r2_key IS NOT NULL.
 * 2) Attempts GET on that r2_key using runtime R2 config (same bucket as runs).
 * 3) Prints PASS/FAIL, latency, bucket, key.
 * Run: pnpm brain:r2:capabilities
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { getSupabaseClient } from '../../lib/supabase.js';
import { config } from '../../lib/config.js';
import { getMemoryOffload } from '../../mm/offload.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../../.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

async function main(): Promise<void> {
  console.log('--- R2 capabilities (memory offload) ---\n');

  if (!config.r2Endpoint || !config.r2AccessKey || !config.r2SecretKey) {
    console.log('R2 config: MISSING (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
    console.log('Result: SKIP (configure R2 to verify offload readability)');
    process.exit(0);
  }

  console.log(`Bucket: ${config.r2BucketRuns}`);
  console.log(`Endpoint: ${config.r2Endpoint ? '[set]' : '[missing]'}\n`);

  const sb = getSupabaseClient();
  if (!sb) {
    console.log('Supabase: not configured — cannot fetch r2_key from mm_memory_items');
    console.log('Result: SKIP');
    process.exit(0);
  }

  const { data: row, error } = await sb
    .from('mm_memory_items')
    .select('id, r2_key, content_size')
    .not('r2_key', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Supabase query error:', error.message);
    console.log('Result: FAIL');
    process.exit(1);
  }

  if (!row || !(row as { r2_key?: string }).r2_key) {
    console.log('No mm_memory_items with r2_key found.');
    console.log('To get one: MM_OFFLOAD_ENABLED=true MM_OFFLOAD_THRESHOLD_CHARS=15 MM_SEED_UNIQUE_SUFFIX=v12-proof-2 MM_SEED_RUN_ID=dev-seed-offload-v12c pnpm brain:mm:seed-dev-user');
    console.log('Result: SKIP');
    process.exit(0);
  }

  const r2Key = (row as { r2_key: string }).r2_key;
  const memoryItemId = (row as { id: string }).id;
  console.log(`Memory item: ${memoryItemId}`);
  console.log(`R2 key: ${r2Key}\n`);

  const t0 = Date.now();
  const result = await getMemoryOffload(r2Key);
  const latencyMs = Date.now() - t0;

  if (result.error) {
    console.error('R2 GET error:', result.error);
    console.log(`Latency: ${latencyMs}ms`);
    console.log('Result: FAIL');
    process.exit(1);
  }

  if (result.content == null || result.content === '') {
    console.error('R2 GET returned empty content');
    console.log(`Latency: ${latencyMs}ms`);
    console.log('Result: FAIL');
    process.exit(1);
  }

  console.log(`Latency: ${latencyMs}ms`);
  console.log(`Content length: ${result.content.length} chars`);
  console.log('\n---');
  console.log('PASS — R2 offload object readable (single source of truth: config.r2BucketRuns + key from Supabase)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
