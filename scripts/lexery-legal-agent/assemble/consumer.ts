/**
 * U9 Assemble — handleU9Event: build AssembledPrompt, persist to DB + RunContext, enqueue U10 (LEX-132)
 */
import type { RunEvent } from '../gateway/types.js';
import type { RunContext, U4Result, GateDecision, AssembledPrompt, DocSnippetRef } from '../lib/pipeline/contracts.js';
import type { RetrievalTrace, RawHit } from '../retrieval/types.js';
import type { QueryProfile } from '../classify/types.js';
import type { SearchPlan } from '../plan/types.js';
import { getTaskQueue } from '../gateway/handler.js';
import { logger } from '../lib/logger.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import { assemblePrompt } from './assemblePrompt.js';
import { RunRepository, type RunSourceSummary } from '../gateway/storage.js';
import { withTransientGatewayIoRetry } from '../gateway/retry.js';
import { config } from '../lib/config.js';
import { retrieveMmDocsForQuery } from '../mm/doc/retrieve.js';
import { ingestMmDocsFromRun } from '../mm/doc/from-run.js';
import { getMmDocScopeAvailability, isTransientMmDocStoreError } from '../mm/doc/store.js';
import { isExplicitUserDocumentQuery } from '../lib/queryScopeHints.js';

const RUN_CONTEXT_TTL_SEC = 3600;
const repo = new RunRepository();

export function isTransientMmDocsContextError(error: unknown): boolean {
  if (isTransientMmDocStoreError(error)) return true;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /MM Docs Qdrant .* failed|AbortError|timed out|timeout|503|502|429|fetch failed|network/i.test(message);
}

export async function withTransientMmDocsContextRetry<T>(
  fn: () => Promise<T>,
  attempts = 2,
  baseDelayMs = 150
): Promise<T> {
  const maxAttempts = Math.max(1, attempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientMmDocsContextError(error) || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function shouldRetrieveMmDocsContext(params: {
  hasDocCandidates: boolean;
  requestedScope?: 'conversation' | 'project' | 'user_global' | null;
  explicitDocQuery: boolean;
  availability: { conversation: boolean; project: boolean; user_global: boolean };
  planUsesLegalSources: boolean;
}): boolean {
  if (params.hasDocCandidates) return true;
  if (params.requestedScope != null) return true;
  if (params.explicitDocQuery) return true;
  return false;
}

export async function loadRunRecordForU9(params: {
  runId: string;
  traceId?: string;
}): Promise<Awaited<ReturnType<RunRepository['findByRunId']>>> {
  try {
    return await withTransientGatewayIoRetry(() => repo.findByRunId(params.runId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('U9 run lookup failed; continuing with degraded snapshot context', {
      run_id: params.runId,
      trace_id: params.traceId,
      module: 'assemble/consumer',
      error: message,
    });
    return null;
  }
}

async function loadMmDocContext(params: {
  runId: string;
  runContext: RunContext;
  snapshot?: { project_context?: { mm_doc_scope?: 'conversation' | 'project' | 'user_global' | null } } | null;
  attachmentsManifest?: Array<{ mm_doc_candidate?: boolean }> | null;
}): Promise<{
  snippets: DocSnippetRef[];
  trace: NonNullable<RunContext['doc_trace']>;
}> {
  const requestedScope = params.snapshot?.project_context?.mm_doc_scope ?? null;
  const hasDocCandidates = (params.attachmentsManifest ?? []).some((item) => item.mm_doc_candidate === true);
  const enabled = config.mmDocsEnabled && !!params.runContext.user_id && !!params.runContext.user_input;
  const explicitDocQuery = isExplicitUserDocumentQuery(params.runContext.user_input ?? '');
  const planSources =
    params.runContext.search_plan?.plan && typeof params.runContext.search_plan.plan === 'object'
      ? (params.runContext.search_plan.plan.sources as Record<string, unknown> | undefined)
      : undefined;
  const planStepKinds = Array.isArray(params.runContext.search_plan?.steps)
    ? params.runContext.search_plan?.steps.map((step) => String((step as { kind?: unknown }).kind ?? ''))
    : [];
  const planUsesLegalSources =
    planSources?.use_lldbi === true ||
    planSources?.use_doclist === true ||
    planSources?.use_web === true ||
    planStepKinds.some((kind) => kind.startsWith('lldbi') || kind === 'doclist' || kind === 'web');

  if (!enabled) {
    return {
      snippets: [],
      trace: {
        enabled: false,
        requested_scope: requestedScope,
        ingested_count: 0,
        retrieved_count: 0,
        latency_ms: 0,
        warnings: [],
      },
    };
  }

  const warnings: string[] = [];
  const startedAt = Date.now();
  let ingestedCount = 0;

  if (hasDocCandidates) {
    try {
      const ingested = await ingestMmDocsFromRun({
        runId: params.runId,
        tenantId: params.runContext.tenant_id,
        userId: params.runContext.user_id,
        conversationId: params.runContext.conversation_id ?? null,
        projectId: params.runContext.project_id ?? null,
        snapshot: params.snapshot ?? null,
        attachmentsManifest: params.attachmentsManifest ?? null,
      });
      ingestedCount = ingested.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(message);
      logger.warn('U9 MM Docs ingest failed (non-fatal)', {
        run_id: params.runId,
        error: message,
      });
    }
  }

  let availability = {
    conversation: false,
    project: false,
    user_global: false,
  };
  try {
    availability = await withTransientMmDocsContextRetry(() =>
      getMmDocScopeAvailability({
        tenantId: params.runContext.tenant_id,
        userId: params.runContext.user_id,
        conversationId: params.runContext.conversation_id ?? null,
        projectId: params.runContext.project_id ?? null,
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(message);
    logger.warn('U9 MM Docs availability probe failed (non-fatal)', {
      run_id: params.runId,
      error: message,
    });
  }

  const shouldRetrieve = shouldRetrieveMmDocsContext({
    hasDocCandidates,
    requestedScope,
    explicitDocQuery,
    availability,
    planUsesLegalSources,
  });

  const skipRetrievalForMemoryOnlyTurn =
    params.runContext.query_profile?.routing_flags?.context_mode === 'memory' &&
    !isExplicitUserDocumentQuery(params.runContext.user_input ?? '');

  if (!shouldRetrieve || skipRetrievalForMemoryOnlyTurn) {
    return {
      snippets: [],
      trace: {
        enabled: shouldRetrieve,
        requested_scope: requestedScope,
        ingested_count: ingestedCount,
        retrieved_count: 0,
        latency_ms: Date.now() - startedAt,
        warnings: skipRetrievalForMemoryOnlyTurn ? [...warnings, 'SKIPPED_FOR_MEMORY_ONLY_TURN'] : warnings,
      },
    };
  }

  let retrieved: Awaited<ReturnType<typeof retrieveMmDocsForQuery>> = [];
  try {
    retrieved = await withTransientMmDocsContextRetry(() =>
      retrieveMmDocsForQuery({
        queryText: params.runContext.user_input ?? '',
        tenantId: params.runContext.tenant_id,
        userId: params.runContext.user_id,
        conversationId: params.runContext.conversation_id ?? null,
        projectId: params.runContext.project_id ?? null,
        requestedScope,
        runId: params.runId,
        topK: config.mmDocsTopK,
        availability,
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(message);
    logger.warn('U9 MM Docs retrieve failed (non-fatal)', {
      run_id: params.runId,
      error: message,
    });
  }

  return {
    snippets: retrieved.map((hit) => ({
      doc_id: hit.doc_id,
      text: hit.text,
      score: hit.score,
      r2_key: hit.r2_key,
      json_path: hit.json_path,
      scope_type: hit.scope_type,
      scope_id: hit.scope_id ?? null,
      filename: hit.filename,
      title: hit.title,
    })),
    trace: {
      enabled: true,
      requested_scope: requestedScope,
      ingested_count: ingestedCount,
      retrieved_count: retrieved.length,
      latency_ms: Date.now() - startedAt,
      warnings,
    },
  };
}

export async function handleU9Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U9') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U9', trace_id, module: 'assemble/consumer' };
  const startMs = Date.now();

  try {
    const stored = await runContextGet<Record<string, unknown>>(run_id);
    const runFromDb = await loadRunRecordForU9({ runId: run_id, traceId: trace_id });
    const retrievalTrace = stored?.retrieval_trace as RetrievalTrace | null | undefined;
    const rawHits = stored?.raw_hits as RawHit[] | undefined;
    const queryProfile = stored?.query_profile as QueryProfile | null | undefined;
    const searchPlan = stored?.search_plan as SearchPlan | null | undefined;
    const gateDecision = stored?.gate_decision as GateDecision | null | undefined;
    const history = stored?.history as Array<{ role: string; content: string }> | undefined;
    const memoryItems = stored?.memory_items;
    const memorySummaries = stored?.memory_summaries;
    const userInput = stored?.user_input as string | undefined;

    if (!retrievalTrace || !gateDecision) {
      logger.warn('U9 missing retrieval_trace or gate_decision', { ...ctx });
    }

    const runContext: RunContext = {
      run_id,
      tenant_id: (stored?.tenant_id as string | null) ?? null,
      user_id: (stored?.user_id as string) ?? '',
      conversation_id: (stored?.conversation_id as string | null) ?? null,
      project_id: (stored?.project_id as string | null) ?? null,
      user_input: userInput,
      history,
      memory_items: Array.isArray(memoryItems) ? memoryItems as RunContext['memory_items'] : undefined,
      memory_summaries: Array.isArray(memorySummaries) ? memorySummaries as RunContext['memory_summaries'] : undefined,
      memory_trace: stored?.memory_trace as RunContext['memory_trace'],
      query_profile: queryProfile ?? null,
      search_plan: searchPlan ?? null,
      retrieval_trace: retrievalTrace ?? null,
      raw_hits: Array.isArray(rawHits) ? rawHits : undefined,
      gate_decision: gateDecision ?? null,
    };

    const mmDocs = await loadMmDocContext({
      runId: run_id,
      runContext,
      snapshot: (runFromDb?.snapshot as { project_context?: { mm_doc_scope?: 'conversation' | 'project' | 'user_global' | null } } | null | undefined) ?? null,
      attachmentsManifest: runFromDb?.attachments_manifest ?? null,
    });
    runContext.doc_snippets = mmDocs.snippets;
    runContext.doc_trace = mmDocs.trace;

    const u4: U4Result = {
      rawHits: Array.isArray(rawHits) ? rawHits : [],
      retrievalTrace: retrievalTrace ?? { version: 1, hits: [] },
    };

    const assembled: AssembledPrompt = await assemblePrompt({
      runContext,
      u4,
      gate: gateDecision ?? {
        expand: false,
        reason_codes: ['OK'],
        thresholds: { min_hits: 3, min_avg_score: 0.18 },
        signals: { hits_count: 0, top_score: null, avg_score: null },
        meta: {},
      },
    });

    // Persist compact assembled_prompt meta to DB (durable for multi-instance crash recovery)
    const assembledMeta = {
      assembledAt: assembled.meta?.assembledAt,
      sourcesSummary: assembled.meta?.sourcesSummary,
      tokenEstimateTotal: assembled.meta?.budget?.tokenEstimateTotal,
      tokenEstimateByChannel: assembled.meta?.budget?.tokenEstimateByChannel,
      truncated: assembled.meta?.budget?.truncated ?? false,
      droppedChannels: assembled.meta?.budget?.droppedChannels ?? [],
      loadErrorsCount: assembled.meta?.loadErrorsCount ?? 0,
      degraded: assembled.meta?.degraded ?? false,
      sources: assembled.meta?.sources,
      lawSourceRefs: assembled.meta?.lawSourceRefs ?? [],
    };
    await repo.updateAssembledPrompt(run_id, assembledMeta);

    // Authoritative source summary: persist counts as soon as U9 has them (so completed runs have real counts even if U12 is delayed/failed)
    const sourceSummary: RunSourceSummary = {
      context_mode: queryProfile?.routing_flags?.context_mode ?? null,
      history_count: assembled.meta?.sources?.historyCount ?? null,
      memory_count: assembled.meta?.sources?.memoryCount ?? null,
      law_count: assembled.meta?.sources?.lawCount ?? null,
      document_count: assembled.meta?.sources?.docCount ?? null,
      triage_used: null,
      prompt_tokens: null,
      memory_scope_mode: null,
      memory_fallback_used: null,
    };
    await repo.patchRunSourceSummary(run_id, sourceSummary);

    // DEV RUN v16: persist u9_meta_triage to snapshot for forensics
    if (assembled.meta?.u9MetaTriage) {
      await repo.patchSnapshotField(run_id, 'u9_meta_triage', assembled.meta.u9MetaTriage);
    }
    if (assembled.meta?.sources?.docCount || (mmDocs.trace.warnings?.length ?? 0) > 0) {
      await repo.patchSnapshotField(run_id, 'u9_doc_trace', mmDocs.trace);
    }

    // Store full assembled_prompt in RunContext (in-memory; used by U10 directly)
    const merged = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      { ...merged, assembled_prompt: assembled } as Record<string, unknown>,
      RUN_CONTEXT_TTL_SEC
    );

    const latencyMs = Date.now() - startMs;
    const meta = assembled.meta;
    const historyUsed = assembled.contextParts.filter((p) => p.type === 'history').length;
    const memoryUsed = assembled.contextParts.filter((p) => p.type === 'memory').length;
    const docUsed = assembled.contextParts.filter((p) => p.type === 'doc').length;
    const lawUsed = assembled.contextParts.filter((p) => p.type === 'law').length;

    logger.info('U9 finished', {
      ...ctx,
      // Metadata only — no snippet text, no prompt content
      law_hits_raw: u4.rawHits.length,
      law_snippets_loaded: lawUsed,
      law_snippets_missing: meta?.loadErrorsCount ?? 0,
      memory_items_count: (runContext.memory_items ?? []).length,
      memory_summaries_count: (runContext.memory_summaries ?? []).length,
      doc_snippets_count: (runContext.doc_snippets ?? []).length,
      doc_parts_used: docUsed,
      history_messages_used: historyUsed,
      memory_parts_used: memoryUsed,
      tokenEstimateTotal: meta?.budget?.tokenEstimateTotal ?? 0,
      truncation_truncated: meta?.budget?.truncated ?? false,
      degraded: meta?.degraded ?? false,
      u9_latency_ms: latencyMs,
      contextPartsCount: assembled.contextParts.length,
      sourcesSummary: meta?.sourcesSummary,
      userPromptLength: (assembled.userPrompt ?? '').length,
    });

    const now = new Date().toISOString();
    const taskQueue = getTaskQueue();
    await taskQueue.enqueue({ run_id, step: 'U10', created_at: now, trace_id });
    logger.info('U10 enqueued', { run_id, trace_id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U9 failed', { ...ctx, error: msg, u9_latency_ms: Date.now() - startMs });
    throw err;
  }
}
