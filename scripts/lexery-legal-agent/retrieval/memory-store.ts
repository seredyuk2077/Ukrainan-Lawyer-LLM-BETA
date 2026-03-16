/**
 * U4 Memory Store — fetch recent mm_memory_items + mm_summaries for tenant+user from Supabase.
 * Phase 2: also fetches semantic memory from Qdrant when MEMORY_SEMANTIC_ENABLED=true.
 * Non-fatal: any failure sets degraded=true and returns empty array; pipeline continues.
 * Multi-tenant safe: always filters by both tenant_id AND user_id.
 *
 * Tables live in the same Supabase project as `runs` (supabaseUrl / supabaseServiceKey).
 * Write path (MM_OUTBOX) is managed by MM Outbox Worker.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { MemoryRef } from '../assemble/types.js';
import { searchMemorySemantic } from '../mm/semanticSearch.js';
import { getMemoryOffload } from '../mm/offload.js';

/** Memory scope: conversation-first (default), optional user-global fallback, or mixed (explicit). */
export type MemoryScopeMode = 'conversation_only' | 'user_global_fallback' | 'mixed_scope';

export interface FetchRecentMemoryParams {
  tenantId: string | null;
  userId: string;
  /** Current conversation; when set, primary path filters by it. */
  conversationId?: string | null;
  /** Scope model: conversation_only (default when conversationId set), user_global_fallback, mixed_scope. */
  scopeMode?: MemoryScopeMode;
  /** Query text used for semantic memory search. Required when memorySemanticEnabled. */
  queryText?: string;
  /** Max items to fetch. Default: config.memoryRecentLimit */
  limit?: number;
  /** Timeout in ms. Default: config.memoryRecentTimeoutMs */
  timeoutMs?: number;
  runId?: string;
}

/** Optional dependency injection for tests only. */
export interface FetchRecentMemoryInject {
  searchMemorySemantic?: (params: Parameters<typeof searchMemorySemantic>[0]) => ReturnType<typeof searchMemorySemantic>;
}

export interface FetchRecentMemoryResult {
  refs: MemoryRef[];
  summaryText?: string;
  degraded: boolean;
  degraded_reason_codes?: string[];
  latency_ms: number;
  semantic_count?: number;
  recent_count?: number;
  /** For observability / memory_trace. */
  supabase_latency_ms?: number;
  qdrant_latency_ms?: number;
  offload_loaded_count?: number;
  offload_load_latency_ms?: number;
  /** Scope observability: primary scope used. */
  scope_primary?: 'conversation' | 'user_global';
  /** True when user_global fallback was used (cross-conversation items included). */
  scope_fallback_used?: boolean;
  conversation_recent_count?: number;
  conversation_semantic_count?: number;
  global_recent_count?: number;
  global_semantic_count?: number;
  /** Conversation IDs of fallback items when scope_fallback_used. */
  fallback_conversation_ids?: string[];
}

/**
 * Lazily created Supabase client (re-uses existing project credentials).
 * No separate "Memory Supabase project" needed — mm_memory_items is in the same DB as runs.
 */
function getSupabaseClient() {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    return null;
  }
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

let _sbClient: ReturnType<typeof createClient> | null | undefined;
function getOrCreateClient() {
  if (_sbClient === undefined) {
    _sbClient = getSupabaseClient();
  }
  return _sbClient;
}

/**
 * Fetch recent memory items for a tenant+user from mm_memory_items + mm_summaries.
 * Phase 2: also performs semantic Qdrant search when MEMORY_SEMANTIC_ENABLED=true.
 * Returns empty refs on any failure (degraded=true).
 * Always enforces tenant_id + user_id isolation.
 */
const GLOBAL_FALLBACK_LIMIT = 3;

export async function fetchRecentMemory(
  params: FetchRecentMemoryParams,
  inject?: FetchRecentMemoryInject
): Promise<FetchRecentMemoryResult> {
  const { tenantId, userId, runId, queryText, conversationId, scopeMode: rawScope } = params;
  const scopeMode: MemoryScopeMode =
    rawScope ?? (conversationId ? 'conversation_only' : 'user_global_fallback');
  const allowFallback = scopeMode === 'user_global_fallback' || scopeMode === 'mixed_scope';
  const semanticSearch = inject?.searchMemorySemantic ?? searchMemorySemantic;
  const limit = params.limit ?? config.memoryRecentLimit;
  const timeoutMs = params.timeoutMs ?? config.memoryRecentTimeoutMs;
  const ctx = { run_id: runId, module: 'retrieval/memory-store', step: 'U4' };
  const t0 = Date.now();

  // User ID is always required for multi-tenant safety
  if (!userId) {
    logger.debug('memory_store: skip — no user_id', ctx);
    return { refs: [], degraded: false, latency_ms: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const RECENT_FALLBACK_LIMIT = 3; // recent_top only when semantic unavailable/degraded
  const OFFLOAD_CONCURRENCY = 3;
  const OFFLOAD_MAX_PREVIEW_CHARS = config.mmOffloadPreviewChars;

  let refs: MemoryRef[] = [];
  let degraded = false;
  const degradedReasons: string[] = [];
  let recentCount = 0;
  let semanticCount = 0;
  let conversation_semantic_count = 0;
  let conversation_recent_count = 0;
  let global_semantic_count = 0;
  let global_recent_count = 0;
  const fallbackConversationIds: string[] = [];
  let supabase_latency_ms: number | undefined;
  let qdrant_latency_ms: number | undefined;
  let summaryText: string | undefined;

  // Early semantic path when inject provided (for unit tests without Supabase)
  if (inject?.searchMemorySemantic && queryText) {
    try {
      const semanticResult = await semanticSearch({
        queryText,
        tenantId,
        userId,
        conversationId: conversationId ?? undefined,
        topK: config.memorySemanticTopK,
        runId,
      });
      qdrant_latency_ms = semanticResult.latencyMs;
      if (semanticResult.degraded) {
        degraded = true;
        if (!degradedReasons.includes('SEMANTIC_DEGRADED')) degradedReasons.push('SEMANTIC_DEGRADED');
      }
      if (!semanticResult.degraded && semanticResult.hits.length > 0) {
        refs = semanticResult.hits.map((h) => ({
          id: h.memoryItemId,
          scope_type: 'conversation' as const,
          scope_id: h.conversationId,
          content_preview: undefined,
          ...(h.r2_key ? { r2_key: h.r2_key } : {}),
        }));
        semanticCount = refs.length;
        if (conversationId) {
          conversation_semantic_count = refs.length;
        }
      }
    } catch (err) {
      degraded = true;
      if (!degradedReasons.includes('SEMANTIC_ERROR')) degradedReasons.push('SEMANTIC_ERROR');
      logger.debug('memory_store: semantic (inject) threw', { ...ctx, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const sb = getOrCreateClient();
  if (!sb) {
    clearTimeout(timer);
    const degradedFinal = degraded || degradedReasons.length > 0;
    logger.warn('memory_store: Supabase not configured — skipping memory fetch', ctx);
    return {
      refs: [],
      degraded: degradedFinal,
      degraded_reason_codes:
        degradedReasons.length > 0 ? degradedReasons : (['SUPABASE_NOT_CONFIGURED'] as string[]),
      latency_ms: Date.now() - t0,
    };
  }

  // Phase 1b: mm_summaries — conversation-scoped first when conversationId set
  const tSupabase = Date.now();
  try {
    let summaryQuery = sb
      .from('mm_summaries')
      .select('summary_text')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(3);
    if (tenantId) summaryQuery = summaryQuery.eq('tenant_id', tenantId);
    if (conversationId) summaryQuery = summaryQuery.eq('conversation_id', conversationId);
    const { data: summaryRows } = await summaryQuery;
    const firstSummary = summaryRows?.[0] as { summary_text?: string } | undefined;
    if (firstSummary?.summary_text) {
      summaryText = firstSummary.summary_text.slice(0, 800);
    } else if (allowFallback && conversationId) {
      // Fallback: user-level summary (no conversation filter)
      let fallbackSummary = sb
        .from('mm_summaries')
        .select('summary_text')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (tenantId) fallbackSummary = fallbackSummary.eq('tenant_id', tenantId);
      const { data: fallbackRows } = await fallbackSummary;
      const firstFallback = fallbackRows?.[0] as { summary_text?: string } | undefined;
      if (firstFallback?.summary_text) {
        summaryText = firstFallback.summary_text.slice(0, 800);
      }
    }
  } catch {
    // non-fatal
  }

  // Phase 2: Semantic-first — when enabled and queryText (skip if already ran via inject)
  const useSemanticPath =
    !inject?.searchMemorySemantic &&
    config.memorySemanticEnabled &&
    !!queryText &&
    !!config.memoryQdrantUrl;
  if (useSemanticPath && queryText) {
    try {
      // Primary: conversation-scoped when conversationId set
      const semanticResult = await semanticSearch({
        queryText,
        tenantId,
        userId,
        conversationId: conversationId ?? undefined,
        topK: config.memorySemanticTopK,
        runId,
      });
      qdrant_latency_ms = semanticResult.latencyMs;
      if (semanticResult.degraded) {
        degraded = true;
        if (!degradedReasons.includes('SEMANTIC_DEGRADED')) degradedReasons.push('SEMANTIC_DEGRADED');
      }
      if (!semanticResult.degraded && semanticResult.hits.length > 0) {
        refs = semanticResult.hits.map((h) => ({
          id: h.memoryItemId,
          scope_type: 'conversation' as const,
          scope_id: h.conversationId,
          content_preview: undefined,
          ...(h.r2_key ? { r2_key: h.r2_key } : {}),
        }));
        conversation_semantic_count = refs.length;
        semanticCount = refs.length;
      }
      // Fallback: user-global semantic when allowed and primary returned few
      if (allowFallback && conversationId && refs.length < limit) {
        const fallbackResult = await semanticSearch({
          queryText,
          tenantId,
          userId,
          conversationId: undefined,
          topK: GLOBAL_FALLBACK_LIMIT,
          runId,
        });
        if (!fallbackResult.degraded && fallbackResult.hits.length > 0) {
          const otherConvs = fallbackResult.hits.filter((h) => h.conversationId !== conversationId);
          const take = Math.min(GLOBAL_FALLBACK_LIMIT, otherConvs.length, limit - refs.length);
          for (let i = 0; i < take; i++) {
            const h = otherConvs[i];
            if (h?.conversationId && !fallbackConversationIds.includes(h.conversationId)) {
              fallbackConversationIds.push(h.conversationId);
            }
            refs.push({
              id: h!.memoryItemId,
              scope_type: 'conversation' as const,
              scope_id: h!.conversationId,
              content_preview: undefined,
              ...(h!.r2_key ? { r2_key: h!.r2_key } : {}),
            });
          }
          global_semantic_count = take;
          semanticCount = refs.length;
        }
      }
    } catch (err) {
      degraded = true;
      if (!degradedReasons.includes('SEMANTIC_ERROR')) degradedReasons.push('SEMANTIC_ERROR');
      logger.debug('memory_store: semantic search threw', {
        ...ctx,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 1 (recent): only when semantic unavailable or degraded — conversation-scoped first
  if (refs.length === 0) {
    try {
      const recentLimit = config.memorySemanticEnabled ? RECENT_FALLBACK_LIMIT : limit;
      let query = sb
        .from('mm_memory_items')
        .select('id, scope_type, scope_id, content, metadata, created_at, r2_key, content_size, conversation_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(recentLimit);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (conversationId) query = query.eq('conversation_id', conversationId);
      const { data, error } = await query.abortSignal(controller.signal);
      clearTimeout(timer);
      if (error) {
        degraded = true;
        degradedReasons.push('SUPABASE_QUERY_ERROR');
        logger.debug('memory_store: mm_memory_items query failed', {
          ...ctx,
          error_code: (error as { code?: string }).code,
          error_message: (error as { message?: string }).message ?? String(error),
        });
      } else if (data && data.length > 0) {
        refs = (data as Array<{
          id: string;
          scope_type: string | null;
          scope_id: string | null;
          content: string;
          r2_key?: string | null;
          conversation_id?: string | null;
        }>).map((row) => ({
          id: row.id,
          scope_type: row.scope_type ?? undefined,
          scope_id: row.scope_id ?? row.conversation_id ?? undefined,
          content_preview: typeof row.content === 'string' ? row.content.slice(0, 500) : undefined,
          ...(row.r2_key ? { r2_key: row.r2_key } : {}),
        }));
        conversation_recent_count = refs.length;
        recentCount = refs.length;
      } else if (allowFallback && conversationId) {
        const fallbackQuery = sb
          .from('mm_memory_items')
          .select('id, scope_type, scope_id, content, metadata, created_at, r2_key, content_size, conversation_id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(GLOBAL_FALLBACK_LIMIT);
        const fallbackWithTenant = tenantId ? fallbackQuery.eq('tenant_id', tenantId) : fallbackQuery;
        const { data: fallbackData } = await fallbackWithTenant.abortSignal(controller.signal);
        if (fallbackData?.length) {
          for (const row of fallbackData as Array<{
            id: string;
            scope_type: string | null;
            scope_id: string | null;
            content: string;
            r2_key?: string | null;
            conversation_id?: string | null;
          }>) {
            if (row.conversation_id && !fallbackConversationIds.includes(row.conversation_id)) {
              fallbackConversationIds.push(row.conversation_id);
            }
            refs.push({
              id: row.id,
              scope_type: row.scope_type ?? undefined,
              scope_id: row.scope_id ?? row.conversation_id ?? undefined,
              content_preview: typeof row.content === 'string' ? row.content.slice(0, 500) : undefined,
              ...(row.r2_key ? { r2_key: row.r2_key } : {}),
            });
          }
          global_recent_count = refs.length;
          recentCount = refs.length;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      degraded = true;
      degradedReasons.push(err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT' : 'UNEXPECTED_ERROR');
    }
  } else {
    clearTimeout(timer);
  }
  supabase_latency_ms = Date.now() - tSupabase;

  // Fill content_preview for refs that don't have it (e.g. semantic hits without r2_key — fetch from Supabase)
  const refsWithoutPreview = refs.filter((r) => !r.content_preview && r.id);
  if (refsWithoutPreview.length > 0 && sb) {
    try {
      const ids = refsWithoutPreview.map((r) => r.id);
      const { data: rows } = await sb
        .from('mm_memory_items')
        .select('id, content')
        .in('id', ids);
      if (rows?.length) {
        for (const row of rows as Array<{ id: string; content: string }>) {
          const ref = refs.find((r) => r.id === row.id);
          if (ref) ref.content_preview = (row.content ?? '').slice(0, 500);
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Phase 3: Lazy R2 offload load for top-k refs that have r2_key (bounded concurrency <= OFFLOAD_CONCURRENCY)
  let offload_loaded_count = 0;
  const tOffload = Date.now();
  const withR2 = refs.filter((r): r is MemoryRef & { r2_key: string } => 'r2_key' in r && typeof (r as { r2_key?: string }).r2_key === 'string');
  if (withR2.length > 0) {
    const toLoad = withR2.slice(0, 10); // cap total items to load
    for (let i = 0; i < toLoad.length; i += OFFLOAD_CONCURRENCY) {
      const chunk = toLoad.slice(i, i + OFFLOAD_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (r) => {
          const out = await getMemoryOffload(r.r2_key);
          return { id: r.id, content: out.content };
        })
      );
      for (const res of results) {
        if (res.content != null) {
          offload_loaded_count++;
          const ref = refs.find((x) => x.id === res.id);
          if (ref) {
            const truncated = res.content.slice(0, OFFLOAD_MAX_PREVIEW_CHARS);
            ref.content_preview = truncated + (res.content.length > OFFLOAD_MAX_PREVIEW_CHARS ? '…' : '');
          }
        }
      }
    }
  }
  const offload_load_latency_ms = Date.now() - tOffload;

  const latency_ms = Date.now() - t0;
  const degradedFinal = degraded || degradedReasons.length > 0;
  logger.debug('memory_store: fetched', {
    ...ctx,
    ref_count: refs.length,
    semantic_count: semanticCount,
    recent_count: recentCount,
    has_summary: !!summaryText,
    offload_loaded_count,
    latency_ms,
    degraded: degradedFinal,
    degraded_reason_codes: degradedReasons.length ? degradedReasons : undefined,
  });

  const scope_fallback_used = fallbackConversationIds.length > 0;
  const scope_primary: 'conversation' | 'user_global' =
    conversationId && (conversation_semantic_count > 0 || conversation_recent_count > 0)
      ? 'conversation'
      : 'user_global';

  return {
    refs,
    summaryText,
    degraded: degradedFinal,
    degraded_reason_codes: degradedReasons.length > 0 ? degradedReasons : undefined,
    latency_ms,
    recent_count: recentCount,
    semantic_count: semanticCount,
    supabase_latency_ms,
    qdrant_latency_ms,
    offload_loaded_count,
    offload_load_latency_ms,
    scope_primary,
    scope_fallback_used: scope_fallback_used || undefined,
    conversation_recent_count: conversation_recent_count || undefined,
    conversation_semantic_count: conversation_semantic_count || undefined,
    global_recent_count: global_recent_count || undefined,
    global_semantic_count: global_semantic_count || undefined,
    fallback_conversation_ids: fallbackConversationIds.length > 0 ? fallbackConversationIds : undefined,
  };
}
