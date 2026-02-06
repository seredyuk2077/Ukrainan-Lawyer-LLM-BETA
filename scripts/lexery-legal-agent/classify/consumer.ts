/**
 * [U2-0] Queue consumer for step "U2" — LLM-first + rule-based fallback.
 * Hybrid: pre-extract (rule-based) → LLM classify (if key + !USE_RULE_BASED_CLASSIFIER) → else/degraded use rules.
 * Persists to RunContext (in-memory) + RunRecord.query_profile (audit). Stub: "would enqueue U3".
 */
import type { RunEvent } from '../gateway/types.js';
import { RunRepository } from '../gateway/storage.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import { runContextSet } from '../lib/run-context.js';
import {
  incrementU2Processed,
  incrementU2Failed,
  incrementU2Ambiguous,
  incrementU2Intent,
  incrementU2Domain,
  incrementU2Inflight,
  decrementU2Inflight,
  incrementU2LlmInflight,
  decrementU2LlmInflight,
  incrementU2LlmRateLimited,
  incrementU2GatingLlmSkipped,
  incrementU2GatingLlmCalled,
  incrementU2GatingReason,
} from '../gateway/observability.js';
import { Semaphore } from '../lib/semaphore.js';
import { isCircuitOpen, recordLlmFailure } from './circuit-breaker.js';
import { OpenRouterError } from '../lib/openrouter.js';
import { classifyIntent } from './intent-classifier.js';
import { tagLegalDomain } from './legal-domain-tagger.js';
import { extractEntities } from './entity-extractor.js';
import { detectAmbiguity } from './ambiguity-detector.js';
import { classifyWithLLM } from './llm-classifier.js';
import { normalizeInput } from './input-normalizer.js';
import type {
  QueryProfile,
  ExtractedEntity,
  RoutingFlags,
  RulesConfidence,
  GatingDecision,
  LegalDomain,
  AmbiguityResult,
} from './types.js';

const runRepo = new RunRepository();
const llmSemaphore = new Semaphore(config.u2LlmConcurrency);

/** Compute rules confidence 0..1 from intent/domain/ambiguity for smart gating */
function computeRulesConfidence(
  intent: string,
  domain: string,
  ambiguity: { is_ambiguous: boolean; reasons: string[] }
): RulesConfidence {
  const intentScore = intent === 'question' || intent === 'other' ? 0.6 : 1;
  const domainScore = domain === 'general' ? 0.5 : 1;
  const ambiguityScore = ambiguity.is_ambiguous
    ? Math.max(0, 1 - ambiguity.reasons.length * 0.25)
    : 1;
  const overall = (intentScore + domainScore + ambiguityScore) / 3;
  return { intent: intentScore, domain: domainScore, ambiguity: ambiguityScore, overall };
}

/** Decide gating reason when we call LLM (for meta.llm_used_reason) */
function gatingReasonForLlm(
  normalizer: { isComplexInput: boolean; routingOverrides: RoutingFlags; isNoise: boolean },
  ambiguity: { is_ambiguous: boolean }
): GatingDecision {
  if (normalizer.routingOverrides.input_is_large) return 'llm_large_input';
  if (normalizer.routingOverrides.input_looks_like_contract) return 'llm_contract_like';
  if (normalizer.routingOverrides.input_looks_like_table) return 'llm_table_like';
  if (normalizer.routingOverrides.input_looks_like_legal_text) return 'llm_legal_text_like';
  if (ambiguity.is_ambiguous) return 'llm_ambiguous';
  if (normalizer.isNoise && normalizer.routingOverrides.need_clarification) return 'llm_noise_clarification';
  return 'llm_low_confidence';
}

/**
 * Merge ambiguity: rules "hard" (AMBIG_TERMS, TOO_SHORT) override LLM so ambiguity is deterministic.
 */
function mergeAmbiguity(
  rulesAmbiguity: AmbiguityResult,
  llmAmbiguity: AmbiguityResult
): {
  final: AmbiguityResult;
  ambiguity_source: 'llm' | 'rules_soft' | 'rules_hard_override' | 'merged';
  overrideWarning?: string;
} {
  const isHard =
    rulesAmbiguity.strength === 'hard' ||
    (rulesAmbiguity.reason_codes?.some((c) => c === 'AMBIG_TERM_MATCH' || c === 'TOO_SHORT_QUERY') ?? false);
  if (rulesAmbiguity.is_ambiguous && isHard) {
    const reasonCodes = (rulesAmbiguity.reason_codes || []).join(',');
    const out = {
      final: { ...rulesAmbiguity, strength: 'hard' as const },
      ambiguity_source: 'rules_hard_override' as const,
      overrideWarning: reasonCodes ? `ambiguity_overridden_by_rules:${reasonCodes}` : 'ambiguity_overridden_by_rules',
    };
    if (process.env.U2_DEBUG_AMBIGUITY === 'true' && !llmAmbiguity.is_ambiguous) {
      logger.info('U2 ambiguity override', {
        rules_ambiguity: { is_ambiguous: rulesAmbiguity.is_ambiguous, strength: rulesAmbiguity.strength, reason_codes: rulesAmbiguity.reason_codes },
        llm_ambiguity: { is_ambiguous: llmAmbiguity.is_ambiguous },
        final_ambiguity: out.final.is_ambiguous,
        ambiguity_source: out.ambiguity_source,
      });
    }
    return out;
  }
  if (rulesAmbiguity.is_ambiguous && rulesAmbiguity.strength === 'soft') {
    const isAmbiguous = llmAmbiguity.is_ambiguous || rulesAmbiguity.is_ambiguous;
    return {
      final: {
        is_ambiguous: isAmbiguous,
        reasons: isAmbiguous ? [...new Set([...llmAmbiguity.reasons, ...rulesAmbiguity.reasons])] : llmAmbiguity.reasons,
        ambig_terms: llmAmbiguity.ambig_terms?.length ? llmAmbiguity.ambig_terms : rulesAmbiguity.ambig_terms,
        strength: 'soft',
        reason_codes: rulesAmbiguity.reason_codes,
      },
      ambiguity_source: 'merged',
    };
  }
  return {
    final: { ...llmAmbiguity },
    ambiguity_source: 'llm',
  };
}

/** Merge policy: pre_entities (rules) as minimum reliability layer + LLM entities, dedup by type+value. */
function mergeEntities(pre: ExtractedEntity[], llm: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const out: ExtractedEntity[] = [];
  for (const e of pre) {
    const key = `${e.type}:${e.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  for (const e of llm) {
    const key = `${e.type}:${e.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function buildRulesProfile(
  query: string,
  intent: string,
  domain: string,
  entities: ExtractedEntity[],
  has_direct_citation: boolean,
  ambiguity: { is_ambiguous: boolean; reasons: string[]; ambig_terms?: string[] },
  latencyMs: number,
  routing_flags?: RoutingFlags,
  metaExtra?: {
    input_truncated?: boolean;
    original_length?: number;
    effective_length?: number;
    gating_decision?: GatingDecision;
    rules_confidence?: RulesConfidence;
    llm_used_reason?: string[];
    input_source?: 'db_query' | 'snapshot_preview' | 'r2_full';
    ambiguity_source?: QueryProfile['meta']['ambiguity_source'];
  }
): QueryProfile {
  const now = new Date().toISOString();
  return {
    query_profile_version: 1,
    intent: intent as QueryProfile['intent'],
    domain: domain as QueryProfile['domain'],
    entities,
    ambiguity,
    computed_flags: {
      has_direct_citation,
      profile_generation: 'rules',
    },
    routing_flags: routing_flags ?? {},
    meta: {
      classifier_mode: 'rules',
      latency_ms: latencyMs,
      warnings: [],
      ...metaExtra,
    },
    pipeline_step: 'U2d_done',
    updated_at: now,
  };
}

function buildDegradedProfile(
  query: string,
  entities: ExtractedEntity[],
  has_direct_citation: boolean,
  ambiguity: { is_ambiguous: boolean; reasons: string[]; ambig_terms?: string[] },
  warnings: string[],
  routing_flags?: RoutingFlags,
  metaExtra?: {
    input_truncated?: boolean;
    original_length?: number;
    effective_length?: number;
    gating_decision?: GatingDecision;
    rules_confidence?: RulesConfidence;
    llm_used_reason?: string[];
    input_source?: 'db_query' | 'snapshot_preview' | 'r2_full';
    ambiguity_source?: QueryProfile['meta']['ambiguity_source'];
  }
): QueryProfile {
  const now = new Date().toISOString();
  return {
    query_profile_version: 1,
    intent: 'question',
    domain: 'general',
    entities,
    ambiguity,
    computed_flags: {
      has_direct_citation,
      profile_generation: 'degraded',
    },
    routing_flags: routing_flags ?? {},
    meta: {
      classifier_mode: 'degraded',
      warnings,
      ...metaExtra,
    },
    pipeline_step: 'U2d_done',
    updated_at: now,
  };
}

export async function handleU2Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U2') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U2', trace_id, module: 'classify/consumer' };
  const start = Date.now();
  incrementU2Inflight();
  logger.info('U2 started', ctx);

  try {
    const run = await runRepo.findByRunId(run_id);
    if (!run) {
      logger.error('Run not found', { ...ctx, error: 'run_not_found' });
      incrementU2Failed();
      return;
    }

    // Resolve query: R2 overflow → use snapshot.input.query_preview (head + tail); else run.query
    const snapshotInput = (run.snapshot as { input?: { query_preview?: { head?: string; tail?: string }; query_overflow?: boolean } })?.input;
    const queryPreview = snapshotInput?.query_preview;
    const query =
      queryPreview?.head != null && queryPreview?.tail != null
        ? queryPreview.head + '\n...\n' + queryPreview.tail
        : run.query ?? (run.snapshot?.request as { query?: string })?.query ?? '';
    const inputSource: 'db_query' | 'snapshot_preview' | 'r2_full' = queryPreview ? 'snapshot_preview' : 'db_query';

    const tenant_id = run.tenant_id ?? null;
    const user_id = run.user_id;
    const locale = (run.snapshot?.request as { locale?: string })?.locale;

    // Pre-extract (rule-based) — always run for hybrid
    const tPre = Date.now();
    const { entities: preEntities, has_direct_citation } = extractEntities(query);
    const preExtractMs = Date.now() - tPre;

    // U2-preprocessor: long/noise + heuristics (contract/table/legal_text)
    const normalizer = normalizeInput(query, preEntities);
    const effectiveQuery = normalizer.effectiveQuery;
    const routingOverrides = normalizer.routingOverrides;
    const metaExtra =
      normalizer.inputTruncated
        ? {
            input_truncated: true,
            original_length: normalizer.originalLength,
            effective_length: normalizer.effectiveLength,
            input_source: inputSource,
          }
        : { input_source: inputSource };

    const circuitOpen = isCircuitOpen();
    const useRulesOnlyConfig =
      config.useRuleBasedClassifier || !config.openRouterApiKey || circuitOpen;

    if (circuitOpen && config.openRouterApiKey) {
      logger.warn('U2 circuit open, using rules', { ...ctx });
    }

    // Run rules first to compute confidence (for gating decision)
    const t2a = Date.now();
    let intent = classifyIntent(effectiveQuery);
    let domain = tagLegalDomain(effectiveQuery) as LegalDomain;
    let ambiguity = detectAmbiguity(effectiveQuery, domain, preEntities);
    if (normalizer.isNoise) {
      intent = 'other';
      ambiguity = {
        is_ambiguous: true,
        reasons: ['input_noise'],
        ambig_terms: [],
        strength: ambiguity.strength ?? 'hard',
        reason_codes: ambiguity.reason_codes?.length ? ambiguity.reason_codes : ['TOO_SHORT_QUERY'],
      };
    }
    const rulesMs = Date.now() - t2a;
    const rulesConfidence = computeRulesConfidence(intent, domain, ambiguity);

    const skipLlmByGating =
      !useRulesOnlyConfig &&
      config.u2GatingEnabled &&
      rulesConfidence.overall >= config.u2GatingConfidenceThreshold &&
      !normalizer.isComplexInput &&
      !ambiguity.is_ambiguous;

    const useRulesOnly = useRulesOnlyConfig || skipLlmByGating;

    let gatingDecision: GatingDecision;
    if (circuitOpen && config.openRouterApiKey) gatingDecision = 'circuit_open';
    else if (config.useRuleBasedClassifier) gatingDecision = 'rules_only_config';
    else if (skipLlmByGating) gatingDecision = 'rules_high_confidence';
    else gatingDecision = gatingReasonForLlm(normalizer, ambiguity);

    let queryProfile: QueryProfile;
    let routing_flags: RoutingFlags | undefined;

    if (useRulesOnly) {
      if (skipLlmByGating) {
        incrementU2GatingLlmSkipped();
        incrementU2GatingReason('rules_high_confidence');
      }
      logger.info('U2 rules path', { ...ctx, intent, domain, duration_ms: rulesMs, gating_decision: gatingDecision });
      incrementU2Intent(intent);
      incrementU2Domain(domain);
      if (ambiguity.is_ambiguous) incrementU2Ambiguous();
      queryProfile = buildRulesProfile(
        query,
        intent,
        domain,
        preEntities,
        has_direct_citation,
        ambiguity,
        rulesMs + preExtractMs,
        { ...routingOverrides },
        {
          ...metaExtra,
          gating_decision: gatingDecision,
          rules_confidence: rulesConfidence,
          llm_used_reason: skipLlmByGating ? [] : [gatingDecision],
          ambiguity_source: ambiguity.strength === 'hard' ? 'rules_hard_override' : 'rules_soft',
        }
      );
      if (circuitOpen && queryProfile.meta) {
        queryProfile.meta.warnings = [...(queryProfile.meta.warnings ?? []), 'circuit_open'];
      }
    } else {
      incrementU2GatingLlmCalled();
      incrementU2GatingReason(gatingDecision);
      try {
        const llmResult = await llmSemaphore.run(async () => {
          incrementU2LlmInflight();
          try {
            return await classifyWithLLM(
              {
                apiKey: config.openRouterApiKey,
                modelId: config.clfModelId,
                fallbackModelId: config.clfFallbackModelId || undefined,
                timeoutSec: config.clfTimeoutSec,
              },
              {
                query: effectiveQuery,
                pre_entities: preEntities,
                language: locale,
              }
            );
          } finally {
            decrementU2LlmInflight();
          }
        });
        incrementU2Intent(llmResult.intent);
        incrementU2Domain(llmResult.domain);
        const { final: finalAmbiguity, ambiguity_source: ambiguitySource, overrideWarning } = mergeAmbiguity(ambiguity, llmResult.ambiguity);
        if (finalAmbiguity.is_ambiguous) incrementU2Ambiguous();
        const mergedEntities = mergeEntities(preEntities, llmResult.entities);
        const now = new Date().toISOString();
        routing_flags = { ...routingOverrides, ...llmResult.routing_flags, ambiguous: finalAmbiguity.is_ambiguous };
        const llmWarnings = [...(llmResult.meta.warnings || [])];
        if (overrideWarning) llmWarnings.push(overrideWarning);
        queryProfile = {
          query_profile_version: 1,
          intent: llmResult.intent,
          domain: llmResult.domain,
          entities: mergedEntities,
          ambiguity: finalAmbiguity,
          computed_flags: {
            has_direct_citation: mergedEntities.some(
              (e) => e.type === 'article_ref' || e.type === 'act_abbrev'
            ),
            profile_generation: 'llm',
          },
          routing_flags,
          meta: {
            classifier_mode: 'llm',
            prompt_version: llmResult.meta.prompt_version,
            model_id: llmResult.meta.model_id,
            provider: llmResult.meta.provider,
            latency_ms: llmResult.meta.latency_ms,
            retries: llmResult.meta.retries,
            warnings: llmWarnings.length ? llmWarnings : undefined,
            gating_decision: gatingDecision,
            rules_confidence: rulesConfidence,
            llm_used_reason: [gatingDecision],
            ambiguity_source: ambiguitySource,
            ...metaExtra,
          },
          pipeline_step: 'U2d_done',
          updated_at: now,
        };
        logger.info('U2 LLM path', {
          ...ctx,
          intent: llmResult.intent,
          domain: llmResult.domain,
          duration_ms: llmResult.meta.latency_ms,
          model_id: llmResult.meta.model_id,
          classifier_mode: 'llm',
        });
      } catch (llmErr) {
        recordLlmFailure();
        if (llmErr instanceof OpenRouterError && llmErr.statusCode === 429) {
          incrementU2LlmRateLimited();
        }
        const warnMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        logger.warn('U2 LLM failed, using degraded', { ...ctx, error: warnMsg });
        const domain = tagLegalDomain(effectiveQuery);
        const ambiguity = detectAmbiguity(
          effectiveQuery,
          domain as QueryProfile['domain'],
          preEntities
        );
        const warnings = ['llm_timeout_fallback_rules', warnMsg.slice(0, 100)];
        queryProfile = buildDegradedProfile(
          query,
          preEntities,
          has_direct_citation,
          ambiguity,
          warnings,
          { ...routingOverrides },
          {
            ...metaExtra,
            gating_decision: 'llm_fallback',
            rules_confidence: rulesConfidence,
            llm_used_reason: ['llm_fallback'],
            ambiguity_source: ambiguity.strength === 'hard' ? 'rules_hard_override' : 'rules_soft',
          }
        );
        if (ambiguity.is_ambiguous) incrementU2Ambiguous();
        incrementU2Intent('question');
        incrementU2Domain('general');
      }
    }

    const persistOnce = async (): Promise<void> => {
      await runContextSet(
        run_id,
        { query_profile: queryProfile, routing_flags: queryProfile.routing_flags ?? {} },
        3600
      );
      await runRepo.updateQueryProfile(run_id, queryProfile as unknown as object, 'Profiling');
    };

    try {
      await persistOnce();
    } catch (persistErr) {
      const isTransient =
        (persistErr instanceof TypeError && (persistErr as Error).message?.includes('fetch')) ||
        (persistErr as Error).message?.includes('ECONNRESET') ||
        (persistErr as Error).message?.includes('ETIMEDOUT') ||
        (persistErr as Error).message?.includes('network');
      if (isTransient) {
        await new Promise((r) => setTimeout(r, 500));
        await persistOnce();
      } else {
        throw persistErr;
      }
    }

    incrementU2Processed();

    logger.info('U2 finished', {
      ...ctx,
      duration_ms: Date.now() - start,
      next_step: 'U3',
      classifier_mode: queryProfile.meta?.classifier_mode ?? 'rules',
    });
    logger.info('would enqueue U3', { run_id, trace_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U2 failed', { ...ctx, error: msg });
    incrementU2Failed();
    try {
      await runRepo.markFailed(run_id, 'U2_PIPELINE_ERROR');
    } catch (_) {
      // ignore
    }
  } finally {
    decrementU2Inflight();
  }
}
