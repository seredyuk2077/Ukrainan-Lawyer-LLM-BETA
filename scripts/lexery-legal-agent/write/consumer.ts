/**
 * U10 Legal Agent — handleU10Event: runLegalAgent or return existing result, persist, enqueue U11 (LEX-133)
 *
 * DEV RUN v8:
 *   - Reads prompt_stack from RunContext (sourced from runs.snapshot.prompt_stack)
 *   - Evidence insufficient policy: 0 law snippets or degraded → warns LLM, adds prefix
 *   - Memory readiness: logs memory counts, degraded flag
 *   - Composer: logs latency_ms + model + used flag
 *   - Idempotent: durable llm_result in DB + claim (multi-instance). dry_run → stub, no LLM, no composer.
 *   - Stateless handler; no shared mutable state.
 */
import { createHash } from 'crypto';
import type { RunEvent } from '../gateway/types.js';
import type {
  RunContext,
  AssembledPrompt,
  LegalAgentResult,
  PromptStack,
  ContextPart,
  LawSourceRef,
} from '../lib/pipeline/contracts.js';
import { getTaskQueue } from '../gateway/handler.js';
import { RunRepository } from '../gateway/storage.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import { incrementU10Success, incrementU10Fail, recordU10LatencyMs } from '../gateway/observability.js';
import {
  runLegalAgent,
  isEvidenceInsufficient,
  buildMessagesFromAssembled,
  buildU10PromptDebug,
  repairCitationAnswer,
  repairCompactAnswer,
  judgeMemoryRecallGrounded,
  regenerateMemoryRecallGrounded,
  regenerateDocOnlyGrounded,
} from './legalAgent.js';
import { composeInstructions } from './promptComposer.js';
import { triageEvidence, type TriageResult } from './evidenceTriage.js';
import { searchMemoryTool, formatMemorySearchSection, shouldTriggerMemorySearchTool } from './memorySearch.js';
import { buildFocusSpec, enforceFocusOnContextParts, resolveFocusContextMode } from './focusSpec.js';
import {
  validateOutput,
  countArticleRefs,
  stripGratuitousLegalCitation,
  sanitizeUnsupportedDocAbsenceAnswer,
  sanitizeDocsOnlyNoEvidenceAnswer,
  hasFalseDocAbsenceClaim,
} from './outputValidator.js';

const RUN_CONTEXT_TTL_SEC = 3600;
const runRepo = new RunRepository();

/** DEV RUN v16: extract stable source IDs from law context parts for u10_selection persistence. */
function getLawSourceIds(parts: ContextPart[]): string[] {
  return parts
    .filter((p) => p.type === 'law')
    .map((p) => {
      const ref = p.sourceRef as LawSourceRef | undefined;
      if (ref?.r2_key && ref?.json_path) return `${ref.r2_key}::${ref.json_path}`;
      return (p.sourceIds?.[0] as string) ?? '';
    })
    .filter(Boolean);
}

function buildStubResult(modelId: string): LegalAgentResult {
  return {
    answerText: '[DRY_RUN] Legal agent disabled in verify mode.',
    model: modelId,
    latencyMs: 0,
  };
}

export async function handleU10Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U10') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U10', trace_id, module: 'write/consumer' };
  let llmResultPersisted = false;

  try {
    const stored = await runContextGet<Record<string, unknown>>(run_id);
    const assembled = stored?.assembled_prompt as AssembledPrompt | undefined;
    if (!assembled?.systemPrompt) {
      logger.warn('U10 missing assembled_prompt', ctx);
      throw new Error('U10: assembled_prompt required');
    }

    // 1) Already done (durable): read from DB first (multi-instance safe)
    const runFromDb = await runRepo.findByRunId(run_id);
    const existingInDb = runFromDb?.llm_result as LegalAgentResult | undefined;
    if (existingInDb?.answerText != null) {
      logger.info('U10 idempotent skip (llm_result in DB)', {
        ...ctx,
        model: existingInDb.model,
        latency_ms: existingInDb.latencyMs,
      });
      await enqueueU11(run_id, trace_id);
      return;
    }
    const existingInContext = stored?.llm_result as LegalAgentResult | undefined;
    if (existingInContext?.answerText != null) {
      logger.info('U10 idempotent skip (llm_result in context)', {
        ...ctx,
        model: existingInContext.model,
        latency_ms: existingInContext.latencyMs,
      });
      await enqueueU11(run_id, trace_id);
      return;
    }

    const dryRun =
      config.legalAgentDisableLlm ||
      (runFromDb?.snapshot as { flags?: { dry_run?: boolean } } | undefined)?.flags?.dry_run === true;

    if (dryRun && !config.u10DryRunKeepTriage) {
      const result = buildStubResult(config.legalAgentModelId);

      // U10 Preview Mode: when U10_PREVIEW_MESSAGES=true, persist prompt metadata (hashes/counts/lengths)
      // to runs.snapshot.u10_preview for verification without real LLM calls.
      const previewEnabled = process.env.U10_PREVIEW_MESSAGES === 'true';
      if (previewEnabled) {
        try {
          const snapshotPromptStack =
            (runFromDb?.snapshot as { prompt_stack?: PromptStack } | undefined)?.prompt_stack;
          const contextPromptStack = stored?.prompt_stack as PromptStack | undefined;
          const previewPromptStack: PromptStack | undefined = snapshotPromptStack ?? contextPromptStack;
          const previewRunContext: RunContext = {
            run_id,
            tenant_id: (stored?.tenant_id as string | null) ?? null,
            user_id: (stored?.user_id as string) ?? '',
            conversation_id: (stored?.conversation_id as string | null) ?? null,
            project_id: (stored?.project_id as string | null) ?? null,
            user_input: stored?.user_input as string | undefined,
            history: stored?.history as RunContext['history'],
            memory_items: stored?.memory_items as RunContext['memory_items'],
            memory_summaries: stored?.memory_summaries as RunContext['memory_summaries'],
            memory_trace: stored?.memory_trace as RunContext['memory_trace'],
            query_profile:
              (stored?.query_profile as RunContext['query_profile']) ??
              ((runFromDb?.query_profile as RunContext['query_profile']) ?? null),
            search_plan:
              (stored?.search_plan as RunContext['search_plan']) ??
              ((runFromDb?.search_plan as RunContext['search_plan']) ?? null),
            gate_decision: stored?.gate_decision as RunContext['gate_decision'],
            retrieval_trace:
              (stored?.retrieval_trace as RunContext['retrieval_trace']) ??
              ((runFromDb?.retrieval_trace as RunContext['retrieval_trace']) ?? null),
            prompt_stack: previewPromptStack,
          };
          const previewEvidenceInsufficient = isEvidenceInsufficient(assembled, previewRunContext);
          const previewCoverageGap = previewRunContext.retrieval_trace?.meta?.coverage_gap;
          const messages = buildMessagesFromAssembled(assembled, {
            promptStack: previewPromptStack,
            evidenceInsufficient: previewEvidenceInsufficient,
            coverageGap: previewCoverageGap,
            contextTruncated: assembled.meta?.budget?.truncated === true,
          });
          const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
          const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
          const systemHash = createHash('sha256').update(systemMsg).digest('hex');
          const userHash = createHash('sha256').update(userMsg).digest('hex');
          const ps = previewPromptStack;
          const u10Preview = {
            model: config.legalAgentModelId,
            prompt_stack_keys: Object.entries(ps ?? {}).filter(([, v]) => v).map(([k]) => k),
            evidence_insufficient: previewEvidenceInsufficient,
            coverage_gap: previewCoverageGap ?? 'none',
            context_truncated: assembled.meta?.budget?.truncated === true,
            counts: {
              law: assembled.meta?.sources?.lawCount ?? 0,
              doc: assembled.meta?.sources?.docCount ?? 0,
              memory: assembled.meta?.sources?.memoryCount ?? 0,
              history: assembled.meta?.sources?.historyCount ?? 0,
            },
            prompt_stack_lengths: {
              global: ps?.global?.length,
              project: ps?.project?.length,
              chat: ps?.chat?.length,
              user: ps?.user?.length,
            },
            system_hash: systemHash,
            user_hash: userHash,
            system_prefix: systemMsg.slice(0, 200),
            user_prefix: userMsg.slice(0, 200),
            composer_skipped: previewEvidenceInsufficient,
            created_at: new Date().toISOString(),
          };
          await runRepo.patchSnapshotField(run_id, 'u10_preview', u10Preview);
          logger.info('U10 preview saved', {
            ...ctx,
            system_hash: systemHash.slice(0, 16),
            user_hash: userHash.slice(0, 16),
            evidence_insufficient: previewEvidenceInsufficient,
            prompt_stack_keys: u10Preview.prompt_stack_keys,
            counts: u10Preview.counts,
          });
        } catch (previewErr) {
          // Non-fatal: preview failure must never block the pipeline
          logger.warn('U10 preview failed (non-fatal)', {
            ...ctx,
            error: previewErr instanceof Error ? previewErr.message : String(previewErr),
          });
        }
      }

      try {
        await runRepo.updateLlmResult(run_id, result);
      } catch {
        // DB may not have llm_result column yet; still persist to context
      }
      const merged = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
      await runContextSet(
        run_id,
        { ...merged, llm_result: result } as Record<string, unknown>,
        RUN_CONTEXT_TTL_SEC
      );
      logger.info('U10 dry_run stub', { ...ctx, model: result.model, dry_run: true, preview_mode: previewEnabled, status: 'ok' });
      incrementU10Success();
      await enqueueU11(run_id, trace_id);
      return;
    }

    // 2) Claim run (only one instance proceeds to LLM).
    const claimed = await runRepo.claimU10Run(run_id);
    if (!claimed) {
      const runAgain = await runRepo.findByRunId(run_id);
      const otherResult = runAgain?.llm_result as LegalAgentResult | undefined;
      if (otherResult?.answerText != null) {
        logger.info('U10 claim lost, another instance wrote result', { ...ctx });
        await enqueueU11(run_id, trace_id);
        return;
      }
      // Column may be missing or race; proceed without claim
    }

    // 3) Build RunContext for this step
    const snapshotPromptStack = (runFromDb?.snapshot as { prompt_stack?: PromptStack } | undefined)?.prompt_stack;
    const contextPromptStack = stored?.prompt_stack as PromptStack | undefined;
    const promptStack: PromptStack | undefined = snapshotPromptStack ?? contextPromptStack;

    const runContext: RunContext = {
      run_id,
      tenant_id: (stored?.tenant_id as string | null) ?? null,
      user_id: (stored?.user_id as string) ?? '',
      conversation_id: (stored?.conversation_id as string | null) ?? null,
      project_id: (stored?.project_id as string | null) ?? null,
      user_input: stored?.user_input as string | undefined,
      history: stored?.history as RunContext['history'],
      memory_items: stored?.memory_items as RunContext['memory_items'],
      memory_summaries: stored?.memory_summaries as RunContext['memory_summaries'],
      memory_trace: stored?.memory_trace as RunContext['memory_trace'],
      query_profile:
        (stored?.query_profile as RunContext['query_profile']) ??
        ((runFromDb?.query_profile as RunContext['query_profile']) ?? null),
      search_plan:
        (stored?.search_plan as RunContext['search_plan']) ??
        ((runFromDb?.search_plan as RunContext['search_plan']) ?? null),
      gate_decision: stored?.gate_decision as RunContext['gate_decision'],
      prompt_stack: promptStack,
    };

    // 4) Memory log: retrieved (upstream) vs assembled (injected into prompt)
    const retrieved_memory_items_count = (runContext.memory_items ?? []).length;
    const retrieved_memory_summaries_count = (runContext.memory_summaries ?? []).length;
    const assembled_memory_parts_used = assembled.meta?.sources?.memoryCount ?? 0;
    const memoryDegraded = runContext.memory_trace?.degraded === true;
    if (retrieved_memory_items_count > 0 || retrieved_memory_summaries_count > 0 || assembled_memory_parts_used > 0) {
      logger.info('U10 memory: retrieved vs assembled', {
        ...ctx,
        retrieved_memory_items_count,
        retrieved_memory_summaries_count,
        assembled_memory_parts_used,
        memory_degraded: memoryDegraded,
      });
    } else if (memoryDegraded) {
      logger.warn('U10 memory degraded', { ...ctx, memory_degraded: true });
    }

    // 5) Evidence insufficient check (DEV RUN v16: no longer from gate.expand)
    let evidenceInsufficient = isEvidenceInsufficient(assembled, runContext);
    const gateExpand = runContext.gate_decision?.expand === true;
    if (evidenceInsufficient) {
      logger.warn('U10 evidence insufficient', {
        ...ctx,
        law_count: assembled.meta?.sources?.lawCount ?? 0,
        degraded: assembled.meta?.degraded ?? false,
        coverage_gap: runContext.retrieval_trace?.meta?.coverage_gap ?? 'none',
      });
    }

    // 6a) Focus spec (deterministic primary norm + max snippets) — DEV RUN v14; memory_recall when context_mode=memory
    const rawContextMode =
      (runContext.query_profile as { routing_flags?: { context_mode?: 'law' | 'memory' | 'mixed' } } | undefined)
        ?.routing_flags?.context_mode ??
      (runContext.search_plan?.sources?.use_memory && !runContext.search_plan?.sources?.use_lldbi
        ? 'memory'
        : undefined);
    const contextMode = resolveFocusContextMode({
      rawContextMode,
      docCount: assembled.meta?.sources?.docCount ?? 0,
      memoryCount: assembled.meta?.sources?.memoryCount ?? 0,
    });
    const focusSpec = buildFocusSpec(
      runContext.user_input ?? '',
      assembled.meta,
      gateExpand,
      contextMode,
      {
        mmDocsOnlyPlan: (runContext.search_plan?.reason_codes ?? []).includes('mm_docs_only_scope'),
      }
    );
    logger.info('U10 focusSpec', {
      ...ctx,
      task_type: focusSpec.taskType,
      primary_norm_source_id: focusSpec.primaryNormSourceId ?? null,
      primary_confidence: focusSpec.primaryNormConfidence,
      max_law_snippets: focusSpec.maxLawSnippets,
    });
    if (focusSpec.taskType === 'memory_recall') {
      const mem = assembled.meta?.sources?.memoryCount ?? 0;
      const hist = assembled.meta?.sources?.historyCount ?? 0;
      if (mem > 0 || hist > 0) evidenceInsufficient = false;
    }

    // DEV RUN v16: selection snapshot for observability
    const lawSourceIdsBefore = getLawSourceIds(assembled.contextParts);

    // 6b) Evidence Triage — run when (real) law count above threshold or gate.expand (force triage)
    let assembledForAgent = assembled;
    let triageUsed = false;
    let triageSelectedCount: number | undefined;
    let triageDroppedCount: number | undefined;
    let triageModel: string | undefined;
    let triageLatencyMs: number | undefined;
    let triageParseOk: boolean | undefined;
    let triageReasonCode: string | null | undefined;
    let triageFinishReason: string | null | undefined;
    let triageRawContentType: string | null | undefined;
    let triageReasoningTokens: number | null | undefined;
    let triageAttempts: number | undefined;
    let triageAttemptTrail: TriageResult['triage_attempt_trail'];
    let lawSourceIdsSelected: string[] | undefined;
    let triageBoundsResolved: TriageResult['bounds_resolved'];
    let triageEffectiveMinApplied: number | undefined;
    let triageTopupApplied: boolean | undefined;
    let triageTopupReason: TriageResult['topup_reason'];
    let triageTopupTarget: TriageResult['topup_target'];
    const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
    const triageMinWhenExpand = 2;
    const shouldRunTriage =
      focusSpec.taskType !== 'memory_recall' &&
      !evidenceInsufficient &&
      lawParts.length >= (gateExpand ? triageMinWhenExpand : config.evidenceTriageThreshold) &&
      (config.evidenceTriageEnabled || gateExpand);

    if (shouldRunTriage) {
      const triageApiKey = config.openRouterApiKeyRag || config.openRouterApiKey;
      const triageResult = await triageEvidence(
        assembled,
        runContext.user_input ?? '',
        triageApiKey,
        run_id
      );
      triageParseOk = triageResult.parse_ok ?? (!triageResult.skipped && triageResult.droppedCount > 0);
      triageReasonCode = triageResult.reason_code ?? undefined;
      triageFinishReason = triageResult.finish_reason ?? undefined;
      triageRawContentType = triageResult.raw_content_type ?? undefined;
      triageReasoningTokens = triageResult.reasoning_tokens ?? undefined;
      triageAttempts = triageResult.triage_attempts;
      triageAttemptTrail = triageResult.triage_attempt_trail;
      triageBoundsResolved = triageResult.bounds_resolved;
      triageEffectiveMinApplied = triageResult.effective_min_applied;
      triageTopupApplied = triageResult.topup_applied;
      triageTopupReason = triageResult.topup_reason;
      triageTopupTarget = triageResult.topup_target;
      if (!triageResult.skipped && triageResult.droppedCount > 0) {
        assembledForAgent = { ...assembled, contextParts: triageResult.selected };
        triageUsed = true;
        triageSelectedCount = triageResult.selected.filter((p) => p.type === 'law').length;
        triageDroppedCount = triageResult.droppedCount;
        triageModel = triageResult.model;
        triageLatencyMs = triageResult.latencyMs;
        lawSourceIdsSelected = getLawSourceIds(triageResult.selected);
        logger.info('U10 triage applied', {
          ...ctx,
          triage_selected: triageSelectedCount,
          triage_dropped: triageDroppedCount,
          triage_model: triageModel,
          triage_latency_ms: triageLatencyMs,
        });
      }
      // If triage ran and selected 0 law snippets, treat as insufficient (DEV RUN v16)
      if (triageUsed && (triageSelectedCount ?? 0) === 0) {
        evidenceInsufficient = true;
      }
    }

    // 6c) Enforce focus: primary norm included, max law snippets (DEV RUN v14)
    const lawBeforeFocus = assembledForAgent.contextParts.filter((p) => p.type === 'law').length;
    const enforcedParts = enforceFocusOnContextParts(assembledForAgent.contextParts, focusSpec);
    const lawAfterFocus = enforcedParts.filter((p) => p.type === 'law').length;
    assembledForAgent = { ...assembledForAgent, contextParts: enforcedParts as ContextPart[] };
    if (lawAfterFocus < lawBeforeFocus) {
      logger.info('U10 focus enforced', { ...ctx, law_before: lawBeforeFocus, law_after: lawAfterFocus });
    }

    const lawSourceIdsFinal = getLawSourceIds(assembledForAgent.contextParts);

    // 6c2) Persist u10_selection for forensics (before LLM so smoke with U10_DRY_RUN_KEEP_TRIAGE validates triage)
    const selectionReasons: string[] = [];
    if (evidenceInsufficient) {
      if (triageUsed && (triageSelectedCount ?? 0) === 0) selectionReasons.push('triage_selected_none');
      else selectionReasons.push('law_count_zero_or_degraded');
    }
    const u10Selection = {
      law_source_ids_before: lawSourceIdsBefore,
      law_source_ids_selected: lawSourceIdsSelected ?? null,
      law_source_ids_final: lawSourceIdsFinal,
      triage_used: triageUsed,
      triage_model: triageModel ?? null,
      triage_latency_ms: triageLatencyMs ?? null,
      triage_parse_ok: triageParseOk ?? null,
      triage_reason_code: triageReasonCode ?? null,
      triage_finish_reason: triageFinishReason ?? null,
      triage_raw_content_type: triageRawContentType ?? null,
      triage_reasoning_tokens: triageReasoningTokens ?? null,
      triage_attempts: triageAttempts ?? null,
      triage_attempt_trail: triageAttemptTrail ?? null,
      evidence_insufficient: evidenceInsufficient,
      reasons: selectionReasons,
      u10_bounds_applied:
        triageBoundsResolved && triageSelectedCount != null
          ? {
              effective_min: triageBoundsResolved.effective_min,
              effective_max: triageBoundsResolved.effective_max,
              final_selected: triageSelectedCount,
            }
          : undefined,
      bounds_resolved: triageBoundsResolved ?? undefined,
      effective_min_applied: triageEffectiveMinApplied ?? undefined,
      topup_applied: triageTopupApplied ?? undefined,
      topup_reason: triageTopupReason ?? undefined,
      topup_target: triageTopupTarget ?? undefined,
    };
    try {
      await runRepo.patchSnapshotField(run_id, 'u10_selection', u10Selection);
    } catch {
      // non-fatal
    }

    // 6d) Optional Prompt Composer (skip when evidence insufficient to save tokens)
    let composerUsed = false;
    let composerModel: string | undefined;
    let composerLatencyMs: number | undefined;

    if (!evidenceInsufficient) {
      const composed = await composeInstructions({ assembled: assembledForAgent, runContext });
      if (composed?.appendix) {
        assembledForAgent = {
          ...assembledForAgent,
          systemPrompt: assembledForAgent.systemPrompt + composed.appendix,
        };
        composerUsed = true;
        composerModel = composed.modelUsed;
        composerLatencyMs = composed.latencyMs;
        logger.info('U10 composer used', {
          ...ctx,
          composer_model: composerModel,
          composer_latency_ms: composerLatencyMs,
        });
      }
    }

    // 6e) Memory Search tool: when evidence insufficient OR memory channel empty but trace shows available memory
    let memoryToolUsed = false;
    let memoryToolLatencyMs: number | undefined;
    let memoryToolHits = 0;
    const memoryTrace = runContext.memory_trace;
    const memoryChannelEmpty = (runContext.memory_items?.length ?? 0) === 0;
    const memoryAvailableInTrace =
      (memoryTrace?.recent_count ?? 0) > 0 || (memoryTrace?.semantic_count ?? 0) > 0;
    const triggerMemoryTool = shouldTriggerMemorySearchTool({
      userIdPresent: !!runContext.user_id,
      useMemorySource: runContext.search_plan?.sources?.use_memory === true,
      evidenceInsufficient,
      memoryChannelEmpty,
      memoryAvailableInTrace,
    });
    const memoryToolReasonCode = evidenceInsufficient
      ? 'EVIDENCE_INSUFFICIENT'
      : memoryChannelEmpty && memoryAvailableInTrace
        ? 'MEMORY_CHANNEL_EMPTY_AVAILABLE'
        : undefined;

    if (triggerMemoryTool) {
      const stubForDryRun = config.legalAgentDisableLlm === true;
      const memSearch = await searchMemoryTool({
        tenant_id: runContext.tenant_id ?? null,
        conversation_id: runContext.conversation_id ?? null,
        user_id: runContext.user_id,
        queryText: runContext.user_input ?? '',
        limit: 8,
        runId: run_id,
        stubForDryRun,
      });
      memoryToolUsed = true;
      memoryToolLatencyMs = memSearch.trace.latency_ms;
      memoryToolHits = memSearch.summaries.length + memSearch.facts.length;
      const section = formatMemorySearchSection(memSearch);
      if (section) {
        assembledForAgent = {
          ...assembledForAgent,
          userPrompt: assembledForAgent.userPrompt + '\n\n' + section,
        };
      }
      logger.info('U10 memory tool', {
        ...ctx,
        memory_tool_used: memoryToolUsed,
        memory_tool_latency_ms: memoryToolLatencyMs,
        memory_tool_hits: memoryToolHits,
        memory_tool_reason_code: memoryToolReasonCode,
      });
    }

    // 7) Build messages once for forensics (DEV RUN v18: u10_prompt_debug) then run LLM
    const messagesForAgent = buildMessagesFromAssembled(assembledForAgent, {
      promptStack: promptStack,
      evidenceInsufficient,
      coverageGap: runContext.retrieval_trace?.meta?.coverage_gap,
      contextTruncated: assembledForAgent.meta?.budget?.truncated === true,
      taskType: focusSpec.taskType,
    });
    const u10PromptDebug = buildU10PromptDebug(assembledForAgent, messagesForAgent);
    try {
      await runRepo.patchSnapshotField(run_id, 'u10_prompt_debug', u10PromptDebug);
    } catch {
      // non-fatal
    }

    if (dryRun) {
      const result = buildStubResult(config.legalAgentModelId);
      try {
        await runRepo.updateLlmResult(run_id, result);
      } catch {
        // DB may not have llm_result column yet
      }
      const merged = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
      await runContextSet(
        run_id,
        { ...merged, llm_result: result } as Record<string, unknown>,
        RUN_CONTEXT_TTL_SEC
      );
      logger.info('U10 dry_run stub (triage kept)', {
        ...ctx,
        model: result.model,
        dry_run: true,
        triage_used: triageUsed,
        u10_selection_persisted: true,
        status: 'ok',
      });
      incrementU10Success();
      await enqueueU11(run_id, trace_id);
      return;
    }

    const u10Start = Date.now();
    let result = await runLegalAgent({
      runId: run_id,
      runContext,
      assembled: assembledForAgent,
      focusSpec: { taskType: focusSpec.taskType },
      preBuiltMessages: messagesForAgent,
    });
    const u10LatencyMs = Date.now() - u10Start;

    // 7b) Output validation (DEV RUN v14; v18: missing_citation → 1 repair; memory denial guard; gratuitous citation in memory mode)
    const historyCount = assembledForAgent.contextParts.filter((p) => p.type === 'history').length;
    const memoryCount = assembledForAgent.contextParts.filter((p) => p.type === 'memory').length;
    const lawCount = assembledForAgent.contextParts.filter((p) => p.type === 'law').length;
    const docCount = assembledForAgent.contextParts.filter((p) => p.type === 'doc').length;
    const validationOpts = { historyCount, memoryCount, lawCount, docCount };
    const groundingEvidenceTexts = assembledForAgent.contextParts
      .filter((p) => p.type !== 'history')
      .map((p) => p.text);
    const applyOutputSanitizers = (answerText: string): string => {
      let sanitized = sanitizeUnsupportedDocAbsenceAnswer({
        answerText,
        queryText: runContext.user_input ?? '',
        evidenceTexts: groundingEvidenceTexts,
        docCount,
      });
      if (sanitized !== answerText) {
        logger.info('U10 doc absence sanitizer applied', { ...ctx });
      }
      const docsOnlySanitized = sanitizeDocsOnlyNoEvidenceAnswer({
        answerText: sanitized,
        focusSpec,
        lawCount,
        docCount,
      });
      if (docsOnlySanitized !== sanitized) {
        logger.info('U10 docs-only no-evidence sanitizer applied', { ...ctx });
      }
      sanitized = docsOnlySanitized;
      return sanitized;
    };
    result = { ...result, answerText: applyOutputSanitizers(result.answerText) };
    let validation = validateOutput(result.answerText, focusSpec, validationOpts);
    if (validation.warnings.includes('gratuitous_legal_citation_in_memory_mode') && focusSpec.taskType === 'memory_recall') {
      const repaired = stripGratuitousLegalCitation(result.answerText);
      if (countArticleRefs(repaired) < countArticleRefs(result.answerText)) {
        result = { ...result, answerText: applyOutputSanitizers(repaired) };
        validation = validateOutput(result.answerText, focusSpec, validationOpts);
        logger.info('U10 memory recall citation strip applied', { ...ctx });
      }
    }
    if (focusSpec.taskType === 'memory_recall' && lawCount === 0) {
      const memoryParts = assembledForAgent.contextParts.filter((p) => p.type === 'memory');
      const historyParts = assembledForAgent.contextParts.filter((p) => p.type === 'history');
      const memoryText = memoryParts.map((p) => p.text).join('\n\n');
      const historyText = historyParts.map((p) => p.text).join('\n\n');
      const userQuery = runContext.user_input ?? '';
      const judgeResult = await judgeMemoryRecallGrounded({
        userQuery,
        memoryText,
        historyText,
        answerText: result.answerText,
      });
      if (judgeResult.verdict !== 'grounded_memory_recall') {
        const regenerated = await regenerateMemoryRecallGrounded({ userQuery, memoryText, historyText });
        if (regenerated) {
          result = { ...result, answerText: applyOutputSanitizers(regenerated) };
          validation = validateOutput(result.answerText, focusSpec, validationOpts);
          logger.info('U10 memory recall grounded regenerate applied', { ...ctx, verdict: judgeResult.verdict });
        }
      }
    }
    if (
      docCount > 0 &&
      lawCount === 0 &&
      hasFalseDocAbsenceClaim({
        answerText: result.answerText,
        queryText: runContext.user_input ?? '',
        evidenceTexts: groundingEvidenceTexts,
        docCount,
      })
    ) {
      const docParts = assembledForAgent.contextParts.filter((p) => p.type === 'doc');
      const historyParts = assembledForAgent.contextParts.filter((p) => p.type === 'history');
      const docText = docParts.map((p) => p.text).join('\n\n');
      const historyText = historyParts.map((p) => p.text).join('\n\n');
      const regenerated = await regenerateDocOnlyGrounded({
        userQuery: runContext.user_input ?? '',
        docText,
        historyText,
      });
      if (regenerated) {
        result = { ...result, answerText: applyOutputSanitizers(regenerated) };
        validation = validateOutput(result.answerText, focusSpec, validationOpts);
        logger.info('U10 doc grounded regenerate applied', { ...ctx, reason: 'false_doc_absence_claim' });
      }
    }
    if (
      docCount > 0 &&
      lawCount === 0 &&
      (
        validation.warnings.includes('gratuitous_legal_citation_without_law_evidence') ||
        validation.warnings.includes('legal_norm_section_without_law_evidence') ||
        validation.warnings.includes('legal_rag_framing_without_law_evidence')
      )
    ) {
      const docParts = assembledForAgent.contextParts.filter((p) => p.type === 'doc');
      const historyParts = assembledForAgent.contextParts.filter((p) => p.type === 'history');
      const docText = docParts.map((p) => p.text).join('\n\n');
      const historyText = historyParts.map((p) => p.text).join('\n\n');
      const regenerated = await regenerateDocOnlyGrounded({
        userQuery: runContext.user_input ?? '',
        docText,
        historyText,
      });
      if (regenerated) {
        result = { ...result, answerText: applyOutputSanitizers(regenerated) };
        validation = validateOutput(result.answerText, focusSpec, validationOpts);
        logger.info('U10 doc grounded regenerate applied', { ...ctx });
      }
    }
    if (validation.warnings.includes('missing_citation')) {
      const repaired = await repairCitationAnswer(result.answerText);
      if (repaired !== result.answerText) {
        result = { ...result, answerText: applyOutputSanitizers(repaired) };
        validation = validateOutput(result.answerText, focusSpec, validationOpts);
        logger.info('U10 citation repair applied', { ...ctx });
      }
    }
    // PHASE 4: compact repair (max 2 passes); if refs_after > threshold run stricter second pass; no missing_citation regression
    const sprawlThreshold = 3;
    const needCompactRepair =
      (validation.suggestCompact === true || validation.warnings.some((w) => w.startsWith('article_sprawl'))) &&
      (result.answerText.length > 700 || countArticleRefs(result.answerText) > sprawlThreshold);
    const hadCitationBeforeCompact = !validation.warnings.includes('missing_citation');
    if (needCompactRepair) {
      const article_refs_before = countArticleRefs(result.answerText);
      let repaired = await repairCompactAnswer(result.answerText, false);
      let refsAfter = countArticleRefs(repaired);
      if (refsAfter > sprawlThreshold && repaired !== result.answerText) {
        repaired = await repairCompactAnswer(repaired, true);
        refsAfter = countArticleRefs(repaired);
      }
      const compact_repair_success = repaired !== result.answerText;
      if (compact_repair_success) {
        repaired = applyOutputSanitizers(repaired);
        validation = validateOutput(repaired, focusSpec, validationOpts);
        if (hadCitationBeforeCompact && validation.warnings.includes('missing_citation')) {
          const citationFixed = await repairCitationAnswer(repaired);
          if (countArticleRefs(citationFixed) > 0) {
            repaired = applyOutputSanitizers(citationFixed);
            validation = validateOutput(repaired, focusSpec, validationOpts);
          }
        }
        result = {
          ...result,
          answerText: repaired,
          compact_repair_applied: true,
          compact_repair_success: true,
          article_refs_before,
          article_refs_after: countArticleRefs(repaired),
        };
        logger.info('U10 compact repair applied', { ...ctx, article_refs_before, article_refs_after: result.article_refs_after });
      } else {
        result = {
          ...result,
          compact_repair_applied: true,
          compact_repair_success: false,
          article_refs_before,
          article_refs_after: article_refs_before,
        };
      }
    }
    if (!validation.pass && validation.warnings.length > 0) {
      result = {
        ...result,
        warnings: [...(result.warnings ?? []), ...validation.warnings],
      };
      logger.info('U10 output validation', { ...ctx, warnings: validation.warnings });
    }

    // 7c) DEV RUN v16: ambiguous_query warning when gate expanded
    if (gateExpand) {
      result = {
        ...result,
        warnings: [...(result.warnings ?? []), 'ambiguous_query'],
      };
    }

    // 8) Persist durable
    try {
      await runRepo.updateLlmResult(run_id, result);
      llmResultPersisted = true;
    } catch {
      // DB may not have llm_result column; persist to context only
    }

    // 8b) u10_selection already persisted at 6c2 (forensics)
    const merged = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      { ...merged, llm_result: result } as Record<string, unknown>,
      RUN_CONTEXT_TTL_SEC
    );

    logger.info('U10 finished', {
      ...ctx,
      model: result.model,
      latency_ms: result.latencyMs,
      u10_latency_ms: u10LatencyMs,
      tokens_in: result.usage?.prompt_tokens,
      tokens_out: result.usage?.completion_tokens,
      triage_used: triageUsed,
      triage_selected: triageSelectedCount,
      triage_dropped: triageDroppedCount,
      composer_used: composerUsed,
      composer_model: composerModel,
      composer_latency_ms: composerLatencyMs,
      evidence_insufficient: evidenceInsufficient,
      has_prompt_stack: promptStack != null,
      dry_run: false,
      status: 'ok',
    });
    incrementU10Success();
    recordU10LatencyMs(result.latencyMs);
    await enqueueU11(run_id, trace_id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U10 failed', { ...ctx, error: msg });
    if (!llmResultPersisted) {
      try {
        await runRepo.markFailed(run_id, 'U10_WRITE_ERROR');
      } catch (markErr) {
        logger.warn('U10 markFailed failed (non-fatal)', {
          ...ctx,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }
    }
    incrementU10Fail();
    throw err;
  }
}

function enqueueU11(run_id: string, trace_id?: string): Promise<void> {
  const now = new Date().toISOString();
  const taskQueue = getTaskQueue();
  return taskQueue
    .enqueue({ run_id, step: 'U11', created_at: now, trace_id })
    .then(() => logger.info('U11 enqueued', { run_id, trace_id }));
}
