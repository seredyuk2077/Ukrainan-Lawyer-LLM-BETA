/**
 * U4 CacheRAG consumer (LEX-114, LEX-117) — handle U4 event: run retrieval, persist RetrievalTrace, enqueue U5.
 */
import type { RunEvent } from '../gateway/types.js';
import { compactRetrievalTraceForDb, MAX_HITS_IN_DB } from './retrieval-trace-compact.js';
import { putRetrievalTraceFull } from './retrieval-trace-r2.js';
import { RunRepository } from '../gateway/storage.js';
import { getTaskQueue } from '../gateway/handler.js';
import { withTransientGatewayIoRetry } from '../gateway/retry.js';
import { logger } from '../lib/logger.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import {
  incrementU4Processed,
  incrementU4Failed,
  recordU4QdrantLatency,
  recordU4Hits,
  incrementU4DegradedLldbi,
  incrementU4FilteredSearch,
  incrementU4LowConfidence,
  incrementU4QdrantCalls,
  incrementU4PlannerTierSelected,
  incrementU4PlannerCalls,
  incrementU4GoalsCount,
  incrementU4CoverageEnforced,
  incrementU4NoisePenalty,
  incrementU4HitsCapApplied,
  recordU4HitsBeforeCapBucket,
  incrementU4LldbiHintsPresent,
  incrementU4LldbiHintsUsed,
  addU4LldbiHintsInjectedActs,
  addU4MemoryRecentCount,
  incrementU4MemoryDegraded,
  recordU4MemoryLatency,
} from '../gateway/observability.js';
import { runCacheRag } from './cache-rag.js';
import type { SearchPlan, SearchStep } from '../plan/types.js';

const runRepo = new RunRepository();
const RUN_CONTEXT_TTL_SEC = 3600;

/** Map U2 LegalDomain to taxonomy category key for getTaxonomyCandidates. */
function legalDomainToTaxonomyKey(domain: string): string | undefined {
  const d = domain.trim().toLowerCase();
  if (d === 'criminal') return 'criminal';
  if (d === 'civil') return 'civil';
  if (d === 'labor') return 'labor_social';
  if (d === 'admin') return 'administrative';
  if (d === 'tax') return 'tax_customs';
  if (d === 'corporate') return 'corporate';
  if (d === 'general') return undefined;
  return undefined;
}

export async function runU4IoRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withTransientGatewayIoRetry(fn);
}

export async function runCacheRagWithIoRetry(
  params: Parameters<typeof runCacheRag>[0]
): Promise<Awaited<ReturnType<typeof runCacheRag>>> {
  return runU4IoRetry(() => runCacheRag(params));
}

export async function handleU4Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U4') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U4', trace_id, module: 'retrieval/consumer' };

  try {
    const run = await runRepo.findByRunId(run_id);
    if (!run) {
      logger.error('U4 run not found', { ...ctx, error: 'run_not_found' });
      incrementU4Failed();
      return;
    }

    let plan: SearchPlan;
    let steps: SearchStep[] | undefined;
    const existingCtx = (await runContextGet<{ search_plan?: SearchPlan; search_steps?: SearchStep[] }>(run_id)) ?? null;
    if (existingCtx?.search_plan) {
      plan = existingCtx.search_plan;
      steps = existingCtx.search_steps;
    } else {
      const audit = run.search_plan as { plan?: SearchPlan; steps?: SearchStep[] } | null | undefined;
      if (!audit?.plan) {
        logger.error('U4 no search_plan', { ...ctx, error: 'missing_plan' });
        incrementU4Failed();
        return;
      }
      plan = audit.plan;
      steps = audit.steps;
    }

    let query = run.query ?? (run.snapshot?.request as { query?: string } | undefined)?.query ?? '';
    if (typeof query !== 'string') query = '';
    query = query.trim();
    if (query.length === 0) {
      logger.error('U4 empty query', { ...ctx, error: 'empty_query' });
      incrementU4Failed();
      try {
        await runRepo.markFailed(run_id, 'U4_EMPTY_QUERY');
      } catch {
        // ignore
      }
      return;
    }
    const queryProfile = run.query_profile as {
      domain?: string;
      domainHint?: string;
      entities?: { act_abbrev?: string; law_title?: string; article_ref?: string }[];
      routing_flags?: import('../classify/types.js').RoutingFlags;
      lldbi?: { categories_ranked_top3?: string[]; document_types_ranked_top3?: string[] };
    } | null | undefined;
    const domainHint =
      queryProfile?.domainHint ??
      (queryProfile?.domain ? legalDomainToTaxonomyKey(queryProfile.domain) : undefined);
    const lldbi =
      queryProfile?.lldbi &&
      (queryProfile.lldbi.categories_ranked_top3?.length || queryProfile.lldbi.document_types_ranked_top3?.length)
        ? {
            categories_ranked_top3: queryProfile.lldbi.categories_ranked_top3 ?? [],
            document_types_ranked_top3: queryProfile.lldbi.document_types_ranked_top3 ?? [],
          }
        : undefined;
    const { rawHits, retrievalTrace, memoryRefs, memorySummaries, memoryTrace } = await runCacheRagWithIoRetry({
      query,
      searchPlan: plan,
      steps,
      domainHint,
      lldbi: lldbi ?? null,
      entities: queryProfile?.entities,
      routing_flags: queryProfile?.routing_flags,
      run_id,
      tenant_id: run.tenant_id ?? null,
      user_id: run.user_id,
      conversation_id: run.conversation_id ?? null,
    });

    if (retrievalTrace.degraded_sources?.lldbi) {
      incrementU4DegradedLldbi();
    }
    if (retrievalTrace.meta?.lldbi_hints_present) {
      incrementU4LldbiHintsPresent();
    }
    const lldbiUsed = retrievalTrace.meta?.lldbi_hints_used as { categories_used_count?: number; doc_types_used_count?: number; injected_acts_count?: number } | undefined;
    if (lldbiUsed && ((lldbiUsed.categories_used_count ?? 0) + (lldbiUsed.doc_types_used_count ?? 0) > 0)) {
      incrementU4LldbiHintsUsed();
    }
    if (lldbiUsed && (lldbiUsed.injected_acts_count ?? 0) > 0) {
      addU4LldbiHintsInjectedActs(lldbiUsed.injected_acts_count!);
    }
    if (retrievalTrace.meta?.used_filtered_chunks_search) {
      incrementU4FilteredSearch();
    }
    if (retrievalTrace.meta?.low_confidence) {
      incrementU4LowConfidence();
    }
    const plannerMeta = retrievalTrace.meta?.planner as { tier_selected?: 0 | 1 | 2; tier?: 0 | 1 | 2; called?: boolean } | undefined;
    const tierSelected = plannerMeta?.tier_selected ?? plannerMeta?.tier ?? 0;
    incrementU4PlannerTierSelected(tierSelected as 0 | 1 | 2);
    if (plannerMeta?.called && (tierSelected === 1 || tierSelected === 2)) {
      incrementU4PlannerCalls(tierSelected as 1 | 2);
    }
    const goalsCount = retrievalTrace.meta?.goals_summary?.length ?? 1;
    incrementU4GoalsCount(Math.min(3, Math.max(1, goalsCount)));
    if (retrievalTrace.meta?.fusion?.coverage_enforced) {
      incrementU4CoverageEnforced();
    }
    const noiseCount = (retrievalTrace.meta?.distribution as { noise_penalty_applied_count?: number } | undefined)?.noise_penalty_applied_count ?? 0;
    if (noiseCount > 0) incrementU4NoisePenalty();
    const qdrantCallsTotal = (retrievalTrace.meta as { qdrant_calls_count_total?: number } | undefined)?.qdrant_calls_count_total;
    incrementU4QdrantCalls(typeof qdrantCallsTotal === 'number' ? qdrantCallsTotal : Math.max(1, (retrievalTrace.meta?.steps_executed ?? []).length));
    const metaCap = retrievalTrace.meta as { hits_cap_applied?: boolean; hits_total_before_cap?: number } | undefined;
    if (metaCap?.hits_cap_applied) incrementU4HitsCapApplied();
    const beforeCap = metaCap?.hits_total_before_cap;
    if (typeof beforeCap === 'number') recordU4HitsBeforeCapBucket(beforeCap);
    recordU4QdrantLatency(retrievalTrace.latency_ms ?? 0);
    recordU4Hits(rawHits.length);

    // Memory metrics (LEX-MEM)
    const memMeta = retrievalTrace.meta?.memory as { recent_count?: number; degraded?: boolean; latency_ms?: { recent?: number } } | undefined;
    if (memMeta) {
      if (typeof memMeta.recent_count === 'number' && memMeta.recent_count > 0) {
        addU4MemoryRecentCount(memMeta.recent_count);
      }
      if (memMeta.degraded) incrementU4MemoryDegraded();
      const recentLatency = memMeta.latency_ms?.recent;
      if (typeof recentLatency === 'number') recordU4MemoryLatency(recentLatency);
    }

    let compact = compactRetrievalTraceForDb(retrievalTrace);
    if (Array.isArray(retrievalTrace.hits) && retrievalTrace.hits.length > MAX_HITS_IN_DB) {
      const r2Result = await putRetrievalTraceFull(run.tenant_id ?? null, run_id, retrievalTrace);
      if (r2Result.success && r2Result.r2_key) {
        compact = { ...compact, meta: { ...compact.meta, full_trace_r2_key: r2Result.r2_key } };
      }
    }
    await runRepo.updateRetrievalTrace(run_id, compact as unknown as object);

    const mergedCtx = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      {
        ...mergedCtx,
        raw_hits: rawHits,
        retrieval_trace: retrievalTrace,
        memory_items: memoryRefs ?? mergedCtx.memory_items,
        memory_summaries: memorySummaries ?? mergedCtx.memory_summaries,
        memory_trace: memoryTrace ?? mergedCtx.memory_trace,
      } as Record<string, unknown>,
      RUN_CONTEXT_TTL_SEC
    );

    incrementU4Processed();

    logger.info('U4 finished', {
      ...ctx,
      hits_count: rawHits.length,
      top_score: retrievalTrace.top_score ?? null,
      degraded_sources: retrievalTrace.degraded_sources ?? null,
      latency_ms: retrievalTrace.latency_ms,
    });

    const now = new Date().toISOString();
    const taskQueue = getTaskQueue();
    await taskQueue.enqueue({
      run_id,
      step: 'U5',
      created_at: now,
      trace_id,
    });
    logger.info('U5 enqueued', { run_id, trace_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U4 failed', { ...ctx, error: msg });
    incrementU4Failed();
    try {
      await runRepo.markFailed(run_id, 'U4_RETRIEVAL_ERROR');
    } catch {
      // ignore
    }
  }
}
