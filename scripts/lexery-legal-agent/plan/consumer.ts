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
import {
  hasExplicitLegalReferenceRequest,
  hasExplicitMemoryRecallRequest,
  isDocumentUploadIntentQuery,
  isExplicitUserDocumentQuery,
} from '../lib/queryScopeHints.js';

const runRepo = new RunRepository();
const PLAN_CONTEXT_TTL_SEC = 3600;

export function isTransientPlanIoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|network/i.test(msg);
}

export async function withTransientPlanIoRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientPlanIoError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await fn();
  }
}

export function shouldPreferMmDocsOnlyPlan(params: {
  query: string;
  snapshot?: { project_context?: { project_id?: string | null; mm_doc_scope?: 'conversation' | 'project' | 'user_global' | null } } | null;
  attachmentsManifest?: Array<{ mm_doc_candidate?: boolean }> | null;
}): boolean {
  const explicitLegalReference = hasExplicitLegalReferenceRequest(params.query);
  if (explicitLegalReference) return false;
  if (isExplicitUserDocumentQuery(params.query)) return true;
  const requestedMmDocScope = params.snapshot?.project_context?.mm_doc_scope ?? null;
  if (requestedMmDocScope === 'conversation' || requestedMmDocScope === 'project' || requestedMmDocScope === 'user_global') {
    return true;
  }
  const hasMmDocAttachment = (params.attachmentsManifest ?? []).some((item) => item.mm_doc_candidate === true);
  if (hasMmDocAttachment) return true;
  if (hasMmDocAttachment && isDocumentUploadIntentQuery(params.query)) return true;
  return false;
}

export function applyMmDocsOnlyPlanOverride(params: {
  plan: SearchPlan;
  reasonCodes: string[];
  query: string;
  contextMode?: string | null;
  snapshot?: { project_context?: { project_id?: string | null; mm_doc_scope?: 'conversation' | 'project' | 'user_global' | null } } | null;
  attachmentsManifest?: Array<{ mm_doc_candidate?: boolean }> | null;
}): { plan: SearchPlan; reasonCodes: string[] } {
  if (!shouldPreferMmDocsOnlyPlan(params)) {
    return { plan: params.plan, reasonCodes: params.reasonCodes };
  }
  const preserveMemory =
    (params.contextMode === 'memory' || params.contextMode === 'mixed') &&
    hasExplicitMemoryRecallRequest(params.query);
  const plan: SearchPlan = {
    ...params.plan,
    sources: {
      ...params.plan.sources,
      use_lldbi: false,
      use_memory: preserveMemory,
      use_doclist: false,
      use_web: false,
    },
  };
  const reasonCodes = [...params.reasonCodes];
  if (!reasonCodes.includes('mm_docs_only_scope')) {
    reasonCodes.push('mm_docs_only_scope');
  }
  plan.reason_codes = reasonCodes;
  return { plan, reasonCodes };
}

export async function handleU3Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U3') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U3', trace_id, module: 'plan/consumer' };
  const start = Date.now();

  try {
    const run = await withTransientPlanIoRetry(() => runRepo.findByRunId(run_id));
    if (!run) {
      logger.error('U3 run not found', { ...ctx, error: 'run_not_found' });
      incrementU3Failed();
      return;
    }

    const queryProfile = (run.query_profile ?? null) as QueryProfile | null;
    const routingFlags = queryProfile?.routing_flags;

    let { plan, reason_codes } = buildSearchPlanFromProfile(queryProfile, routingFlags);
    ({ plan, reasonCodes: reason_codes } = applyMmDocsOnlyPlanOverride({
      plan,
      reasonCodes: reason_codes,
      query: run.query ?? '',
      contextMode: queryProfile?.routing_flags?.context_mode ?? null,
      snapshot: (run.snapshot as { project_context?: { project_id?: string | null; mm_doc_scope?: 'conversation' | 'project' | 'user_global' | null } } | null | undefined) ?? null,
      attachmentsManifest: run.attachments_manifest ?? null,
    }));

    const audit: RunRecordSearchPlanAudit = {
      plan,
      built_at: new Date().toISOString(),
    };

    await withTransientPlanIoRetry(() =>
      runRepo.updateSearchPlan(run_id, audit as unknown as object, 'Planning')
    );

    const existing = await withTransientPlanIoRetry(
      async () => (await runContextGet<Record<string, unknown>>(run_id)) ?? {}
    );
    await withTransientPlanIoRetry(() =>
      runContextSet(
        run_id,
        { ...existing, search_plan: plan } as Record<string, unknown>,
        PLAN_CONTEXT_TTL_SEC
      )
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
    const run = await withTransientPlanIoRetry(() => runRepo.findByRunId(run_id));
    if (!run) {
      logger.error('U3a run not found', { ...ctx, error: 'run_not_found' });
      incrementU3aFailed();
      return;
    }

    let plan: SearchPlan;
    const existingCtx = await withTransientPlanIoRetry(
      async () => (await runContextGet<{ search_plan?: SearchPlan }>(run_id)) ?? null
    );
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

    await withTransientPlanIoRetry(() =>
      runRepo.updateSearchPlan(run_id, audit as unknown as object, 'Planning')
    );

    const mergedCtx = await withTransientPlanIoRetry(
      async () => (await runContextGet<Record<string, unknown>>(run_id)) ?? {}
    );
    await withTransientPlanIoRetry(() =>
      runContextSet(
        run_id,
        { ...mergedCtx, search_plan: plan, search_steps: steps } as Record<string, unknown>,
        PLAN_CONTEXT_TTL_SEC
      )
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
