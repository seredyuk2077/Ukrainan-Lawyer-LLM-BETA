/**
 * Audit Qdrant payload completeness for the live LLDBI corpus.
 *
 * Checks, per document:
 * - current-hash act/chunk presence
 * - stale Qdrant versions by content_hash
 * - payload completeness (chunk_title, unit_type, unit_number, article_number, r2_key, json_path)
 * - payload drift against canonical chunk metadata in R2
 * - act-level payload completeness (summary, keywords, topics, aliases, validity_status)
 *
 * This is a corpus hygiene command intended to catch retrieval regressions caused by
 * incomplete or stale payloads before they surface in U4 ranking.
 */
import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import {
  createQdrantClient,
  QDRANT_COLLECTION_ACTS,
  QDRANT_COLLECTION_CHUNKS,
} from '../lib/qdrantAdmin.js';

interface LegislationDocumentRow {
  rada_nreg: string;
  title: string | null;
  content_hash: string | null;
  r2_key: string | null;
  expected_chunks: number | null;
  indexed_chunks: number | null;
  qdrant_status: string | null;
  category: string | null;
  document_type: string | null;
  validity_status: string | null;
}

interface CanonicalChunkLike {
  chunk_index?: number | null;
  article_number?: string | null;
  unit_number?: string | null;
  unit_type?: string | null;
  title?: string | null;
}

interface PayloadIssueCounts {
  missing_chunk_title: number;
  chunk_title_drift: number;
  missing_unit_type: number;
  unit_type_drift: number;
  missing_unit_number: number;
  unit_number_drift: number;
  missing_article_number: number;
  article_number_drift: number;
  missing_r2_key: number;
  missing_json_path: number;
  orphan_current_chunks: number;
  current_chunk_count_mismatch: number;
}

interface ActPayloadIssueCounts {
  missing_title: number;
  missing_category: number;
  missing_document_type: number;
  missing_summary: number;
  missing_keywords: number;
  missing_topics: number;
  missing_aliases: number;
  missing_validity_status: number;
  missing_r2_key: number;
}

interface PayloadAuditRecord {
  rada_nreg: string;
  title: string;
  severity: 'CRITICAL' | 'WARN' | 'OK';
  issue_codes: string[];
  recommended_actions: string[];
  doc: {
    content_hash: string | null;
    r2_key: string | null;
    expected_chunks: number | null;
    indexed_chunks: number | null;
    qdrant_status: string | null;
    category: string | null;
    document_type: string | null;
    validity_status: string | null;
  };
  canonical: {
    found: boolean;
    chunks_count: number;
  };
  qdrant: {
    current_hash_chunks: number;
    current_hash_acts: number;
    old_hash_chunks: number;
    old_hash_acts: number;
    chunk_hash_counts: Record<string, number>;
    act_hash_counts: Record<string, number>;
  };
  chunk_payload: PayloadIssueCounts;
  act_payload: ActPayloadIssueCounts;
}

interface AuditSummary {
  total_docs: number;
  docs_with_issues: number;
  critical_docs: number;
  warn_docs: number;
  ok_docs: number;
  issue_counts: Record<string, number>;
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasValue(value: unknown): boolean {
  return normalizeText(value).length > 0;
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => hasValue(item));
}

function isEqualNormalized(a: unknown, b: unknown): boolean {
  return normalizeText(a) === normalizeText(b);
}

function addHashCount(map: Record<string, number>, contentHash: unknown): void {
  const key = normalizeText(contentHash) || '_missing';
  map[key] = (map[key] ?? 0) + 1;
}

async function scrollAllPointsByNreg(
  client: QdrantClient,
  collection: string,
  radaNreg: string
): Promise<any[]> {
  const points: any[] = [];
  let offset: unknown = undefined;
  let lastOffsetKey = '__start__';

  while (true) {
    const res = await client.scroll(collection, {
      filter: {
        must: [{ key: 'rada_nreg', match: { value: radaNreg } }],
      },
      limit: 256,
      offset,
      with_payload: true,
      with_vector: false,
    } as any);

    const batch = (res as any)?.points ?? [];
    points.push(...batch);

    const nextOffset = (res as any)?.next_page_offset;
    if (nextOffset == null || batch.length === 0) break;

    const nextOffsetKey = JSON.stringify(nextOffset);
    if (nextOffsetKey === lastOffsetKey) break;
    lastOffsetKey = nextOffsetKey;
    offset = nextOffset;
  }

  return points;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => runOne());
  await Promise.all(workers);
  return results;
}

function collectIssueCodes(record: PayloadAuditRecord): string[] {
  const codes: string[] = [];
  if (!record.canonical.found) codes.push('R2_CANONICAL_MISSING');
  if (record.qdrant.current_hash_acts === 0) codes.push('QDRANT_CURRENT_ACT_MISSING');
  if (record.qdrant.current_hash_acts > 1) codes.push('QDRANT_DUPLICATE_CURRENT_ACTS');
  if (record.qdrant.current_hash_chunks === 0) codes.push('QDRANT_CURRENT_CHUNKS_MISSING');
  if (record.qdrant.old_hash_acts > 0) codes.push('QDRANT_OLD_ACT_VERSIONS');
  if (record.qdrant.old_hash_chunks > 0) codes.push('QDRANT_OLD_CHUNK_VERSIONS');
  if (record.chunk_payload.current_chunk_count_mismatch > 0) codes.push('QDRANT_CURRENT_CHUNK_COUNT_MISMATCH');
  if (record.chunk_payload.missing_chunk_title > 0) codes.push('QDRANT_MISSING_CHUNK_TITLE');
  if (record.chunk_payload.chunk_title_drift > 0) codes.push('QDRANT_CHUNK_TITLE_DRIFT');
  if (record.chunk_payload.missing_unit_type > 0) codes.push('QDRANT_MISSING_UNIT_TYPE');
  if (record.chunk_payload.unit_type_drift > 0) codes.push('QDRANT_UNIT_TYPE_DRIFT');
  if (record.chunk_payload.missing_unit_number > 0) codes.push('QDRANT_MISSING_UNIT_NUMBER');
  if (record.chunk_payload.unit_number_drift > 0) codes.push('QDRANT_UNIT_NUMBER_DRIFT');
  if (record.chunk_payload.missing_article_number > 0) codes.push('QDRANT_MISSING_ARTICLE_NUMBER');
  if (record.chunk_payload.article_number_drift > 0) codes.push('QDRANT_ARTICLE_NUMBER_DRIFT');
  if (record.chunk_payload.missing_r2_key > 0) codes.push('QDRANT_MISSING_R2_KEY');
  if (record.chunk_payload.missing_json_path > 0) codes.push('QDRANT_MISSING_JSON_PATH');
  if (record.chunk_payload.orphan_current_chunks > 0) codes.push('QDRANT_ORPHAN_CURRENT_CHUNKS');
  if (record.act_payload.missing_title > 0) codes.push('QDRANT_ACT_MISSING_TITLE');
  if (record.act_payload.missing_category > 0) codes.push('QDRANT_ACT_MISSING_CATEGORY');
  if (record.act_payload.missing_document_type > 0) codes.push('QDRANT_ACT_MISSING_DOCUMENT_TYPE');
  if (record.act_payload.missing_summary > 0) codes.push('QDRANT_ACT_MISSING_SUMMARY');
  if (record.act_payload.missing_keywords > 0) codes.push('QDRANT_ACT_MISSING_KEYWORDS');
  if (record.act_payload.missing_topics > 0) codes.push('QDRANT_ACT_MISSING_TOPICS');
  if (record.act_payload.missing_aliases > 0) codes.push('QDRANT_ACT_MISSING_ALIASES');
  if (record.act_payload.missing_validity_status > 0) codes.push('QDRANT_ACT_MISSING_VALIDITY_STATUS');
  if (record.act_payload.missing_r2_key > 0) codes.push('QDRANT_ACT_MISSING_R2_KEY');
  return codes;
}

function collectRecommendedActions(record: PayloadAuditRecord): string[] {
  const actions: string[] = [];
  if (record.qdrant.old_hash_acts > 0 || record.qdrant.old_hash_chunks > 0) {
    actions.push(`pnpm exec tsx scripts/legislation/admin-cli.ts repair qdrant-dedup --nreg "${record.rada_nreg}"`);
  }
  if (
    record.qdrant.current_hash_acts === 0 ||
    record.qdrant.current_hash_chunks === 0 ||
    record.chunk_payload.current_chunk_count_mismatch > 0 ||
    record.chunk_payload.missing_chunk_title > 0 ||
    record.chunk_payload.chunk_title_drift > 0 ||
    record.chunk_payload.missing_unit_type > 0 ||
    record.chunk_payload.unit_type_drift > 0 ||
    record.chunk_payload.missing_unit_number > 0 ||
    record.chunk_payload.unit_number_drift > 0 ||
    record.chunk_payload.missing_article_number > 0 ||
    record.chunk_payload.article_number_drift > 0 ||
    record.chunk_payload.missing_r2_key > 0 ||
    record.chunk_payload.missing_json_path > 0 ||
    record.act_payload.missing_summary > 0 ||
    record.act_payload.missing_keywords > 0 ||
    record.act_payload.missing_topics > 0 ||
    record.act_payload.missing_aliases > 0 ||
    record.act_payload.missing_validity_status > 0
  ) {
    actions.push(`pnpm exec tsx scripts/legislation/admin-cli.ts update --nreg "${record.rada_nreg}" --force`);
  }
  if (!record.canonical.found) {
    actions.push(`pnpm exec tsx scripts/legislation/admin-cli.ts inspect --nreg "${record.rada_nreg}"`);
  }
  return [...new Set(actions)];
}

function classifySeverity(issueCodes: string[]): 'CRITICAL' | 'WARN' | 'OK' {
  if (issueCodes.length === 0) return 'OK';
  if (
    issueCodes.some((code) =>
      [
        'R2_CANONICAL_MISSING',
        'QDRANT_CURRENT_ACT_MISSING',
        'QDRANT_CURRENT_CHUNKS_MISSING',
        'QDRANT_DUPLICATE_CURRENT_ACTS',
        'QDRANT_OLD_ACT_VERSIONS',
        'QDRANT_OLD_CHUNK_VERSIONS',
        'QDRANT_CURRENT_CHUNK_COUNT_MISMATCH',
        'QDRANT_CHUNK_TITLE_DRIFT',
        'QDRANT_UNIT_TYPE_DRIFT',
        'QDRANT_UNIT_NUMBER_DRIFT',
        'QDRANT_ARTICLE_NUMBER_DRIFT',
        'QDRANT_ORPHAN_CURRENT_CHUNKS',
      ].includes(code)
    )
  ) {
    return 'CRITICAL';
  }
  return 'WARN';
}

async function auditOneDocument(
  client: QdrantClient,
  doc: LegislationDocumentRow
): Promise<PayloadAuditRecord> {
  let canonicalFound = false;
  let canonicalChunks: CanonicalChunkLike[] = [];

  if (doc.r2_key) {
    try {
      const canonical = await getJsonFromR2(doc.r2_key);
      canonicalChunks = Array.isArray(canonical?.content?.chunks) ? canonical.content.chunks : [];
      canonicalFound = true;
    } catch {
      canonicalFound = false;
    }
  }

  const canonicalChunksByIndex = new Map<number, CanonicalChunkLike>();
  for (const chunk of canonicalChunks) {
    if (typeof chunk?.chunk_index === 'number') canonicalChunksByIndex.set(chunk.chunk_index, chunk);
  }

  const chunkPoints = await scrollAllPointsByNreg(client, QDRANT_COLLECTION_CHUNKS, doc.rada_nreg);
  const actPoints = await scrollAllPointsByNreg(client, QDRANT_COLLECTION_ACTS, doc.rada_nreg);
  const currentHash = normalizeText(doc.content_hash);

  const currentChunkPoints = chunkPoints.filter(
    (point) => normalizeText(point?.payload?.content_hash) === currentHash
  );
  const currentActPoints = actPoints.filter(
    (point) => normalizeText(point?.payload?.content_hash) === currentHash
  );
  const oldChunkPoints = chunkPoints.filter(
    (point) => hasValue(point?.payload?.content_hash) && normalizeText(point?.payload?.content_hash) !== currentHash
  );
  const oldActPoints = actPoints.filter(
    (point) => hasValue(point?.payload?.content_hash) && normalizeText(point?.payload?.content_hash) !== currentHash
  );

  const chunkHashCounts: Record<string, number> = {};
  const actHashCounts: Record<string, number> = {};
  for (const point of chunkPoints) addHashCount(chunkHashCounts, point?.payload?.content_hash);
  for (const point of actPoints) addHashCount(actHashCounts, point?.payload?.content_hash);

  const currentChunkIndicesSeen = new Set<number>();
  const chunkPayload: PayloadIssueCounts = {
    missing_chunk_title: 0,
    chunk_title_drift: 0,
    missing_unit_type: 0,
    unit_type_drift: 0,
    missing_unit_number: 0,
    unit_number_drift: 0,
    missing_article_number: 0,
    article_number_drift: 0,
    missing_r2_key: 0,
    missing_json_path: 0,
    orphan_current_chunks: 0,
    current_chunk_count_mismatch: 0,
  };

  for (const point of currentChunkPoints) {
    const payload = point?.payload ?? {};
    if (!hasValue(payload.r2_key)) chunkPayload.missing_r2_key += 1;
    if (!hasValue(payload.json_path)) chunkPayload.missing_json_path += 1;

    const chunkIndex = typeof payload.chunk_index === 'number' ? payload.chunk_index : null;
    if (chunkIndex == null || !canonicalChunksByIndex.has(chunkIndex)) {
      chunkPayload.orphan_current_chunks += 1;
      continue;
    }

    currentChunkIndicesSeen.add(chunkIndex);
    const canonicalChunk = canonicalChunksByIndex.get(chunkIndex);
    if (!canonicalChunk) continue;

    if (hasValue(canonicalChunk.title)) {
      if (!hasValue(payload.chunk_title)) chunkPayload.missing_chunk_title += 1;
      else if (!isEqualNormalized(payload.chunk_title, canonicalChunk.title)) chunkPayload.chunk_title_drift += 1;
    }

    if (hasValue(canonicalChunk.unit_type)) {
      if (!hasValue(payload.unit_type)) chunkPayload.missing_unit_type += 1;
      else if (!isEqualNormalized(payload.unit_type, canonicalChunk.unit_type)) chunkPayload.unit_type_drift += 1;
    }

    if (hasValue(canonicalChunk.unit_number)) {
      if (!hasValue(payload.unit_number)) chunkPayload.missing_unit_number += 1;
      else if (!isEqualNormalized(payload.unit_number, canonicalChunk.unit_number)) chunkPayload.unit_number_drift += 1;
    }

    if (hasValue(canonicalChunk.article_number)) {
      if (!hasValue(payload.article_number)) chunkPayload.missing_article_number += 1;
      else if (!isEqualNormalized(payload.article_number, canonicalChunk.article_number)) {
        chunkPayload.article_number_drift += 1;
      }
    }
  }

  if (canonicalFound && currentChunkPoints.length !== canonicalChunks.length) {
    chunkPayload.current_chunk_count_mismatch = Math.abs(currentChunkPoints.length - canonicalChunks.length);
  }

  const actPayload: ActPayloadIssueCounts = {
    missing_title: 0,
    missing_category: 0,
    missing_document_type: 0,
    missing_summary: 0,
    missing_keywords: 0,
    missing_topics: 0,
    missing_aliases: 0,
    missing_validity_status: 0,
    missing_r2_key: 0,
  };

  for (const point of currentActPoints) {
    const payload = point?.payload ?? {};
    if (!hasValue(payload.title)) actPayload.missing_title += 1;
    if (!hasValue(payload.category)) actPayload.missing_category += 1;
    if (!hasValue(payload.document_type)) actPayload.missing_document_type += 1;
    if (!hasValue(payload.summary)) actPayload.missing_summary += 1;
    if (!hasNonEmptyArray(payload.keywords)) actPayload.missing_keywords += 1;
    if (!hasNonEmptyArray(payload.topics)) actPayload.missing_topics += 1;
    if (!hasNonEmptyArray(payload.aliases)) actPayload.missing_aliases += 1;
    if (!hasValue(payload.validity_status)) actPayload.missing_validity_status += 1;
    if (!hasValue(payload.r2_key)) actPayload.missing_r2_key += 1;
  }

  const record: PayloadAuditRecord = {
    rada_nreg: doc.rada_nreg,
    title: doc.title ?? '',
    severity: 'OK',
    issue_codes: [],
    recommended_actions: [],
    doc: {
      content_hash: doc.content_hash,
      r2_key: doc.r2_key,
      expected_chunks: doc.expected_chunks,
      indexed_chunks: doc.indexed_chunks,
      qdrant_status: doc.qdrant_status,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
    },
    canonical: {
      found: canonicalFound,
      chunks_count: canonicalChunks.length,
    },
    qdrant: {
      current_hash_chunks: currentChunkPoints.length,
      current_hash_acts: currentActPoints.length,
      old_hash_chunks: oldChunkPoints.length,
      old_hash_acts: oldActPoints.length,
      chunk_hash_counts: chunkHashCounts,
      act_hash_counts: actHashCounts,
    },
    chunk_payload: chunkPayload,
    act_payload: actPayload,
  };

  record.issue_codes = collectIssueCodes(record);
  record.recommended_actions = collectRecommendedActions(record);
  record.severity = classifySeverity(record.issue_codes);
  return record;
}

function buildSummary(records: PayloadAuditRecord[]): AuditSummary {
  const issueCounts: Record<string, number> = {};
  for (const record of records) {
    for (const code of record.issue_codes) issueCounts[code] = (issueCounts[code] ?? 0) + 1;
  }
  const criticalDocs = records.filter((record) => record.severity === 'CRITICAL').length;
  const warnDocs = records.filter((record) => record.severity === 'WARN').length;
  const okDocs = records.filter((record) => record.severity === 'OK').length;
  return {
    total_docs: records.length,
    docs_with_issues: criticalDocs + warnDocs,
    critical_docs: criticalDocs,
    warn_docs: warnDocs,
    ok_docs: okDocs,
    issue_counts: issueCounts,
  };
}

function buildMarkdownReport(summary: AuditSummary, records: PayloadAuditRecord[]): string {
  const issueRows = records.filter((record) => record.issue_codes.length > 0);
  const topIssueLines = Object.entries(summary.issue_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `- ${code}: ${count}`)
    .join('\n');

  return [
    '# LLDBI Qdrant Payload Audit',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    `- Total docs: ${summary.total_docs}`,
    `- Docs with issues: ${summary.docs_with_issues}`,
    `- Critical: ${summary.critical_docs}`,
    `- Warn: ${summary.warn_docs}`,
    `- OK: ${summary.ok_docs}`,
    '',
    '## Top issue counts',
    topIssueLines || '- none',
    '',
    '## Documents with issues',
    '| nreg | severity | current acts/chunks | old acts/chunks | issue codes | actions |',
    '|------|----------|---------------------|-----------------|------------|---------|',
    ...issueRows.map((record) => {
      const current = `${record.qdrant.current_hash_acts}/${record.qdrant.current_hash_chunks}`;
      const old = `${record.qdrant.old_hash_acts}/${record.qdrant.old_hash_chunks}`;
      const codes = record.issue_codes.join(', ');
      const actions = record.recommended_actions.join('<br>');
      return `| ${record.rada_nreg} | ${record.severity} | ${current} | ${old} | ${codes} | ${actions} |`;
    }),
  ].join('\n');
}

export async function auditQdrantPayloadCompleteness(options?: {
  limit?: number;
  nregs?: string[];
  outputFile?: string;
  outputMarkdown?: string;
  concurrency?: number;
}): Promise<void> {
  const outputFile = resolve(process.cwd(), options?.outputFile ?? 'runs/audit/QDRANT_PAYLOAD_AUDIT.json');
  const outputMarkdown = resolve(
    process.cwd(),
    options?.outputMarkdown ?? 'runs/audit/QDRANT_PAYLOAD_AUDIT.md'
  );
  const concurrency = Math.max(1, options?.concurrency ?? 4);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Audit Qdrant Payload Completeness — LLDBI corpus hygiene');
  console.log('═══════════════════════════════════════════════════════════\n');

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from('legislation_documents')
    .select(
      'rada_nreg,title,content_hash,r2_key,expected_chunks,indexed_chunks,qdrant_status,category,document_type,validity_status'
    )
    .order('rada_nreg');

  if (options?.nregs?.length) query = query.in('rada_nreg', options.nregs);
  else if (options?.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch legislation_documents: ${error.message}`);

  const docs = ((data ?? []) as LegislationDocumentRow[]).filter((doc) => hasValue(doc.rada_nreg));
  console.log(`📋 Loaded ${docs.length} documents from Supabase`);
  console.log(`⚙️  Concurrency: ${concurrency}\n`);

  const qdrant = createQdrantClient();
  const records = await mapWithConcurrency(docs, concurrency, async (doc, index) => {
    process.stdout.write(`[${index + 1}/${docs.length}] ${doc.rada_nreg}... `);
    const record = await auditOneDocument(qdrant, doc);
    process.stdout.write(`${record.severity}${record.issue_codes.length ? ` (${record.issue_codes.length})` : ''}\n`);
    return record;
  });

  const summary = buildSummary(records);

  await mkdir(resolve(outputFile, '..'), { recursive: true });
  await writeFile(
    outputFile,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        summary,
        records,
      },
      null,
      2
    ),
    'utf8'
  );

  await mkdir(resolve(outputMarkdown, '..'), { recursive: true });
  await writeFile(outputMarkdown, buildMarkdownReport(summary, records), 'utf8');

  console.log('\n--- Payload Audit Summary ---');
  console.log(`total_docs: ${summary.total_docs}`);
  console.log(`docs_with_issues: ${summary.docs_with_issues}`);
  console.log(`critical_docs: ${summary.critical_docs}`);
  console.log(`warn_docs: ${summary.warn_docs}`);
  console.log(`ok_docs: ${summary.ok_docs}`);

  const topIssues = Object.entries(summary.issue_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (topIssues.length > 0) {
    console.log('\nTop issue codes:');
    for (const [code, count] of topIssues) console.log(`- ${code}: ${count}`);
  }

  console.log(`\nJSON report: ${outputFile}`);
  console.log(`Markdown report: ${outputMarkdown}`);
}
