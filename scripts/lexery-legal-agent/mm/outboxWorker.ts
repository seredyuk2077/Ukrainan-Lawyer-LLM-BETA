/**
 * MM Outbox Worker — processes pending mm_outbox events (write path for memory pipeline).
 *
 * Architecture: U12 Deliver → mm_outbox (pending) → THIS WORKER → mm_memory_items + mm_summaries + Qdrant
 *
 * Responsibilities per event (event_type='index_memory'):
 *   1. Mark event 'processing' (soft lock, idempotent)
 *   2. Extract facts via Haiku LLM (memoryExtractor)
 *   3. Embed each fact (OpenRouter text-embedding-3-small, 1536d)
 *   4. Insert mm_memory_items (with content_hash for dedup)
 *   5. Upsert to Qdrant lexery_memory_semantic_v1
 *   6. Upsert mm_summaries (per conversation_id)
 *   7. Mark event 'processed', set processed_at
 *
 * Idempotency:
 *   - content_hash dedup prevents duplicate mm_memory_items for same fact
 *   - Qdrant point id = memory_item_id (UUID, deterministic after insert)
 *   - 'processing' lock prevents duplicate in-flight processing
 *
 * Multi-tenant safety:
 *   - tenant_id always filtered; user_id always set from payload
 */
import { createHash, randomUUID } from 'crypto';
import { getSupabaseClient } from '../lib/supabase.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { checkMmOutboxLeaseSchema, MM_OUTBOX_SCHEMA_CHECK_FAILED } from './outboxSchema.js';
import { extractMemoryFacts } from './memoryExtractor.js';
import { embedQuery } from '../retrieval/embedding.js';
import { upsertMemoryVector } from './semanticSearch.js';
import { putMemoryOffload } from './offload.js';
import { normalizeMemorySummary, mergeRollingSummary, buildSummaryFromFacts } from '../write/memorySummary.js';

const MM_SUMMARY_MAX_CHARS = 500;

export const MAX_OUTBOX_RETRIES = 3;

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (/fetch failed|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|network|5\d{2}/i.test(msg)) return true;
  if (/rate\s*limit|429|503|502|504/i.test(msg)) return true;
  return false;
}

export async function withTransientOutboxIoRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 300
): Promise<T> {
  const maxAttempts = Math.max(1, attempts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

type SupabaseLikeResult = {
  error?: { message?: string | null } | null;
};

export async function withTransientOutboxResultRetry<T extends SupabaseLikeResult>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 300
): Promise<T> {
  return withTransientOutboxIoRetry(async () => {
    const result = await fn();
    if (result?.error) {
      throw new Error(result.error.message || 'Supabase request failed');
    }
    return result;
  }, attempts, baseDelayMs);
}

/** Clear lease and set terminal state (pending for retry or failed). */
async function setOutboxEventTerminalState(
  id: string,
  payload: Record<string, unknown>,
  status: 'failed' | 'pending',
  lastError: string,
  retryCount?: number
): Promise<void> {
  const sb = getSupabaseClient();
  const clearLease = {
    processing_started_at: null,
    lease_expires_at: null,
    worker_id: null,
    last_error: lastError,
    status,
  };
  const updatePayload =
    status === 'pending' && retryCount != null
      ? { ...clearLease, payload: { ...payload, retry_count: retryCount } }
      : clearLease;
  try {
    await sb.from('mm_outbox').update(updatePayload).eq('id', id);
  } catch {
    // non-fatal
  }
}

async function tryMarkOutboxEventDone(params: {
  id: string;
  clearLease: Record<string, unknown>;
  ctx: Record<string, unknown>;
  warnMessage: string;
}): Promise<void> {
  const sb = getSupabaseClient();
  try {
    await withTransientOutboxResultRetry(() =>
      sb
        .from('mm_outbox')
        .update({ status: 'done', processed_at: new Date().toISOString(), ...params.clearLease })
        .eq('id', params.id)
    );
  } catch (err) {
    logger.warn(params.warnMessage, {
      ...params.ctx,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface OutboxRow {
  id: string;
  conversation_id: string | null;
  tenant_id: string | null;
  run_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
  processing_started_at?: string | null;
  lease_expires_at?: string | null;
  attempt_count?: number;
  last_error?: string | null;
  worker_id?: string | null;
}

type MaterializationMode = 'memory' | 'mixed' | 'law' | 'unknown';

interface MaterializationPolicy {
  mode: MaterializationMode;
  extract_from: 'answer_summary' | 'user_query' | 'skip';
  allow_summary_fallback: boolean;
}

export function selectMaterializationPolicy(params: {
  contextMode?: string | null;
  memoryCount?: number | null;
  lawCount?: number | null;
}): MaterializationPolicy {
  const mode = params.contextMode === 'memory' || params.contextMode === 'mixed' || params.contextMode === 'law'
    ? params.contextMode
    : 'unknown';
  if (mode === 'memory') {
    return {
      mode,
      // Memory mode should materialize durable user facts, not re-store assistant recalls.
      extract_from: 'user_query',
      allow_summary_fallback: false,
    };
  }
  if (mode === 'mixed') {
    return {
      mode,
      // Mixed turns often contain the durable user/case facts we want to retain.
      // The extractor already returns [] for pure legal comparison/explanation turns,
      // so skipping here only drops legitimate facts from legal-heavy conversations.
      extract_from: 'user_query',
      allow_summary_fallback: false,
    };
  }
  if (mode === 'law') {
    return {
      mode,
      // Law turns can still carry explicit user facts (budget, dates, parties, documents).
      // We extract from the user message and rely on the stricter mixed-mode extractor
      // to ignore doctrine-only questions and return [] when nothing durable is stated.
      extract_from: 'user_query',
      allow_summary_fallback: false,
    };
  }
  return {
    mode,
    extract_from: 'skip',
    allow_summary_fallback: false,
  };
}

export interface WorkerRunResult {
  processed: number;
  failed: number;
  skipped: number;
  factsInserted: number;
  qdrantUpserted: number;
  r2OffloadCount: number;
}

/**
 * Process one batch of pending mm_outbox events.
 * When conversationId is set, fetches that conversation's pending rows first (wake-up path).
 */
export async function runOutboxWorkerBatch(params?: {
  batchSize?: number;
  runId?: string;
  /** When set, prioritize this conversation's pending rows (immediate wake-up after U12). */
  conversationId?: string | null;
}): Promise<WorkerRunResult> {
  const batchSize = params?.batchSize ?? config.mmOutboxBatchSize;
  const workerCtx = {
    module: 'mm/outboxWorker',
    worker_run_id: params?.runId,
    wake_up_conversation: params?.conversationId ?? undefined,
  };
  const sb = getSupabaseClient();
  const schemaCheck = await checkMmOutboxLeaseSchema();
  if (!schemaCheck.ready) {
    const code = schemaCheck.reason_code ?? MM_OUTBOX_SCHEMA_CHECK_FAILED;
    logger.error('mm_outbox_worker: schema check failed, failing closed', {
      ...workerCtx,
      reason_code: code,
      error_message: schemaCheck.error_message,
    });
    throw new Error(
      `${code}: ${schemaCheck.error_message ?? 'mm_outbox schema check failed (run migration 20260306100000_mm_outbox_lease.sql for lease columns)'}`
    );
  }

  const result: WorkerRunResult = { processed: 0, failed: 0, skipped: 0, factsInserted: 0, qdrantUpserted: 0, r2OffloadCount: 0 };

  // Reclaim: reset stale processing rows to pending (lease expired or legacy rows older than threshold)
  const now = new Date();
  const nowIso = now.toISOString();
  const staleThresholdMs = config.mmOutboxStaleProcessingThresholdSec * 1000;
  const staleThresholdIso = new Date(now.getTime() - staleThresholdMs).toISOString();
  try {
    await withTransientOutboxResultRetry(() =>
      sb
        .from('mm_outbox')
        .update({
          status: 'pending',
          processing_started_at: null,
          lease_expires_at: null,
          worker_id: null,
          last_error: null,
        })
        .eq('status', 'processing')
        .not('lease_expires_at', 'is', null)
        .lt('lease_expires_at', nowIso)
        .select('id')
    );
    await withTransientOutboxResultRetry(() =>
      sb
        .from('mm_outbox')
        .update({
          status: 'pending',
          processing_started_at: null,
          lease_expires_at: null,
          worker_id: null,
          last_error: null,
        })
        .eq('status', 'processing')
        .is('lease_expires_at', null)
        .lt('created_at', staleThresholdIso)
        .select('id')
    );
  } catch (e) {
    if (isTransientError(e)) {
      logger.warn('mm_outbox_worker: reclaim step degraded; continuing without reclaim this cycle', {
        ...workerCtx,
        error: e instanceof Error ? e.message : String(e),
      });
    } else {
      logger.error('mm_outbox_worker: reclaim step failed', { ...workerCtx, error: String(e) });
      throw e;
    }
  }

  let backlogBefore = 0;
  try {
    const countQ = sb.from('mm_outbox').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    const { count } = await withTransientOutboxResultRetry(() =>
      params?.conversationId ? countQ.eq('conversation_id', params.conversationId) : countQ
    );
    backlogBefore = typeof count === 'number' ? count : 0;
  } catch {
    // non-fatal
  }

  const leaseWindowSec = config.mmOutboxLeaseWindowSec;
  const leaseExpiresIso = new Date(now.getTime() + leaseWindowSec * 1000).toISOString();
  const workerId = params?.runId ?? randomUUID();

  let pendingQ = sb
    .from('mm_outbox')
    .select('id, conversation_id, tenant_id, run_id, event_type, payload, status, created_at, processing_started_at, lease_expires_at, attempt_count, last_error, worker_id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize);
  let expiredQ = sb
    .from('mm_outbox')
    .select('id, conversation_id, tenant_id, run_id, event_type, payload, status, created_at, processing_started_at, lease_expires_at, attempt_count, last_error, worker_id')
    .eq('status', 'processing')
    .lt('lease_expires_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(batchSize);
  if (params?.conversationId) {
    pendingQ = pendingQ.eq('conversation_id', params.conversationId);
    expiredQ = expiredQ.eq('conversation_id', params.conversationId);
  }
  const [pendingRes, expiredRes] = await Promise.all([
    withTransientOutboxResultRetry(() => pendingQ),
    withTransientOutboxResultRetry(() => expiredQ),
  ]);
  const pendingRows = (pendingRes.data ?? []) as OutboxRow[];
  const expiredRows = (expiredRes.data ?? []) as OutboxRow[];
  const candidates = [...pendingRows, ...expiredRows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  ).slice(0, batchSize);

  const rows: OutboxRow[] = [];
  for (const r of candidates) {
    let claimQ = sb
      .from('mm_outbox')
      .update({
        status: 'processing',
        processing_started_at: nowIso,
        lease_expires_at: leaseExpiresIso,
        attempt_count: (r.attempt_count ?? 0) + 1,
        worker_id: workerId,
        last_error: null,
      })
      .eq('id', r.id)
      .eq('status', r.status);
    if (r.status === 'processing') {
      claimQ = claimQ.lt('lease_expires_at', nowIso);
    }
    const { data: claimed } = await withTransientOutboxResultRetry(() =>
      claimQ.select(
        'id, conversation_id, tenant_id, run_id, event_type, payload, status, created_at, processing_started_at, lease_expires_at, attempt_count, last_error, worker_id'
      )
    );
    if (claimed && claimed.length > 0) {
      rows.push(claimed[0] as OutboxRow);
    }
  }
  if (!rows || rows.length === 0) {
    logger.debug('mm_outbox_worker: no pending events', workerCtx);
    return result;
  }

  logger.info('mm_outbox_worker: processing batch', {
    ...workerCtx,
    count: rows.length,
    backlog_before: backlogBefore,
    priority_conversation_used: !!params?.conversationId,
  });

  const maxAttempts = config.mmOutboxMaxAttempts;
  for (const row of rows as OutboxRow[]) {
    const eventCtx = { ...workerCtx, event_id: row.id, event_type: row.event_type };
    try {
      await processOutboxEvent(row, eventCtx, result);
    } catch (err) {
      result.failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      const reasonCode = isTransientError(err) ? 'TRANSIENT' : 'DETERMINISTIC';
      const attemptCount = row.attempt_count ?? 1;
      const retryCount = (typeof (row.payload?.retry_count) === 'number' ? row.payload.retry_count : 0) + (reasonCode === 'TRANSIENT' ? 1 : 0);
      const terminalStatus =
        reasonCode === 'DETERMINISTIC' || attemptCount >= maxAttempts ? 'failed' : 'pending';
      logger.error('mm_outbox_worker: event processing failed', {
        ...eventCtx,
        reason_code: reasonCode,
        attempt_count: attemptCount,
        terminal_status: terminalStatus,
        error: errMsg,
      });
      await setOutboxEventTerminalState(
        row.id,
        row.payload ?? {},
        terminalStatus,
        errMsg,
        reasonCode === 'TRANSIENT' ? retryCount : undefined
      );
    }
  }

  let backlogAfter = 0;
  try {
    const countQuery = sb.from('mm_outbox').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    const { count } = await withTransientOutboxResultRetry(() =>
      params?.conversationId
        ? countQuery.eq('conversation_id', params.conversationId)
        : countQuery
    );
    backlogAfter = typeof count === 'number' ? count : 0;
  } catch {
    // non-fatal
  }

  logger.info('mm_outbox_worker: batch complete', {
    ...workerCtx,
    processed: result.processed,
    failed: result.failed,
    backlog_before: backlogBefore,
    backlog_after: backlogAfter,
    facts_inserted: result.factsInserted,
    qdrant_upserted: result.qdrantUpserted,
    r2_offload_count: result.r2OffloadCount,
  });

  return result;
}

async function processOutboxEvent(
  row: OutboxRow,
  ctx: Record<string, unknown>,
  result: WorkerRunResult
): Promise<void> {
  const sb = getSupabaseClient();
  const clearLease = {
    processing_started_at: null,
    lease_expires_at: null,
    worker_id: null,
    last_error: null,
  };

  if (row.event_type !== 'index_memory') {
    await tryMarkOutboxEventDone({
      id: row.id,
      clearLease,
      ctx,
      warnMessage: 'mm_outbox_worker: failed to mark non-index event done',
    });
    result.processed++;
    return;
  }

  // Extract context from row + payload
  const payload = row.payload ?? {};
  const conversationId = (row.conversation_id ?? payload['conversation_id'] as string ?? null);
  const tenantId = (row.tenant_id ?? payload['tenant_id'] as string ?? null);
  const runId = (row.run_id ?? payload['run_id'] as string ?? null);
  const userId = (payload['user_id'] as string) ?? null;
  const answerSummary = (payload['answer_summary'] as string) ?? '';
  const userQuery = (payload['user_query'] as string) ?? '';
  const payloadSourceSummary =
    payload['source_summary'] && typeof payload['source_summary'] === 'object'
      ? (payload['source_summary'] as { context_mode?: string | null; memory_count?: number | null; law_count?: number | null })
      : null;
  const policy = selectMaterializationPolicy({
    contextMode: payloadSourceSummary?.context_mode ?? null,
    memoryCount: payloadSourceSummary?.memory_count ?? null,
    lawCount: payloadSourceSummary?.law_count ?? null,
  });
  const extractionInput =
    policy.extract_from === 'answer_summary'
      ? answerSummary
      : policy.extract_from === 'user_query'
        ? normalizeMemorySummary(userQuery, MM_SUMMARY_MAX_CHARS)
        : '';

  if (!extractionInput) {
    logger.debug('mm_outbox_worker: materialization skipped or empty input', {
      ...ctx,
      materialization_mode: policy.mode,
      extract_from: policy.extract_from,
    });
    await tryMarkOutboxEventDone({
      id: row.id,
      clearLease,
      ctx,
      warnMessage: 'mm_outbox_worker: failed to mark skipped event done',
    });
    result.processed++;
    return;
  }

  // Step 1: Extract facts via LLM
  const extraction = await extractMemoryFacts({
    answerSummary: extractionInput,
    userQuery: policy.extract_from === 'answer_summary' ? (userQuery || undefined) : undefined,
    runId: runId || undefined,
    mode: policy.extract_from === 'user_query' ? 'user_message_mixed' : 'answer_summary',
  });

  const facts = extraction.facts;
  logger.debug('mm_outbox_worker: extracted facts', { ...ctx, count: facts.length, model: extraction.modelUsed });

  // Step 2: For each fact — embed + insert mm_memory_items + upsert Qdrant
  const insertedIds: string[] = [];
  for (const fact of facts) {
    let contentToStore = fact;
    let r2Key: string | null = null;
    const factHash = createHash('sha256').update(fact).digest('hex').slice(0, 16);
    const contentHash = `${conversationId ?? 'global'}:${factHash}`;

    // Dedup: check if we already have this content_hash
    const { data: existing } = await sb
      .from('mm_memory_items')
      .select('id')
      .eq('content_hash', contentHash)
      .maybeSingle();

    let memoryItemId: string;
    if (existing?.id) {
      memoryItemId = existing.id;
      logger.debug('mm_outbox_worker: fact already exists (skipping insert)', { ...ctx, content_hash: contentHash });
    } else {
      // Offload policy: content > threshold → R2; Supabase keeps preview + pointer
      const threshold = config.mmOffloadThresholdChars;
      const previewChars = config.mmOffloadPreviewChars;
      const shouldOffload = config.mmOffloadEnabled && fact.length > threshold;
      let contentSize: number = fact.length;
      memoryItemId = '';

      if (shouldOffload) {
        memoryItemId = randomUUID();
        const offloadResult = await putMemoryOffload({
          tenantId,
          memoryItemId,
          content: fact,
          contentHash: contentHash,
        });
        if (offloadResult.success && offloadResult.r2_key) {
          r2Key = offloadResult.r2_key;
          contentToStore = fact.slice(0, previewChars) + (fact.length > previewChars ? '…' : '');
          contentSize = fact.length;
          result.r2OffloadCount++;
          logger.debug('mm_outbox_worker: offloaded to R2', { ...ctx, r2_key: r2Key });
        } else {
          logger.warn('mm_outbox_worker: offload failed, storing full content in Supabase', {
            ...ctx,
            error: offloadResult.error,
          });
          memoryItemId = ''; // force insert to generate id below
        }
      }

      const insertPayload: Record<string, unknown> = {
        ...(r2Key && memoryItemId ? { id: memoryItemId } : {}),
        tenant_id: tenantId,
        user_id: userId,
        conversation_id: conversationId,
        scope_type: 'conversation',
        scope_id: conversationId ?? 'global',
        content: contentToStore,
        content_hash: contentHash,
        content_size: contentSize,
        ...(r2Key ? { r2_key: r2Key } : {}),
        metadata: {
          source_run_id: runId,
          confidence: 0.8,
          tags: ['auto_extracted'],
          extraction_model: extraction.modelUsed,
        },
        created_at: new Date().toISOString(),
      };
      if (!insertPayload.id) delete insertPayload.id;

      const { data: inserted, error: insertErr } = await sb
        .from('mm_memory_items')
        .insert(insertPayload)
        .select('id')
        .single();

      if (insertErr || !inserted) {
        logger.warn('mm_outbox_worker: failed to insert mm_memory_item', {
          ...ctx,
          error: insertErr?.message,
          content_hash: contentHash,
        });
        continue;
      }

      memoryItemId = inserted.id;
      result.factsInserted++;
      logger.debug('mm_outbox_worker: inserted mm_memory_item', { ...ctx, id: memoryItemId, offloaded: !!r2Key });
    }

    insertedIds.push(memoryItemId);

    // Upsert to Qdrant (non-fatal, 1 retry on transient)
    if (config.memoryQdrantUrl && userId) {
      const embedText = fact.slice(0, config.mmEmbeddingMaxChars);
      let upserted = false;
      for (let attempt = 0; attempt <= 1 && !upserted; attempt++) {
        try {
          const embed = await embedQuery(embedText);
          upserted = await upsertMemoryVector({
            memoryItemId,
            vector: embed.embedding,
            tenantId,
            userId: userId ?? '',
            conversationId,
            createdAt: new Date().toISOString(),
            tags: ['auto_extracted'],
            preview: contentToStore?.slice(0, 150),
            r2_key: r2Key ?? undefined,
          });
          if (upserted) result.qdrantUpserted++;
        } catch (e) {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
          else
            logger.warn('mm_outbox_worker: Qdrant upsert failed (non-fatal)', {
              ...ctx,
              memory_item_id: memoryItemId,
              error: e instanceof Error ? e.message : String(e),
            });
        }
      }
    }
  }

  // Step 3: Upsert mm_summaries — prefer factual summary from extracted facts; fallback to normalized answer
  if (conversationId) {
    const summaryChunk =
      facts.length > 0
        ? buildSummaryFromFacts(facts, MM_SUMMARY_MAX_CHARS)
        : policy.allow_summary_fallback && answerSummary
          ? normalizeMemorySummary(answerSummary, MM_SUMMARY_MAX_CHARS)
          : '';
    if (summaryChunk) {
      await upsertConversationSummary({
        conversationId,
        tenantId,
        userId: userId || undefined,
        summaryText: summaryChunk,
        messageIds: runId ? [runId] : [],
      });
    }
  }

  // Step 4: Mark event done and clear lease
  await tryMarkOutboxEventDone({
    id: row.id,
    clearLease,
    ctx,
    warnMessage: 'mm_outbox_worker: failed to mark event done (lease will expire and row can be reclaimed)',
  });

  result.processed++;
  logger.info('mm_outbox_worker: event processed', {
    ...ctx,
    facts_count: facts.length,
    inserted_ids: insertedIds.length,
  });
}

async function upsertConversationSummary(params: {
  conversationId: string;
  tenantId: string | null;
  userId?: string;
  summaryText: string;
  messageIds: string[];
}): Promise<void> {
  const sb = getSupabaseClient();
  const { conversationId, tenantId, userId, summaryText, messageIds } = params;

  // Lookup by conversation_id + tenant_id + user_id (tenant isolation)
  let summaryQuery = sb
    .from('mm_summaries')
    .select('id, summary_text, message_ids')
    .eq('conversation_id', conversationId);
  if (tenantId != null && tenantId !== '') {
    summaryQuery = summaryQuery.eq('tenant_id', tenantId);
  } else {
    summaryQuery = summaryQuery.is('tenant_id', null);
  }
  if (userId != null && userId !== '') {
    summaryQuery = summaryQuery.eq('user_id', userId);
  } else {
    summaryQuery = summaryQuery.is('user_id', null);
  }
  const { data: existing } = await summaryQuery.maybeSingle();

  if (existing) {
    const merged = mergeRollingSummary(
      String(existing.summary_text ?? ''),
      summaryText,
      MM_SUMMARY_MAX_CHARS
    );
    const existingIds = Array.isArray(existing.message_ids) ? existing.message_ids : [];
    const mergedIds = Array.from(new Set([...existingIds, ...messageIds])).slice(-20);
    await sb
      .from('mm_summaries')
      .update({ summary_text: merged, message_ids: mergedIds, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await sb.from('mm_summaries').insert({
      conversation_id: conversationId,
      tenant_id: tenantId,
      user_id: userId,
      scope: 'conversation',
      summary_text: summaryText,
      message_ids: messageIds,
      updated_at: new Date().toISOString(),
    });
  }
}
