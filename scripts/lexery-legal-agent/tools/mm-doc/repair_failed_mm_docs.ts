#!/usr/bin/env node
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

process.env.MM_DOCS_ENABLED ??= 'true';

const REPAIRABLE_ERROR_PATTERNS = [
  /not a valid point id/i,
  /qdrant upsert failed: 400/i,
] as const;

async function main(): Promise<void> {
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const { ensureMmDocTablesReady } = await import('../../mm/doc/store.js');
  const { ensureMmDocsCollection } = await import('../../mm/doc/qdrant.js');
  const { repairMmDocRecord } = await import('../../mm/doc/ingest.js');

  await ensureMmDocTablesReady();
  await ensureMmDocsCollection();

  const sb = getSupabaseClient();
  const repairAll = process.env.MM_DOCS_REPAIR_ALL_FAILED === 'true';
  const { data, error } = await sb
    .from('mm_doc_records')
    .select('*')
    .eq('status', 'failed')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`mm_doc_records failed query failed: ${error.message}`);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const candidates = rows.filter((row) => {
    if (repairAll) return true;
    const message = String(row.error_message ?? '');
    return REPAIRABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  });

  const repaired: Array<{ docId: string; chunkCount: number }> = [];
  const skipped = rows.length - candidates.length;

  for (const row of candidates) {
    const result = await repairMmDocRecord({
      record: row as never,
      runId: null,
    });
    repaired.push({
      docId: result.docId,
      chunkCount: result.chunkCount,
    });
  }

  console.log('MM Docs failed-record repair: PASS');
  console.log(
    JSON.stringify(
        {
        repairAll,
        failedRowsFound: rows.length,
        skipped,
        repairedCount: repaired.length,
        repaired,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('MM Docs failed-record repair: FAIL');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
