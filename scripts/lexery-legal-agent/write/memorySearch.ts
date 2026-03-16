/**
 * U10 Memory Search Tool (internal) — semantic-first search over agent memory.
 * Used when evidence_insufficient or user asks about profile/preferences.
 * No external tool-calling; results are injected as MEMORY SEARCH RESULTS section.
 *
 * DEV RUN v12: dry_run stub returns deterministic result; real path uses fetchRecentMemory.
 */
import { fetchRecentMemory } from '../retrieval/memory-store.js';
import { config } from '../lib/config.js';

export interface MemorySearchResult {
  summaries: string[];
  facts: string[];
  trace: {
    latency_ms: number;
    qdrant_used: boolean;
    supabase_latency_ms?: number;
    qdrant_latency_ms?: number;
    offload_loaded_count?: number;
    degraded?: boolean;
  };
}

export function shouldTriggerMemorySearchTool(params: {
  userIdPresent: boolean;
  useMemorySource: boolean;
  evidenceInsufficient: boolean;
  memoryChannelEmpty: boolean;
  memoryAvailableInTrace: boolean;
}): boolean {
  const {
    userIdPresent,
    useMemorySource,
    evidenceInsufficient,
    memoryChannelEmpty,
    memoryAvailableInTrace,
  } = params;
  if (!userIdPresent) return false;
  if (!useMemorySource) return false;
  return evidenceInsufficient || (memoryChannelEmpty && memoryAvailableInTrace);
}

/**
 * Search agent memory (semantic-first). Returns summaries + top facts for context.
 * In dry_run / when LLM disabled, returns stub when stubForDryRun is true.
 */
export async function searchMemoryTool(params: {
  tenant_id: string | null;
  conversation_id: string | null;
  user_id: string;
  queryText: string;
  limit?: number;
  runId?: string;
  /** When true (e.g. LEGAL_AGENT_DISABLE_LLM), return fast deterministic stub. */
  stubForDryRun?: boolean;
}): Promise<MemorySearchResult> {
  const { tenant_id, user_id, queryText, limit = 8, runId, stubForDryRun } = params;

  if (stubForDryRun) {
    return {
      summaries: [],
      facts: ['[Memory search stub: use MEMORY CONTEXT from assembled prompt when available.]'],
      trace: { latency_ms: 0, qdrant_used: false },
    };
  }

  const t0 = Date.now();
  const result = await fetchRecentMemory({
    tenantId: tenant_id,
    userId: user_id,
    conversationId: params.conversation_id ?? undefined,
    scopeMode: params.conversation_id ? 'conversation_only' : 'user_global_fallback',
    queryText,
    limit,
    runId,
  });

  const summaries: string[] = result.summaryText ? [result.summaryText] : [];
  const facts = result.refs
    .map((r) => (r as { content_preview?: string }).content_preview?.trim())
    .filter((s): s is string => !!s);

  return {
    summaries,
    facts,
    trace: {
      latency_ms: Date.now() - t0,
      qdrant_used: (result.semantic_count ?? 0) > 0,
      supabase_latency_ms: result.supabase_latency_ms,
      qdrant_latency_ms: result.qdrant_latency_ms,
      offload_loaded_count: result.offload_loaded_count,
      degraded: result.degraded,
    },
  };
}

/**
 * Format memory search result as a single string for injection into context.
 */
export function formatMemorySearchSection(result: MemorySearchResult): string {
  const parts: string[] = [];
  if (result.summaries.length > 0) {
    parts.push('Summaries:\n' + result.summaries.join('\n'));
  }
  if (result.facts.length > 0) {
    parts.push('Facts:\n' + result.facts.map((f, i) => `${i + 1}. ${f}`).join('\n'));
  }
  if (parts.length === 0) return '';
  return '=== MEMORY SEARCH RESULTS ===\n' + parts.join('\n\n');
}
