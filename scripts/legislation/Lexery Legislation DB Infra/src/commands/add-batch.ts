/**
 * Add-batch command — batch import з файлу nregs.txt
 */
import { readFile } from 'fs/promises';
import { importOne } from '../lib/importer.js';
import { createRunContext, logLine, writeJson, uploadRunToR2 } from '../lib/runs.js';
import { nowIso } from '../lib/supabaseAdmin.js';

export interface BatchOptions {
  file: string;
  concurrency?: number;
  dryRun?: boolean;
}

export async function addBatch(opts: BatchOptions): Promise<void> {
  const concurrency = opts.concurrency || 2;
  const content = await readFile(opts.file, 'utf-8');
  const nregs = content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  console.log(`## Add-batch`);
  console.log(`- file: ${opts.file}`);
  console.log(`- nregs_count: ${nregs.length}`);
  console.log(`- concurrency: ${concurrency}`);
  console.log(`- dry_run: ${String(Boolean(opts.dryRun))}`);

  const batchRun = await createRunContext({ title: 'batch-import', radaNreg: 'batch' });
  await logLine(batchRun, `batch:start ${nowIso()} count=${nregs.length} concurrency=${concurrency}`);

  const results: Array<{ nreg: string; success: boolean; error?: string; skipped?: boolean }> = [];
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  // Simple concurrency control
  const queue: Array<Promise<void>> = [];
  let active = 0;

  for (const nreg of nregs) {
    while (active >= concurrency) {
      await Promise.race(queue);
    }

    active++;
    const p = importOne({
      mode: 'add',
      radaNreg: nreg,
      dryRun: Boolean(opts.dryRun),
    })
      .then(res => {
        results.push({ nreg, success: true, skipped: Boolean(res.skipped) });
        if (res.skipped) skippedCount++;
        else successCount++;
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ nreg, success: false, error: msg });
        errorCount++;
      })
      .finally(() => {
        active--;
      });

    queue.push(p);
  }

  // Wait for all
  await Promise.all(queue);

  const summary = {
    total: nregs.length,
    success: successCount,
    skipped: skippedCount,
    errors: errorCount,
    results,
  };

  await writeJson(batchRun.reportPath, { phase: 'F.batch.completed', summary });
  await logLine(batchRun, `batch:done ${nowIso()} success=${successCount} skipped=${skippedCount} errors=${errorCount}`);

  console.log('\n## Batch summary');
  console.log(`- total: ${summary.total}`);
  console.log(`- success: ${summary.success}`);
  console.log(`- skipped: ${summary.skipped}`);
  console.log(`- errors: ${summary.errors}`);
  console.log(`- batch_run_dir: ${batchRun.r2RunPrefix} (R2)`);
  await uploadRunToR2(batchRun);
}
