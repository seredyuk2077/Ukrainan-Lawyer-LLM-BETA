import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { CanonicalDocument } from '../canonical/buildCanonical.js';
import { updateDocument } from './update.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { buildActPayloadFromCanonical, buildChunkPayloadsFromCanonical } from '../lib/qdrantPayloadBuilder.js';
import { QdrantRagClient } from '../lib/qdrantRagClient.js';

interface AuditRecord {
  rada_nreg: string;
  severity: 'CRITICAL' | 'WARN' | 'OK';
  issue_codes: string[];
  canonical?: {
    chunks_count?: number;
  };
  qdrant?: {
    current_hash_acts?: number;
    current_hash_chunks?: number;
  };
}

interface DocRow {
  rada_nreg: string;
  title: string | null;
  content_hash: string | null;
  r2_key: string | null;
  category: string | null;
  document_type: string | null;
  document_type_slug: string | null;
  summary: string | null;
  keywords: unknown;
  topics: unknown;
  aliases: unknown;
  validity_status: string | null;
  source_status_location: string | null;
  source_status_text: string | null;
  status_note: string | null;
}

interface RefreshResult {
  rada_nreg: string;
  mode: 'payload_refresh' | 'full_update' | 'skipped';
  success: boolean;
  duration_ms: number;
  chunks?: number;
  old_versions_deleted?: { acts: number; chunks: number };
  reason?: string;
  error?: string;
}

interface RefreshReport {
  generated_at: string;
  source_audit_file: string | null;
  total_candidates: number;
  completed: RefreshResult[];
  failed: RefreshResult[];
}

const PAYLOAD_REFRESHABLE_ISSUES = new Set([
  'QDRANT_MISSING_CHUNK_TITLE',
  'QDRANT_MISSING_UNIT_TYPE',
  'QDRANT_MISSING_UNIT_NUMBER',
  'QDRANT_MISSING_ARTICLE_NUMBER',
  'QDRANT_MISSING_R2_KEY',
  'QDRANT_MISSING_JSON_PATH',
  'QDRANT_ACT_MISSING_TITLE',
  'QDRANT_ACT_MISSING_CATEGORY',
  'QDRANT_ACT_MISSING_DOCUMENT_TYPE',
  'QDRANT_ACT_MISSING_SUMMARY',
  'QDRANT_ACT_MISSING_KEYWORDS',
  'QDRANT_ACT_MISSING_TOPICS',
  'QDRANT_ACT_MISSING_ALIASES',
  'QDRANT_ACT_MISSING_VALIDITY_STATUS',
  'QDRANT_ACT_MISSING_R2_KEY',
  'QDRANT_OLD_ACT_VERSIONS',
  'QDRANT_OLD_CHUNK_VERSIONS',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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

async function readAuditRecords(path: string): Promise<AuditRecord[]> {
  const raw = JSON.parse(await readFile(path, 'utf-8'));
  return Array.isArray(raw?.records) ? raw.records : [];
}

function shouldPayloadRefresh(record: AuditRecord | undefined): boolean {
  if (!record) return false;
  if (record.issue_codes.length === 0) return false;
  const currentActs = record.qdrant?.current_hash_acts ?? 0;
  const currentChunks = record.qdrant?.current_hash_chunks ?? 0;
  const canonicalChunks = record.canonical?.chunks_count ?? 0;
  return (
    currentActs === 1 &&
    currentChunks > 0 &&
    currentChunks === canonicalChunks &&
    record.issue_codes.every((code) => PAYLOAD_REFRESHABLE_ISSUES.has(code))
  );
}

async function writeReport(reportFile: string, report: RefreshReport): Promise<void> {
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
}

async function fetchDocsByNreg(nregs: string[]): Promise<DocRow[]> {
  if (nregs.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const rows: DocRow[] = [];
  for (const batch of chunkArray(nregs, 100)) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select(
        'rada_nreg,title,content_hash,r2_key,category,document_type,document_type_slug,summary,keywords,topics,aliases,validity_status,source_status_location,source_status_text,status_note'
      )
      .in('rada_nreg', batch)
      .order('rada_nreg', { ascending: true });
    if (error) throw new Error(`Failed to fetch legislation_documents: ${error.message}`);
    rows.push(...((data as DocRow[]) || []));
  }
  return rows;
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

export async function refreshQdrantPayloadBatch(options?: {
  nregs?: string[];
  limit?: number;
  concurrency?: number;
  batchSize?: number;
  auditFile?: string;
  resume?: boolean;
  reportFile?: string;
}): Promise<void> {
  const auditFile = resolve(process.cwd(), options?.auditFile ?? 'runs/audit/QDRANT_PAYLOAD_AUDIT.json');
  const reportFile = resolve(
    process.cwd(),
    options?.reportFile ?? 'runs/audit/QDRANT_PAYLOAD_REFRESH_REPORT.json'
  );
  const concurrency = Math.max(1, options?.concurrency ?? 2);
  const batchSize = Math.max(1, options?.batchSize ?? 25);

  const auditRecords = await readAuditRecords(auditFile).catch(() => [] as AuditRecord[]);
  const requestedNregs = normalizeNregs(options?.nregs);
  const targetNregs =
    requestedNregs.length > 0
      ? requestedNregs
      : auditRecords
          .filter((record) => record.issue_codes.length > 0)
          .map((record) => record.rada_nreg);
  const limitedNregs =
    typeof options?.limit === 'number' && options.limit > 0 ? targetNregs.slice(0, options.limit) : targetNregs;

  let report: RefreshReport = {
    generated_at: nowIso(),
    source_audit_file: auditRecords.length > 0 ? auditFile : null,
    total_candidates: limitedNregs.length,
    completed: [],
    failed: [],
  };

  if (options?.resume) {
    try {
      const existing = JSON.parse(await readFile(reportFile, 'utf-8')) as RefreshReport;
      if (Array.isArray(existing?.completed) && Array.isArray(existing?.failed)) {
        report = existing;
      }
    } catch {
      // ignore missing report
    }
  }

  const done = new Set([...report.completed, ...report.failed].map((item) => item.rada_nreg));
  const pendingNregs = limitedNregs.filter((nreg) => !done.has(nreg));
  const docs = await fetchDocsByNreg(pendingNregs);
  const docsByNreg = new Map(docs.map((doc) => [doc.rada_nreg, doc]));
  const pendingDocs = pendingNregs
    .map((nreg) => docsByNreg.get(nreg))
    .filter((doc): doc is DocRow => Boolean(doc));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Refresh Qdrant Payload Batch — LLDBI cheap repair path');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`- source_audit_file: ${report.source_audit_file ?? 'none'}`);
  console.log(`- candidates: ${limitedNregs.length}`);
  console.log(`- pending: ${pendingDocs.length}`);
  console.log(`- concurrency: ${concurrency}`);
  console.log(`- batch_size: ${batchSize}`);
  console.log(`- report_file: ${reportFile}`);

  const qdrant = new QdrantRagClient();
  const auditByNreg = new Map(auditRecords.map((record) => [record.rada_nreg, record]));

  for (const [batchIndex, batch] of chunkArray(pendingDocs, batchSize).entries()) {
    console.log(`\nBatch ${batchIndex + 1}/${Math.ceil(pendingDocs.length / batchSize)} (${batch.length} docs)`);

    await mapWithConcurrency(batch, concurrency, async (doc) => {
      const started = Date.now();
      const auditRecord = auditByNreg.get(doc.rada_nreg);
      const mode: RefreshResult['mode'] = shouldPayloadRefresh(auditRecord) ? 'payload_refresh' : 'full_update';

      try {
        if (!doc.content_hash || !doc.r2_key) {
          throw new Error('content_hash or r2_key missing in legislation_documents');
        }

        if (mode === 'full_update') {
          console.log(`  [${doc.rada_nreg}] full_update`);
          await updateDocument(doc.rada_nreg, { force: true, resume: false });
          const result: RefreshResult = {
            rada_nreg: doc.rada_nreg,
            mode,
            success: true,
            duration_ms: Date.now() - started,
            reason: auditRecord ? auditRecord.issue_codes.join(', ') : 'no_audit_record',
          };
          report.completed.push(result);
          await writeReport(reportFile, report);
          return;
        }

        console.log(`  [${doc.rada_nreg}] payload_refresh`);
        const canonical = (await getJsonFromR2(doc.r2_key)) as CanonicalDocument;
        const actPayload = buildActPayloadFromCanonical(canonical, doc);
        const chunkPayloads = buildChunkPayloadsFromCanonical(canonical, doc);

        await qdrant.overwriteActPayload(actPayload);
        await qdrant.overwriteChunkPayloads(chunkPayloads);
        const oldVersionsDeleted = await qdrant.deleteOldVersions(doc.rada_nreg, doc.content_hash);
        const counts = await qdrant.countDocument(doc.rada_nreg, doc.content_hash);
        if (counts.acts !== 1) {
          throw new Error(`Qdrant verify failed: expected 1 act, got ${counts.acts}`);
        }
        if (counts.chunks !== chunkPayloads.length) {
          throw new Error(`Qdrant verify failed: expected ${chunkPayloads.length} chunks, got ${counts.chunks}`);
        }

        const result: RefreshResult = {
          rada_nreg: doc.rada_nreg,
          mode,
          success: true,
          duration_ms: Date.now() - started,
          chunks: chunkPayloads.length,
          old_versions_deleted: {
            acts: oldVersionsDeleted.actsDeleted,
            chunks: oldVersionsDeleted.chunksDeleted,
          },
          reason: auditRecord ? auditRecord.issue_codes.join(', ') : 'audit_missing',
        };
        report.completed.push(result);
        await writeReport(reportFile, report);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  [${doc.rada_nreg}] FAILED: ${message}`);
        report.failed.push({
          rada_nreg: doc.rada_nreg,
          mode,
          success: false,
          duration_ms: Date.now() - started,
          error: message,
        });
        await writeReport(reportFile, report);
      }
    });
  }

  report.generated_at = nowIso();
  report.total_candidates = limitedNregs.length;
  await writeReport(reportFile, report);

  console.log('\n## Refresh summary');
  console.log(`- total_candidates: ${report.total_candidates}`);
  console.log(`- completed: ${report.completed.length}`);
  console.log(`- failed: ${report.failed.length}`);
  console.log(`- report_file: ${reportFile}`);
}
