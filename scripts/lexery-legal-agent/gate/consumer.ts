/**
 * U5 Gate — handleU5Event: evaluate expand decision, persist gate_decision, enqueue U6 or U9 (LEX-118)
 */
import type { RunEvent } from '../gateway/types.js';
import { RunRepository } from '../gateway/storage.js';
import { getTaskQueue } from '../gateway/handler.js';
import { logger } from '../lib/logger.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import {
  incrementU5Processed,
  incrementU5Failed,
  incrementU5Expand,
  incrementU5NoExpand,
} from '../gateway/observability.js';
import { evaluateGate } from './gate.js';
import type { QueryProfile } from '../classify/types.js';
import type { SearchPlan } from '../plan/types.js';
import type { RetrievalTrace, RawHit } from '../retrieval/types.js';

const runRepo = new RunRepository();
const RUN_CONTEXT_TTL_SEC = 3600;

export async function handleU5Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U5') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U5', trace_id, module: 'gate/consumer' };

  try {
    const run = await runRepo.findByRunId(run_id);
    if (!run) {
      logger.error('U5 run not found', { ...ctx, error: 'run_not_found' });
      incrementU5Failed();
      return;
    }

    let retrievalTrace: RetrievalTrace | null = null;
    let rawHits: RawHit[] = [];
    let queryProfile: QueryProfile | null = null;
    let searchPlan: SearchPlan | null = null;

    const existingCtx = (await runContextGet<{
      retrieval_trace?: RetrievalTrace;
      raw_hits?: RawHit[];
      query_profile?: QueryProfile;
      search_plan?: SearchPlan;
    }>(run_id)) ?? null;

    if (existingCtx?.retrieval_trace != null) {
      retrievalTrace = existingCtx.retrieval_trace;
    } else {
      retrievalTrace = (run.retrieval_trace as RetrievalTrace | null) ?? null;
    }
    if (existingCtx?.raw_hits != null && Array.isArray(existingCtx.raw_hits)) {
      rawHits = existingCtx.raw_hits;
    } else if (retrievalTrace?.hits?.length) {
      rawHits = retrievalTrace.hits;
    }
    if (existingCtx?.query_profile != null) {
      queryProfile = existingCtx.query_profile;
    } else {
      queryProfile = (run.query_profile as QueryProfile | null) ?? null;
    }
    if (existingCtx?.search_plan != null) {
      searchPlan = existingCtx.search_plan;
    } else {
      const audit = run.search_plan as { plan?: SearchPlan } | null | undefined;
      searchPlan = audit?.plan ?? null;
    }

    const decision = evaluateGate({
      retrievalTrace,
      rawHits,
      queryProfile,
      searchPlan,
    });

    await runRepo.updateGateDecision(run_id, decision as unknown as object);

    const mergedCtx = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      { ...mergedCtx, gate_decision: decision } as Record<string, unknown>,
      RUN_CONTEXT_TTL_SEC
    );

    if (decision.expand) {
      incrementU5Expand();
    } else {
      incrementU5NoExpand();
    }
    incrementU5Processed();

    logger.info('U5 finished', {
      ...ctx,
      expand: decision.expand,
      reason_codes: decision.reason_codes,
      hits_count: decision.signals.hits_count,
      top_score: decision.signals.top_score,
      duration_ms: decision.meta?.duration_ms,
    });

    const now = new Date().toISOString();
    const taskQueue = getTaskQueue();
    const nextStep = decision.expand ? 'U6' : 'U9';
    await taskQueue.enqueue({
      run_id,
      step: nextStep,
      created_at: now,
      trace_id,
    });
    logger.info(`${nextStep} enqueued`, { run_id, trace_id, expand: decision.expand });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U5 failed', { ...ctx, error: msg });
    incrementU5Failed();
    try {
      await runRepo.markFailed(run_id, 'U5_GATE_ERROR');
    } catch {
      // ignore
    }
  }
}
