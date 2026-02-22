/**
 * U4 Memory Store — fetch recent mm_memory_items for tenant+user from Supabase.
 * Non-fatal: any failure sets degraded=true and returns empty array; pipeline continues.
 * Multi-tenant safe: always filters by both tenant_id AND user_id.
 *
 * Tables live in the same Supabase project as `runs` (supabaseUrl / supabaseServiceKey).
 * Write path (MM_OUTBOX) is managed by U12/Deliver — out of scope here.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { MemoryRef } from '../assemble/types.js';

export interface FetchRecentMemoryParams {
  tenantId: string | null;
  userId: string;
  /** Max items to fetch. Default: config.memoryRecentLimit */
  limit?: number;
  /** Timeout in ms. Default: config.memoryRecentTimeoutMs */
  timeoutMs?: number;
  runId?: string;
}

export interface FetchRecentMemoryResult {
  refs: MemoryRef[];
  degraded: boolean;
  degraded_reason_codes?: string[];
  latency_ms: number;
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
 * Fetch recent memory items for a tenant+user from mm_memory_items.
 * Returns empty refs on any failure (degraded=true).
 * Always enforces tenant_id + user_id isolation.
 */
export async function fetchRecentMemory(params: FetchRecentMemoryParams): Promise<FetchRecentMemoryResult> {
  const { tenantId, userId, runId } = params;
  const limit = params.limit ?? config.memoryRecentLimit;
  const timeoutMs = params.timeoutMs ?? config.memoryRecentTimeoutMs;
  const ctx = { run_id: runId, module: 'retrieval/memory-store', step: 'U4' };
  const t0 = Date.now();

  // User ID is always required for multi-tenant safety
  if (!userId) {
    logger.debug('memory_store: skip — no user_id', ctx);
    return { refs: [], degraded: false, latency_ms: 0 };
  }

  const sb = getOrCreateClient();
  if (!sb) {
    logger.warn('memory_store: Supabase not configured — skipping memory fetch', ctx);
    return { refs: [], degraded: false, degraded_reason_codes: ['SUPABASE_NOT_CONFIGURED'], latency_ms: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let query = sb
      .from('mm_memory_items')
      .select('id, scope_type, scope_id, content, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    // Always filter by tenant_id when available for multi-tenant isolation
    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }

    const { data, error } = await query.abortSignal(controller.signal);

    clearTimeout(timer);

    if (error) {
      logger.warn('memory_store: Supabase query error', { ...ctx, error: error.message, code: error.code });
      return {
        refs: [],
        degraded: true,
        degraded_reason_codes: ['SUPABASE_QUERY_ERROR'],
        latency_ms: Date.now() - t0,
      };
    }

    if (!data || data.length === 0) {
      logger.debug('memory_store: no memory items found', { ...ctx, tenant_id: tenantId, user_id: userId });
      return { refs: [], degraded: false, latency_ms: Date.now() - t0 };
    }

    const refs: MemoryRef[] = data.map((row: {
      id: string;
      scope_type: string | null;
      scope_id: string | null;
      content: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }) => ({
      id: row.id,
      scope_type: row.scope_type ?? undefined,
      scope_id: row.scope_id ?? undefined,
      // Truncate to 500 chars for trace safety (full content is available in Supabase if needed)
      content_preview: typeof row.content === 'string' ? row.content.slice(0, 500) : undefined,
    }));

    logger.debug('memory_store: fetched', { ...ctx, count: refs.length, latency_ms: Date.now() - t0 });
    return { refs, degraded: false, latency_ms: Date.now() - t0 };
  } catch (err) {
    clearTimeout(timer);
    const latency_ms = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const reason = isAbort ? 'TIMEOUT' : 'UNEXPECTED_ERROR';
    logger.warn('memory_store: fetch failed', { ...ctx, reason, latency_ms, error: isAbort ? 'timeout' : String(err) });
    return {
      refs: [],
      degraded: true,
      degraded_reason_codes: [reason],
      latency_ms,
    };
  }
}
