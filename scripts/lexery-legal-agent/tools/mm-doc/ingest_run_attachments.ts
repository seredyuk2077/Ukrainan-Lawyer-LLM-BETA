#!/usr/bin/env node
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error('Usage: pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm-doc/ingest_run_attachments.ts <run_id>');
    process.exit(1);
  }

  const { RunRepository } = await import('../../gateway/storage.js');
  const { ingestMmDocsFromRun } = await import('../../mm/doc/from-run.js');

  const repo = new RunRepository();
  const run = await repo.findByRunId(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const results = await ingestMmDocsFromRun({
    runId,
    tenantId: run.tenant_id,
    userId: run.user_id,
    conversationId: run.conversation_id ?? null,
    projectId: run.snapshot?.project_context?.project_id ?? null,
    snapshot: run.snapshot,
    attachmentsManifest: run.attachments_manifest ?? null,
  });

  console.log(JSON.stringify({
    run_id: runId,
    ingested_count: results.length,
    docs: results,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
