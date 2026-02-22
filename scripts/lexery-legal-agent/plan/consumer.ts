/**
 * U3 / U3a Plan consumer (LEX-112, LEX-113)
 * U3: rules engine → SearchPlan, persist + RunContext, enqueue U3a
 * U3a: build SearchSteps from SearchPlan, persist steps + next_step, enqueue U4
 */
import type { RunEvent } from '../gateway/types.js';
import { RunRepository } from '../gateway/storage.js';
import { getTaskQueue } from '../gateway/handler.js';
import { logger } from '../lib/logger.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import {
  incrementU3Processed,
  incrementU3Failed,
  recordU3Duration,
  incrementU3aProcessed,
  incrementU3aFailed,
  recordU3aStepsCount,
} from '../gateway/observability.js';
import { buildSearchPlanFromProfile } from './rules.js';
import { buildSearchSteps } from './builder.js';
import type { SearchPlan, RunRecordSearchPlanAudit } from './types.js';
import type { QueryProfile } from '../classify/types.js';

const runRepo = new RunRepository();
const PLAN_CONTEXT_TTL_SEC = 3600;

export async function handleU3Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U3') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U3', trace_id, module: 'plan/consumer' };
  const start = Date.now();

  try {
    const run = await runRepo.findByRunId(run_id);
    if (!run) {
      logger.error('U3 run not found', { ...ctx, error: 'run_not_found' });
      incrementU3Failed();
      return;
    }

    const queryProfile = (run.query_profile ?? null) as QueryProfile | null;
    const routingFlags = queryProfile?.routing_flags;

    const { plan, reason_codes } = buildSearchPlanFromProfile(queryProfile, routingFlags);

    const audit: RunRecordSearchPlanAudit = {
      plan,
      built_at: new Date().toISOString(),
    };

    await runRepo.updateSearchPlan(run_id, audit as unknown as object, 'Planning');

    const existing = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      { ...existing, search_plan: plan } as Record<string, unknown>,
      PLAN_CONTEXT_TTL_SEC
    );

    recordU3Duration(Date.now() - start);
    incrementU3Processed();

    logger.info('U3 finished', {
      ...ctx,
      duration_ms: Date.now() - start,
      plan_version: plan.version,
      reasons: reason_codes,
      sources: plan.sources,
      query_length: run.query?.length ?? 0,
    });

    const now = new Date().toISOString();
    const taskQueue = getTaskQueue();
    await taskQueue.enqueue({
      run_id,
      step: 'U3a',
      created_at: now,
      trace_id,
    });
    logger.info('U3a enqueued', { run_id, trace_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U3 failed', { ...ctx, error: msg });
    incrementU3Failed();
    try {
      await runRepo.markFailed(run_id, 'U3_PLAN_ERROR');
    } catch {
      // ignore
    }
  }
}

export async function handleU3aEvent(event: RunEvent): Promise<void> {
  if (event.step !== 'U3a') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U3a', trace_id, module: 'plan/consumer' };
  const start = Date.now();

  try {
    const run = await runRepo.findByRunId(run_id);
    if (!run) {
      logger.error('U3a run not found', { ...ctx, error: 'run_not_found' });
      incrementU3aFailed();
      return;
    }

    let plan: SearchPlan;
    const existingCtx = (await runContextGet<{ search_plan?: SearchPlan }>(run_id)) ?? null;
    if (existingCtx?.search_plan) {
      plan = existingCtx.search_plan;
    } else {
      const audit = run.search_plan as RunRecordSearchPlanAudit | null | undefined;
      if (!audit?.plan) {
        logger.error('U3a no search_plan', { ...ctx, error: 'missing_plan' });
        incrementU3aFailed();
        return;
      }
      plan = audit.plan;
    }

    const steps = buildSearchSteps(plan);
    recordU3aStepsCount(steps.length);

    const audit: RunRecordSearchPlanAudit = {
      plan,
      steps,
      built_at: new Date().toISOString(),
      next_step: 'U4',
    };

    await runRepo.updateSearchPlan(run_id, audit as unknown as object, 'Planning');

    const mergedCtx = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      { ...mergedCtx, search_plan: plan, search_steps: steps } as Record<string, unknown>,
      PLAN_CONTEXT_TTL_SEC
    );

    incrementU3aProcessed();

    logger.info('U3a finished', {
      ...ctx,
      duration_ms: Date.now() - start,
      steps_count: steps.length,
      step_kinds: steps.map((s) => s.kind),
      next_step: 'U4',
    });

    const now = new Date().toISOString();
    const taskQueue = getTaskQueue();
    await taskQueue.enqueue({
      run_id,
      step: 'U4',
      created_at: now,
      trace_id,
    });
    logger.info('U4 enqueued', { run_id, trace_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U3a failed', { ...ctx, error: msg });
    incrementU3aFailed();
    try {
      await runRepo.markFailed(run_id, 'U3A_BUILDER_ERROR');
    } catch {
      // ignore
    }
  }
}
