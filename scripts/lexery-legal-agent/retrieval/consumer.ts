/**
 * U4 CacheRAG consumer (LEX-114, LEX-117) — handle U4 event: run retrieval, persist RetrievalTrace, enqueue U5.
 */
import type { RunEvent } from '../gateway/types.js';
import { RunRepository } from '../gateway/storage.js';
import { getTaskQueue } from '../gateway/handler.js';
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
} from '../gateway/observability.js';
import { runCacheRag } from './cache-rag.js';
import type { SearchPlan, SearchStep } from '../plan/types.js';

const runRepo = new RunRepository();
const RUN_CONTEXT_TTL_SEC = 3600;

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

    const query = run.query ?? (run.snapshot?.request as { query?: string } | undefined)?.query ?? '';
    const queryProfile = run.query_profile as {
      domain?: string;
      entities?: { act_abbrev?: string; article_ref?: string }[];
    } | null | undefined;
    const { rawHits, retrievalTrace } = await runCacheRag({
      query,
      searchPlan: plan,
      steps,
      domainHint: queryProfile?.domain,
      entities: queryProfile?.entities,
    });

    if (retrievalTrace.degraded_sources?.lldbi) {
      incrementU4DegradedLldbi();
    }
    if (retrievalTrace.meta?.used_filtered_chunks_search) {
      incrementU4FilteredSearch();
    }
    if (retrievalTrace.meta?.low_confidence) {
      incrementU4LowConfidence();
    }
    recordU4QdrantLatency(retrievalTrace.latency_ms ?? 0);
    recordU4Hits(rawHits.length);

    await runRepo.updateRetrievalTrace(run_id, retrievalTrace as unknown as object);

    const mergedCtx = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      { ...mergedCtx, raw_hits: rawHits, retrieval_trace: retrievalTrace } as Record<string, unknown>,
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
