/**
 * MM Semantic Search — embed a query and search Qdrant lexery_memory_semantic_v1.
 * Used by MM Search/Load (U4 Phase 2) to find semantically relevant memory items.
 *
 * Design:
 *   - Reuses OpenRouter embeddings (text-embedding-3-small, 1536d) — same as U4
 *   - Searches lexery_memory_semantic_v1 collection
 *   - Multi-tenant safe: always filters by tenant_id + user_id in payload
 *   - Non-fatal: any failure returns empty results
 */
import { config } from '../lib/config.js';
import { embedQuery } from '../retrieval/embedding.js';
import { logger } from '../lib/logger.js';

export interface MemorySearchHit {
  id: string;
  score: number;
  memoryItemId: string;
  tenantId?: string;
  conversationId?: string;
  userId?: string;
  createdAt?: string;
  tags?: string[];
  /** When content is offloaded to R2. */
  r2_key?: string;
}

export interface SemanticMemorySearchResult {
  hits: MemorySearchHit[];
  degraded: boolean;
  latencyMs: number;
}

/**
 * Search Qdrant memory collection for semantically relevant facts.
 * Returns empty results on any failure (non-fatal).
 */
export async function searchMemorySemantic(params: {
  queryText: string;
  tenantId: string | null;
  userId: string;
  /** When set, only points with this conversation_id are returned (conversation-scoped). */
  conversationId?: string | null;
  topK?: number;
  runId?: string;
}): Promise<SemanticMemorySearchResult> {
  const { queryText, tenantId, userId, conversationId, runId } = params;
  const topK = params.topK ?? config.memorySemanticTopK;
  const ctx = { run_id: runId, module: 'mm/semanticSearch' };
  const t0 = Date.now();

  if (!config.memoryQdrantUrl || !config.memoryQdrantApiKey) {
    logger.debug('mm_semantic_search: Qdrant memory not configured — skipping', ctx);
    return { hits: [], degraded: false, latencyMs: 0 };
  }

  if (!userId) {
    logger.debug('mm_semantic_search: no user_id — skipping', ctx);
    return { hits: [], degraded: false, latencyMs: 0 };
  }

  try {
    // Embed the query
    const embed = await embedQuery(queryText.slice(0, 500));

    // Build Qdrant filter: user_id (required); tenant_id when set; conversation_id when set (conversation-scoped)
    const mustFilters: Array<{ key: string; match: { value: string } }> = [
      { key: 'user_id', match: { value: userId } },
    ];
    if (tenantId) {
      mustFilters.push({ key: 'tenant_id', match: { value: tenantId } });
    }
    if (conversationId) {
      mustFilters.push({ key: 'conversation_id', match: { value: conversationId } });
    }

    const searchBody = {
      vector: embed.embedding,
      limit: topK,
      with_payload: true,
      filter: { must: mustFilters },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.memorySemanticTimeoutMs);

    const res = await fetch(
      `${config.memoryQdrantUrl}/collections/${config.memoryQdrantCollection}/points/search`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'api-key': config.memoryQdrantApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(searchBody),
      }
    );
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text();
      const latencyMs = Date.now() - t0;
      logger.warn('mm_semantic_search: Qdrant search failed (non-fatal)', {
        ...ctx,
        status: res.status,
        error_preview: errText.slice(0, 200),
        latency_ms: latencyMs,
      });
      return { hits: [], degraded: true, latencyMs };
    }

    const data = (await res.json()) as {
      result?: Array<{
        id: string | number;
        score: number;
        payload?: Record<string, unknown>;
      }>;
    };

    const hits: MemorySearchHit[] = (data.result ?? []).map((r) => ({
      id: String(r.id),
      score: r.score,
      memoryItemId: (r.payload?.memory_item_id as string) ?? String(r.id),
      tenantId: r.payload?.tenant_id as string | undefined,
      conversationId: r.payload?.conversation_id as string | undefined,
      userId: r.payload?.user_id as string | undefined,
      createdAt: r.payload?.created_at as string | undefined,
      tags: r.payload?.tags as string[] | undefined,
      r2_key: r.payload?.r2_key as string | undefined,
    }));

    logger.debug('mm_semantic_search: found hits', { ...ctx, count: hits.length, latency_ms: Date.now() - t0 });
    return { hits, degraded: false, latencyMs: Date.now() - t0 };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const reason = err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT' : 'SEARCH_ERROR';
    logger.warn('mm_semantic_search: failed (non-fatal)', {
      ...ctx,
      reason,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: latencyMs,
    });
    return { hits: [], degraded: true, latencyMs };
  }
}

/**
 * Upsert a memory vector to Qdrant lexery_memory_semantic_v1.
 * Point ID is deterministic (UUID from memoryItemId for idempotency).
 */
export async function upsertMemoryVector(params: {
  memoryItemId: string;
  vector: number[];
  tenantId: string | null;
  userId: string;
  conversationId: string | null;
  createdAt: string;
  tags?: string[];
  /** Short preview for display (max ~100 chars). No long content in payload. */
  preview?: string;
  /** R2 key when content is offloaded. */
  r2_key?: string | null;
}): Promise<boolean> {
  const { memoryItemId, vector, tenantId, userId, conversationId, createdAt, tags, preview, r2_key } = params;

  if (!config.memoryQdrantUrl || !config.memoryQdrantApiKey) {
    return false;
  }

  try {
    const payload: Record<string, unknown> = {
      memory_item_id: memoryItemId,
      tenant_id: tenantId ?? '',
      user_id: userId,
      conversation_id: conversationId ?? '',
      created_at: createdAt,
      tags: tags ?? [],
    };
    if (preview) payload.preview = preview.slice(0, 150);
    if (r2_key) payload.r2_key = r2_key;

    const body = {
      points: [
        {
          id: memoryItemId, // UUID — used directly as Qdrant point id
          vector,
          payload,
        },
      ],
    };

    const res = await fetch(
      `${config.memoryQdrantUrl}/collections/${config.memoryQdrantCollection}/points?wait=true`,
      {
        method: 'PUT',
        headers: {
          'api-key': config.memoryQdrantApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    return res.ok;
  } catch {
    return false;
  }
}

// --- Memory collection payload index bootstrap (single-flight) ---

const MEMORY_PAYLOAD_INDEX_FIELDS = ['user_id', 'tenant_id', 'conversation_id'] as const;

export interface MemoryBootstrapResult {
  ok: boolean;
  reason_code?: string;
}

let _memoryBootstrapPromise: Promise<MemoryBootstrapResult> | null = null;

/** Reset bootstrap promise for unit tests only. */
export function resetMemoryBootstrapForTesting(): void {
  _memoryBootstrapPromise = null;
}

/**
 * One-time bootstrap: ensure memory collection has payload indexes for filtered search.
 * Required so /points/search with filter on user_id/tenant_id does not return 400 "index required".
 * Single-flight per process; on failure semantic search continues degraded (non-fatal).
 */
export async function ensureMemoryCollectionPayloadIndexes(
  fetchOverride?: typeof fetch
): Promise<MemoryBootstrapResult> {
  if (_memoryBootstrapPromise) return _memoryBootstrapPromise;
  const doBootstrap = async (): Promise<MemoryBootstrapResult> => {
    const fetcher = fetchOverride ?? fetch;
    const base = config.memoryQdrantUrl?.replace(/\/$/, '');
    const apiKey = config.memoryQdrantApiKey;
    const collection = config.memoryQdrantCollection;

    if (!base || !apiKey) {
      return { ok: false, reason_code: 'NOT_CONFIGURED' };
    }

    try {
      const collRes = await fetcher(`${base}/collections/${collection}`, {
        method: 'GET',
        headers: { 'api-key': apiKey },
      });
      if (collRes.status === 404) {
        return { ok: false, reason_code: 'COLLECTION_MISSING' };
      }
      if (!collRes.ok) {
        const errText = await collRes.text();
        logger.warn('mm_semantic_bootstrap: collection check failed', {
          status: collRes.status,
          error: errText.slice(0, 200),
        });
        return { ok: false, reason_code: 'COLLECTION_CHECK_FAILED' };
      }

      for (const field of MEMORY_PAYLOAD_INDEX_FIELDS) {
        const indexRes = await fetcher(`${base}/collections/${collection}/index?wait=true`, {
          method: 'PUT',
          headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
        });
        if (!indexRes.ok) {
          const errText = await indexRes.text();
          logger.warn('mm_semantic_bootstrap: index create failed', {
            field,
            status: indexRes.status,
            error: errText.slice(0, 200),
          });
          return { ok: false, reason_code: 'INDEX_CREATE_FAILED' };
        }
      }
      return { ok: true };
    } catch (err) {
      logger.warn('mm_semantic_bootstrap: error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason_code: 'BOOTSTRAP_ERROR' };
    }
  };
  _memoryBootstrapPromise = doBootstrap();
  return _memoryBootstrapPromise;
}
