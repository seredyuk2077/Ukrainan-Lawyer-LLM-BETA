import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { importOne } from '../lib/importer.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';

interface DocRow {
  rada_nreg: string;
  title: string | null;
}

interface ReloadResult {
  rada_nreg: string;
  title: string | null;
  success: boolean;
  skipped: boolean;
  duration_ms: number;
  content_hash?: string;
  expected_chunks?: number;
  qdrant?: { acts: number; chunks: number };
  run_dir?: string;
  error?: string;
}

interface ReloadReport {
  generated_at: string;
  total_candidates: number;
  completed: ReloadResult[];
  failed: ReloadResult[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNregs(value?: string[]): string[] {
  return Array.from(
    new Set(
      (value || [])
        .map((item) => String(item).trim())
        .filter(Boolean)
    )
  );
}

async function writeReport(reportFile: string, report: ReloadReport): Promise<void> {
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  async function runOne(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => runOne()));
}

async function fetchAllDocs(): Promise<DocRow[]> {
  const supabase = createSupabaseAdminClient();
  const rows: DocRow[] = [];
  const pageSize = 500;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,title')
      .order('rada_nreg', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to fetch legislation_documents: ${error.message}`);
    const batch = (data as DocRow[]) || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function fetchDocsByNreg(nregs: string[]): Promise<DocRow[]> {
  if (nregs.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const rows: DocRow[] = [];
  for (const batch of chunkArray(nregs, 100)) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,title')
      .in('rada_nreg', batch)
      .order('rada_nreg', { ascending: true });
    if (error) throw new Error(`Failed to fetch legislation_documents by nreg: ${error.message}`);
    rows.push(...((data as DocRow[]) || []));
  }
  return rows;
}

async function readNregsFromFile(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf-8');
  return normalizeNregs(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  );
}

export async function reloadCorpusBatch(options?: {
  nregs?: string[];
  file?: string;
  limit?: number;
  concurrency?: number;
  batchSize?: number;
  reportFile?: string;
  resume?: boolean;
  resumeJobs?: boolean;
  retryFailed?: boolean;
}): Promise<void> {
  const reportFile = resolve(
    process.cwd(),
    options?.reportFile ?? 'runs/audit/LLDBI_CORPUS_RELOAD_REPORT.json'
  );
  const concurrency = Math.max(1, options?.concurrency ?? 2);
  const batchSize = Math.max(1, options?.batchSize ?? 10);

  const explicitNregs = normalizeNregs(options?.nregs);
  const fileNregs = options?.file ? await readNregsFromFile(options.file) : [];
  const requestedNregs = normalizeNregs([...explicitNregs, ...fileNregs]);

  const docs =
    requestedNregs.length > 0 ? await fetchDocsByNreg(requestedNregs) : await fetchAllDocs();
  const limitedDocs =
    typeof options?.limit === 'number' && options.limit > 0 ? docs.slice(0, options.limit) : docs;

  let report: ReloadReport = {
    generated_at: nowIso(),
    total_candidates: limitedDocs.length,
    completed: [],
    failed: [],
  };

  if (options?.resume) {
    try {
      const existing = JSON.parse(await readFile(reportFile, 'utf-8')) as ReloadReport;
      if (Array.isArray(existing?.completed) && Array.isArray(existing?.failed)) {
        report = existing;
      }
    } catch {
      // ignore missing report
    }
  }

  const done = new Set(
    [
      ...report.completed,
      ...(options?.retryFailed ? [] : report.failed),
    ].map((item) => item.rada_nreg)
  );
  const pendingDocs = limitedDocs.filter((doc) => !done.has(doc.rada_nreg));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Reload Corpus Batch — full LLDBI force reindex');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`- total_candidates: ${limitedDocs.length}`);
  console.log(`- pending: ${pendingDocs.length}`);
  console.log(`- concurrency: ${concurrency}`);
  console.log(`- batch_size: ${batchSize}`);
  console.log(`- report_file: ${reportFile}`);
  console.log(`- resume_jobs: ${String(Boolean(options?.resumeJobs))}`);

  for (const [batchIndex, batch] of chunkArray(pendingDocs, batchSize).entries()) {
    console.log(`\nBatch ${batchIndex + 1}/${Math.ceil(pendingDocs.length / batchSize) || 1} (${batch.length} docs)`);

    await mapWithConcurrency(batch, concurrency, async (doc) => {
      const started = Date.now();
      try {
        console.log(`  [${doc.rada_nreg}] force_update`);
        const result = await importOne({
          mode: 'update',
          radaNreg: doc.rada_nreg,
          force: true,
          resume: Boolean(options?.resumeJobs),
          dryRun: false,
        });

        report.completed.push({
          rada_nreg: doc.rada_nreg,
          title: doc.title,
          success: true,
          skipped: Boolean(result.skipped),
          duration_ms: Date.now() - started,
          content_hash: result.content_hash,
          expected_chunks: result.expected_chunks,
          qdrant: result.qdrant,
          run_dir: result.run_dir,
        });
        if (options?.retryFailed) {
          report.failed = report.failed.filter((item) => item.rada_nreg !== doc.rada_nreg);
        }
        await writeReport(reportFile, report);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  [${doc.rada_nreg}] FAILED: ${message}`);
        report.failed.push({
          rada_nreg: doc.rada_nreg,
          title: doc.title,
          success: false,
          skipped: false,
          duration_ms: Date.now() - started,
          error: message,
        });
        await writeReport(reportFile, report);
      }
    });
  }

  report.generated_at = nowIso();
  report.total_candidates = limitedDocs.length;
  await writeReport(reportFile, report);

  console.log('\n## Reload summary');
  console.log(`- total_candidates: ${report.total_candidates}`);
  console.log(`- completed: ${report.completed.length}`);
  console.log(`- failed: ${report.failed.length}`);
  console.log(`- report_file: ${reportFile}`);
}
