import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { config } from '../../lib/config.js';
import type { MmDocRecordInput, MmDocScopeType, MmDocStatus } from './types.js';

export interface MmDocRecordRow {
  id: string;
  tenant_id: string | null;
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  scope_type: MmDocScopeType;
  scope_id: string | null;
  source_kind: string;
  source_run_id: string | null;
  original_filename: string;
  content_type: string | null;
  content_sha256: string;
  raw_r2_key: string;
  canonical_r2_key: string | null;
  parser_format: string | null;
  parser_warnings: string[] | null;
  chunk_count: number | null;
  status: MmDocStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

let readinessPromise: Promise<void> | null = null;
const DOC_SCOPE_AVAILABILITY_TTL_MS = 60_000;
const docScopeAvailabilityCache = new Map<
  string,
  {
    expiresAt: number;
    value: MmDocScopeAvailability;
  }
>();
let ingestLogPruneRunning = false;
let ingestLogPruneNextAllowedAt = 0;

export interface MmDocScopeAvailability {
  conversation: boolean;
  project: boolean;
  user_global: boolean;
}

const MAX_PARSER_WARNING_COUNT = 8;
const MAX_PARSER_WARNING_LENGTH = 240;
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_LOG_MESSAGE_LENGTH = 1000;
const MAX_ORIGINAL_FILENAME_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 255;
const MAX_R2_KEY_LENGTH = 1024;
const MAX_METRICS_KEYS = 16;
const MAX_METRIC_STRING_LENGTH = 256;
const MAX_METRIC_ARRAY_LENGTH = 8;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export interface MmDocIngestLogRowRef {
  id: string;
  created_at: string;
}

export function isTransientMmDocStoreError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|503|502|429|network/i.test(msg);
}

export async function withTransientMmDocStoreRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 250
): Promise<T> {
  const maxAttempts = Math.max(1, attempts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientMmDocStoreError(err) || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function trimStoredText(value: string | null | undefined, maxLength: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function normalizeRequiredStoredText(value: string | null | undefined, maxLength: number, field: string): string {
  const normalized = trimStoredText(value, maxLength);
  if (!normalized) {
    throw new Error(`MM Docs ${field} is required`);
  }
  return normalized;
}

function normalizeR2Key(value: string | null | undefined, field: string): string {
  const normalized = normalizeRequiredStoredText(value, MAX_R2_KEY_LENGTH, field);
  if (/^https?:\/\//i.test(normalized)) {
    throw new Error(`MM Docs ${field} must store an internal R2 key, not a URL`);
  }
  return normalized;
}

function sanitizeParserWarnings(warnings: string[] | null | undefined): string[] | null {
  if (!warnings?.length) return null;
  const cleaned = warnings
    .map((warning) => trimStoredText(warning, MAX_PARSER_WARNING_LENGTH))
    .filter((warning): warning is string => Boolean(warning))
    .slice(0, MAX_PARSER_WARNING_COUNT);
  return cleaned.length ? cleaned : null;
}

function sanitizeMetricValue(value: unknown, depth = 0): unknown {
  if (value == null) return null;
  if (typeof value === 'string') return trimStoredText(value, MAX_METRIC_STRING_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_METRIC_ARRAY_LENGTH)
      .map((item) => sanitizeMetricValue(item, depth + 1))
      .filter((item) => item !== null && item !== undefined);
  }
  if (typeof value === 'object') {
    if (depth >= 1) {
      return trimStoredText(JSON.stringify(value), MAX_METRIC_STRING_LENGTH);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_METRICS_KEYS)) {
      const sanitized = sanitizeMetricValue(entry, depth + 1);
      if (sanitized !== null && sanitized !== undefined) {
        out[key] = sanitized;
      }
    }
    return out;
  }
  return trimStoredText(String(value), MAX_METRIC_STRING_LENGTH);
}

function sanitizeMetrics(metrics: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metrics) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metrics).slice(0, MAX_METRICS_KEYS)) {
    const sanitized = sanitizeMetricValue(value);
    if (sanitized !== null && sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return Object.keys(out).length ? out : null;
}

function buildAvailabilityCacheKey(params: {
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
}): string {
  return [
    params.tenantId ?? 'global',
    params.userId,
    params.conversationId ?? 'no-conversation',
    params.projectId ?? 'no-project',
  ].join('::');
}

function clearMmDocScopeAvailabilityCache(): void {
  docScopeAvailabilityCache.clear();
}

export function selectMmDocIngestLogIdsToPrune(params: {
  oldestRows: MmDocIngestLogRowRef[];
  totalRows: number;
  nowMs: number;
  retentionDays: number;
  maxRows: number;
  batchSize: number;
}): string[] {
  const batchSize = Math.max(1, params.batchSize);
  const cutoffMs = params.nowMs - Math.max(1, params.retentionDays) * 24 * 60 * 60 * 1000;
  const expired = params.oldestRows.filter((row) => {
    const createdMs = Date.parse(row.created_at);
    return Number.isFinite(createdMs) && createdMs <= cutoffMs;
  });
  if (expired.length > 0) {
    return expired.slice(0, batchSize).map((row) => row.id);
  }

  const overflow = Math.max(0, params.totalRows - Math.max(1, params.maxRows));
  if (overflow <= 0) return [];
  return params.oldestRows.slice(0, Math.min(batchSize, overflow)).map((row) => row.id);
}

async function maybePruneMmDocIngestLog(): Promise<void> {
  const nowMs = Date.now();
  if (ingestLogPruneRunning || nowMs < ingestLogPruneNextAllowedAt) return;
  ingestLogPruneRunning = true;
  ingestLogPruneNextAllowedAt = nowMs + config.mmDocsIngestLogPruneCooldownMs;
  try {
    await ensureMmDocTablesReady();
    const sb = getSupabaseClient();
    const [{ count, error: countError }, { data: oldestRows, error: rowsError }] = await Promise.all([
      withTransientMmDocStoreRetry(() =>
        sb.from('mm_doc_ingest_log').select('id', { count: 'exact', head: true })
      ),
      withTransientMmDocStoreRetry(() =>
        sb
          .from('mm_doc_ingest_log')
          .select('id,created_at')
          .order('created_at', { ascending: true })
          .limit(config.mmDocsIngestLogPruneBatch)
      ),
    ]);
    if (countError) throw new Error(`mm_doc_ingest_log count failed: ${countError.message}`);
    if (rowsError) throw new Error(`mm_doc_ingest_log oldest-row scan failed: ${rowsError.message}`);

    const idsToDelete = selectMmDocIngestLogIdsToPrune({
      oldestRows: (oldestRows ?? []) as MmDocIngestLogRowRef[],
      totalRows: count ?? 0,
      nowMs,
      retentionDays: config.mmDocsIngestLogRetentionDays,
      maxRows: config.mmDocsIngestLogMaxRows,
      batchSize: config.mmDocsIngestLogPruneBatch,
    });
    if (idsToDelete.length === 0) return;

    const { error: deleteError } = await withTransientMmDocStoreRetry(() =>
      sb.from('mm_doc_ingest_log').delete().in('id', idsToDelete)
    );
    if (deleteError) {
      throw new Error(`mm_doc_ingest_log prune delete failed: ${deleteError.message}`);
    }
  } catch (error) {
    logger.warn('mm_docs: ingest log prune failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ingestLogPruneRunning = false;
  }
}

function isMissingTableError(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(
    error &&
      (error.code === 'PGRST205' ||
        String(error.message || '').includes("Could not find the table 'public.mm_doc_records'") ||
        String(error.message || '').includes("Could not find the table 'public.mm_doc_ingest_log'"))
  );
}

async function assertTableVisible(table: 'mm_doc_records' | 'mm_doc_ingest_log'): Promise<void> {
  const sb = getSupabaseClient();
  const { error } = await withTransientMmDocStoreRetry(() => sb.from(table).select('id').limit(1));
  if (!error) return;
  if (isMissingTableError(error)) {
    throw new Error(
      `MM Docs table ${table} is not visible in the current Lexery DB REST schema. ` +
      'Apply the MM Docs migration to the real Lexery Legal Agent DB project or reload the schema cache there.'
    );
  }
  throw new Error(`${table} readiness check failed: ${error.message}`);
}

export async function ensureMmDocTablesReady(): Promise<void> {
  if (!readinessPromise) {
    readinessPromise = (async () => {
      await assertTableVisible('mm_doc_records');
      await assertTableVisible('mm_doc_ingest_log');
    })();
  }
  try {
    await readinessPromise;
  } catch (err) {
    readinessPromise = null;
    throw err;
  }
}

export async function createMmDocRecord(input: MmDocRecordInput): Promise<MmDocRecordRow> {
  await ensureMmDocTablesReady();
  const sb = getSupabaseClient();
  const now = new Date().toISOString();
  if (!SHA256_HEX_RE.test(input.content_sha256)) {
    throw new Error('MM Docs content_sha256 must be a 64-char hex digest');
  }
  const row = {
    id: randomUUID(),
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    project_id: input.project_id ?? null,
    conversation_id: input.conversation_id ?? null,
    scope_type: input.scope.type,
    scope_id: input.scope.id,
    source_kind: input.source_kind,
    source_run_id: input.source_run_id ?? null,
    original_filename: normalizeRequiredStoredText(input.original_filename, MAX_ORIGINAL_FILENAME_LENGTH, 'original_filename'),
    content_type: trimStoredText(input.content_type, MAX_CONTENT_TYPE_LENGTH),
    content_sha256: input.content_sha256.toLowerCase(),
    raw_r2_key: normalizeR2Key(input.raw_r2_key, 'raw_r2_key'),
    canonical_r2_key: input.canonical_r2_key ? normalizeR2Key(input.canonical_r2_key, 'canonical_r2_key') : null,
    parser_format: input.parser_format ?? null,
    parser_warnings: sanitizeParserWarnings(input.parser_warnings),
    chunk_count: input.chunk_count ?? null,
    status: input.status ?? 'pending',
    error_message: trimStoredText(input.error_message, MAX_ERROR_MESSAGE_LENGTH),
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await withTransientMmDocStoreRetry(() =>
    sb.from('mm_doc_records').insert(row).select('*').single()
  );
  if (error) throw new Error(`mm_doc_records insert failed: ${error.message}`);
  clearMmDocScopeAvailabilityCache();
  return data as MmDocRecordRow;
}

export async function findMmDocRecordByRawR2Key(params: {
  tenantId: string | null;
  userId: string;
  rawR2Key: string;
}): Promise<MmDocRecordRow | null> {
  await ensureMmDocTablesReady();
  const sb = getSupabaseClient();
  let query = sb
    .from('mm_doc_records')
    .select('*')
    .eq('user_id', params.userId)
    .eq('raw_r2_key', params.rawR2Key)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (params.tenantId) query = query.eq('tenant_id', params.tenantId);
  else query = query.is('tenant_id', null);
  const { data, error } = await withTransientMmDocStoreRetry(() => query.maybeSingle());
  if (error) throw new Error(`mm_doc_records raw_r2_key lookup failed: ${error.message}`);
  return (data as MmDocRecordRow | null) ?? null;
}

export async function updateMmDocRecord(
  docId: string,
  patch: Partial<Pick<
    MmDocRecordRow,
    'canonical_r2_key' | 'parser_format' | 'parser_warnings' | 'chunk_count' | 'status' | 'error_message'
  >>
): Promise<void> {
  const sb = getSupabaseClient();
  const { error } = await withTransientMmDocStoreRetry(() =>
    sb
      .from('mm_doc_records')
      .update({
        ...patch,
        canonical_r2_key: patch.canonical_r2_key === undefined
          ? undefined
          : patch.canonical_r2_key === null
            ? null
            : normalizeR2Key(patch.canonical_r2_key, 'canonical_r2_key'),
        parser_warnings: patch.parser_warnings === undefined ? undefined : sanitizeParserWarnings(patch.parser_warnings),
        error_message: patch.error_message === undefined ? undefined : trimStoredText(patch.error_message, MAX_ERROR_MESSAGE_LENGTH),
        updated_at: new Date().toISOString(),
      })
      .eq('id', docId)
  );
  if (error) throw new Error(`mm_doc_records update failed: ${error.message}`);
  clearMmDocScopeAvailabilityCache();
}

export async function logMmDocEvent(params: {
  docId?: string | null;
  tenantId: string | null;
  userId: string;
  runId?: string | null;
  stage: string;
  status: 'ok' | 'warn' | 'error';
  message?: string | null;
  metrics?: Record<string, unknown> | null;
}): Promise<void> {
  await ensureMmDocTablesReady();
  const sb = getSupabaseClient();
  const { error } = await withTransientMmDocStoreRetry(() =>
    sb.from('mm_doc_ingest_log').insert({
      id: randomUUID(),
      doc_id: params.docId ?? null,
      tenant_id: params.tenantId,
      user_id: params.userId,
      run_id: params.runId ?? null,
      stage: normalizeRequiredStoredText(params.stage, 64, 'log_stage'),
      status: params.status,
      message: trimStoredText(params.message, MAX_LOG_MESSAGE_LENGTH),
      metrics: sanitizeMetrics(params.metrics),
      created_at: new Date().toISOString(),
    })
  );
  if (error) throw new Error(`mm_doc_ingest_log insert failed: ${error.message}`);
  void maybePruneMmDocIngestLog();
}

export async function listMmDocsForScope(params: {
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
}): Promise<MmDocRecordRow[]> {
  await ensureMmDocTablesReady();
  const sb = getSupabaseClient();
  const rows: MmDocRecordRow[] = [];

  const scopedQuery = async (scopeType: MmDocScopeType, scopeId?: string | null): Promise<void> => {
    let query = sb
      .from('mm_doc_records')
      .select('*')
      .eq('user_id', params.userId)
      .eq('scope_type', scopeType)
      .eq('status', 'indexed')
      .order('updated_at', { ascending: false });
    if (params.tenantId) query = query.eq('tenant_id', params.tenantId);
    else query = query.is('tenant_id', null);
    if (scopeId == null) query = query.is('scope_id', null);
    else query = query.eq('scope_id', scopeId);
    const { data, error } = await withTransientMmDocStoreRetry(() => query);
    if (error) throw new Error(`mm_doc_records scope query failed: ${error.message}`);
    rows.push(...((data ?? []) as MmDocRecordRow[]));
  };

  if (params.conversationId) await scopedQuery('conversation', params.conversationId);
  if (params.projectId) await scopedQuery('project', params.projectId);
  await scopedQuery('user_global', null);

  return rows;
}

async function hasIndexedMmDocsInScope(params: {
  tenantId: string | null;
  userId: string;
  scopeType: MmDocScopeType;
  scopeId?: string | null;
}): Promise<boolean> {
  await ensureMmDocTablesReady();
  const sb = getSupabaseClient();
  let query = sb
    .from('mm_doc_records')
    .select('id')
    .eq('user_id', params.userId)
    .eq('scope_type', params.scopeType)
    .eq('status', 'indexed')
    .limit(1);
  if (params.tenantId) query = query.eq('tenant_id', params.tenantId);
  else query = query.is('tenant_id', null);
  if (params.scopeId == null) query = query.is('scope_id', null);
  else query = query.eq('scope_id', params.scopeId);
  const { data, error } = await withTransientMmDocStoreRetry(() => query);
  if (error) {
    throw new Error(
      `mm_doc_records scope availability query failed (${params.scopeType}): ${error.message}`
    );
  }
  return (data ?? []).length > 0;
}

export async function getMmDocScopeAvailability(params: {
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
}): Promise<MmDocScopeAvailability> {
  const cacheKey = buildAvailabilityCacheKey(params);
  const cached = docScopeAvailabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const availability: MmDocScopeAvailability = {
    conversation: false,
    project: false,
    user_global: false,
  };

  const [conversation, project, userGlobal] = await Promise.all([
    params.conversationId
      ? hasIndexedMmDocsInScope({
          tenantId: params.tenantId,
          userId: params.userId,
          scopeType: 'conversation',
          scopeId: params.conversationId,
        })
      : Promise.resolve(false),
    params.projectId
      ? hasIndexedMmDocsInScope({
          tenantId: params.tenantId,
          userId: params.userId,
          scopeType: 'project',
          scopeId: params.projectId,
        })
      : Promise.resolve(false),
    hasIndexedMmDocsInScope({
      tenantId: params.tenantId,
      userId: params.userId,
      scopeType: 'user_global',
      scopeId: null,
    }),
  ]);

  availability.conversation = conversation;
  availability.project = project;
  availability.user_global = userGlobal;

  docScopeAvailabilityCache.set(cacheKey, {
    expiresAt: Date.now() + DOC_SCOPE_AVAILABILITY_TTL_MS,
    value: availability,
  });
  return availability;
}
