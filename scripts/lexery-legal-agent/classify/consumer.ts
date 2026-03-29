/**
 * [U2-0] Queue consumer for step "U2" — LLM-first + rule-based fallback.
 * Hybrid: pre-extract (rule-based) → LLM classify (if key + !USE_RULE_BASED_CLASSIFIER) → else/degraded use rules.
 * Persists to RunContext (in-memory) + RunRecord.query_profile (audit). Stub: "would enqueue U3".
 */
import type { RunEvent } from '../gateway/types.js';
import { RunRepository } from '../gateway/storage.js';
import { withTransientGatewayIoRetry } from '../gateway/retry.js';
import { getTaskQueue } from '../gateway/handler.js';
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
  incrementU2AiDomainCalled,
  incrementU2AiDomainUsed,
  incrementU2AiDomainInvalidJson,
  incrementU2AiDomainConfTooLow,
  incrementU2AiDomainDisagreesWithHeuristic,
  incrementU2AiRoutingCalled,
  incrementU2AiRoutingUsed,
  incrementU2AiRoutingInvalidJson,
  incrementU2AiRoutingConfTooLow,
  incrementU2AiRoutingDisagreesWithHeuristic,
  incrementU2RulesRoutingDerived,
  incrementU2RulesDocTypeNonempty,
  incrementU2RulesCategoryNonempty,
} from '../gateway/observability.js';
import { getLldbiVocabulary, type LldbiVocabularyResult } from '../retrieval/lldbi-vocabulary.js';
import {
  deriveLldbiHintsFromVocabulary,
  filterDocumentTypesByAuthorityCompatibility,
  legalDomainToTaxonomyKey,
  type DerivedLldbiHintsResult,
} from './lldbi-hints-from-vocabulary.js';
import { findActByAlias, findActByTitleFragment, getActMeta } from '../retrieval/act-taxonomy-store.js';
import {
  hasInterrogativeActLocatorCue,
  looksLikeCompactActTitleFragmentQuery,
} from '../retrieval/descriptive-act-title.js';
import { Semaphore } from '../lib/semaphore.js';
import { isCircuitOpen, recordLlmFailure } from './circuit-breaker.js';
import { OpenRouterError } from '../lib/openrouter.js';
import { classifyIntent } from './intent-classifier.js';
import { tagLegalDomain } from './legal-domain-tagger.js';
import { extractEntities } from './entity-extractor.js';
import { alignLlmEntitiesToSurface } from './entity-alignment.js';
import { detectAmbiguity } from './ambiguity-detector.js';
import { classifyWithLLM, repairContextMode } from './llm-classifier.js';
import { normalizeInput } from './input-normalizer.js';
import { classifyDomainWithAi } from './ai-domain-classifier.js';
import { hasExplicitMemoryRecallRequest, shouldUseDocsOnlyFastPath } from '../lib/queryScopeHints.js';
import type {
  QueryProfile,
  ExtractedEntity,
  RoutingFlags,
  RulesConfidence,
  GatingDecision,
  LegalDomain,
  AmbiguityResult,
} from './types.js';

/** Map taxonomy family key to LegalDomain for query_profile.domain (backward compat). */
function taxonomyKeyToLegalDomain(key: string): LegalDomain {
  const k = key.trim().toLowerCase();
  if (k === 'criminal' || k === 'criminal_procedure') return 'criminal';
  if (k === 'civil' || k === 'civil_procedure') return 'civil';
  if (k === 'tax_customs') return 'tax';
  if (k === 'labor_social') return 'labor';
  if (k === 'administrative' || k === 'judiciary_justice' || k === 'administrative_offenses') return 'admin';
  if (k === 'healthcare') return 'health';
  if (k === 'corporate' || k === 'business_corporate') return 'corporate';
  if (k === 'education_science') return 'education';
  return 'general';
}

/** Attach LLDBI vocabulary metadata до query_profile.meta (для MCP-аудиту та forward-compat debug). */
function attachLldbiVocabularyMeta(queryProfile: QueryProfile, vocabulary: LldbiVocabularyResult): void {
  if (!queryProfile.meta) {
    queryProfile.meta = {
      classifier_mode: 'rules',
      latency_ms: 0,
      warnings: [],
    };
  }
  queryProfile.meta.lldbi_vocabulary_source = vocabulary.source;
  queryProfile.meta.lldbi_vocabulary_fetched_at = new Date(vocabulary.fetchedAt).toISOString();
  queryProfile.meta.lldbi_vocab_stats = vocabulary.stats;
}

const runRepo = new RunRepository();
const llmSemaphore = new Semaphore(config.u2LlmConcurrency);

export async function loadRunForU2(runId: string) {
  return withTransientGatewayIoRetry(() => runRepo.findByRunId(runId));
}

export function isTransientU2ClassifierError(error: unknown): boolean {
  if (error instanceof OpenRouterError) {
    if (error.code === 'TIMEOUT' || error.code === 'NETWORK') return true;
    if (error.statusCode != null && [429, 502, 503, 504].includes(error.statusCode)) return true;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|429|502|503|504|network/i.test(
    message
  );
}

export async function withTransientU2ClassifierRetry<T>(
  fn: () => Promise<T>,
  attempts = 2,
  baseDelayMs = 250
): Promise<T> {
  const maxAttempts = Math.max(1, attempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientU2ClassifierError(error) || attempt === maxAttempts) {
        throw error;
      }
      logger.warn('U2 transient classifier error; retrying', {
        module: 'classify/consumer',
        attempt,
        attempts: maxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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

/** Structural/entity-based only: article_ref, act_abbrev, law_title. No topic wordlists. */
function hasStructuralDomainCue(entities: ExtractedEntity[]): boolean {
  if (!Array.isArray(entities) || entities.length === 0) return false;
  return entities.some(
    (e) => e.type === 'article_ref' || e.type === 'act_abbrev' || e.type === 'law_title'
  );
}

function countCompactQueryTokens(query: string): number {
  return query
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean).length;
}

function shouldTryExactActAliasGrounding(query: string, entities: ExtractedEntity[]): boolean {
  const trimmed = query.normalize('NFC').trim();
  if (!trimmed) return false;
  if (hasExplicitMemoryRecallRequest(trimmed)) return false;
  if (entities.some((entity) => entity.type === 'article_ref' || entity.type === 'law_title')) return false;
  const tokenCount = countCompactQueryTokens(trimmed);
  if (tokenCount === 0 || tokenCount > 6) return false;
  if (trimmed.length > 80) return false;
  return true;
}

function normalizeLogicalActFamilyTitle(title: string | null | undefined): string {
  return String(title ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\([^)]*\)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function matchesSingleLogicalActFamily(radaNregs: string[]): Promise<boolean> {
  if (radaNregs.length < 2 || radaNregs.length > 8) return false;
  const metas = await Promise.all(radaNregs.map((radaNreg) => getActMeta(radaNreg)));
  if (metas.some((meta) => !meta)) return false;
  const normalizedTitles = new Set(
    metas.map((meta) => normalizeLogicalActFamilyTitle(meta?.title))
  );
  if (normalizedTitles.size !== 1) return false;
  const categories = new Set(metas.map((meta) => meta?.category ?? ''));
  const docTypes = new Set(metas.map((meta) => meta?.document_type_slug ?? meta?.document_type ?? ''));
  return categories.size === 1 && docTypes.size === 1;
}

async function enrichEntitiesWithExactActAlias(
  query: string,
  entities: ExtractedEntity[]
): Promise<{ entities: ExtractedEntity[]; exactActAliasGrounded: boolean }> {
  if (!shouldTryExactActAliasGrounding(query, entities)) {
    return { entities, exactActAliasGrounded: false };
  }
  try {
    const matches = await findActByAlias(query);
    if (matches.length === 1 || (matches.length > 1 && await matchesSingleLogicalActFamily(matches))) {
      return {
        entities: [...entities, { type: 'law_title', value: query.trim() }],
        exactActAliasGrounded: true,
      };
    }
    const titleFragmentMatches =
      query.normalize('NFC').trim().length >= 10 &&
      (
        looksLikeCompactActTitleFragmentQuery(query, { includeRulesLikeTitles: true }) ||
        hasInterrogativeActLocatorCue(query)
      )
        ? await findActByTitleFragment(query)
        : [];
    if (titleFragmentMatches.length !== 1) {
      return { entities, exactActAliasGrounded: false };
    }
    return {
      entities: [...entities, { type: 'law_title', value: query.trim() }],
      exactActAliasGrounded: true,
    };
  } catch {
    return { entities, exactActAliasGrounded: false };
  }
}

function inferDeterministicContextMode(
  query: string,
  entities: ExtractedEntity[],
  hasDirectCitation: boolean
): RoutingFlags['context_mode'] | undefined {
  const explicitMemoryRecall = hasExplicitMemoryRecallRequest(query);
  const hasLawStructuralCue = hasStructuralDomainCue(entities) || hasDirectCitation;

  if (explicitMemoryRecall && hasLawStructuralCue) return 'mixed';
  if (explicitMemoryRecall) return 'memory';
  if (shouldUseDocsOnlyFastPath(query)) return undefined;
  if (hasLawStructuralCue) return 'law';
  return undefined;
}

function normalizeContextModeForStructuralLegalCue(
  query: string,
  entities: ExtractedEntity[],
  contextMode: RoutingFlags['context_mode'] | undefined
): RoutingFlags['context_mode'] | undefined {
  if (contextMode !== 'memory' || !hasStructuralDomainCue(entities)) return contextMode;
  return hasExplicitMemoryRecallRequest(query) ? 'mixed' : 'law';
}

function hasActionableLldbiLegalHints(
  lldbiDerived:
    | Pick<DerivedLldbiHintsResult, 'categories_ranked_top3' | 'document_types_ranked_top3'>
    | undefined
): boolean {
  return (
    (lldbiDerived?.categories_ranked_top3?.length ?? 0) > 0 ||
    (lldbiDerived?.document_types_ranked_top3?.length ?? 0) > 0
  );
}

export function normalizeContextModeForLldbiHints(
  query: string,
  contextMode: RoutingFlags['context_mode'] | undefined,
  lldbiDerived:
    | Pick<DerivedLldbiHintsResult, 'categories_ranked_top3' | 'document_types_ranked_top3'>
    | undefined
): RoutingFlags['context_mode'] | undefined {
  if (!hasActionableLldbiLegalHints(lldbiDerived)) return contextMode;
  if (contextMode !== undefined && contextMode !== 'memory') return contextMode;
  return hasExplicitMemoryRecallRequest(query) ? 'mixed' : 'law';
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
 * Merge ambiguity: only clearly underspecified short-query rule ambiguity hard-overrides LLM.
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
    (rulesAmbiguity.reason_codes?.some((c) => c === 'TOO_SHORT_QUERY') ?? false);
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
function mergeEntities(query: string, pre: ExtractedEntity[], llm: ExtractedEntity[]): ExtractedEntity[] {
  const alignedLlm = alignLlmEntitiesToSurface(query, pre, llm);
  const seen = new Set<string>();
  const out: ExtractedEntity[] = [];
  for (const e of pre) {
    const key = `${e.type}:${e.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  for (const e of alignedLlm) {
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
    ambiguity_source?: 'llm' | 'rules_soft' | 'rules_hard_override' | 'merged';
  },
  lldbiDerived?: DerivedLldbiHintsResult,
  domainHintForU4?: string
): QueryProfile {
  const now = new Date().toISOString();
  const lldbi = lldbiDerived
    ? {
        categories_ranked_top3: lldbiDerived.categories_ranked_top3,
        document_types_ranked_top3: lldbiDerived.document_types_ranked_top3,
        routing_confidence: lldbiDerived.routing_confidence,
        routing_source: lldbiDerived.routing_source,
      }
    : {
        categories_ranked_top3: [] as string[],
        document_types_ranked_top3: [] as string[],
        routing_confidence: metaExtra?.rules_confidence?.overall ?? 0.5,
        routing_source: 'heuristic' as const,
      };
  return {
    query_profile_version: 1,
    intent: intent as QueryProfile['intent'],
    domain: domain as QueryProfile['domain'],
    domainHint: domainHintForU4,
    entities,
    ambiguity,
    computed_flags: {
      has_direct_citation,
      profile_generation: 'rules',
    },
    routing_flags: routing_flags ?? {},
    lldbi,
    meta: {
      classifier_mode: 'rules',
      latency_ms: latencyMs,
      warnings: [],
      ...metaExtra,
      ...(lldbiDerived && {
        u2_lldbi_hints: { derived: true, reasons: lldbiDerived.meta.reasons },
      }),
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
    ambiguity_source?: 'llm' | 'rules_soft' | 'rules_hard_override' | 'merged';
  },
  lldbiDerived?: DerivedLldbiHintsResult,
  domainHintForU4?: string
): QueryProfile {
  const now = new Date().toISOString();
  const lldbi = lldbiDerived
    ? {
        categories_ranked_top3: lldbiDerived.categories_ranked_top3,
        document_types_ranked_top3: lldbiDerived.document_types_ranked_top3,
        routing_confidence: lldbiDerived.routing_confidence,
        routing_source: lldbiDerived.routing_source,
      }
    : {
        categories_ranked_top3: [] as string[],
        document_types_ranked_top3: [] as string[],
        routing_confidence: 0.5,
        routing_source: 'heuristic' as const,
      };
  return {
    query_profile_version: 1,
    intent: 'question',
    domain: 'general',
    domainHint: domainHintForU4,
    entities,
    ambiguity,
    computed_flags: {
      has_direct_citation,
      profile_generation: 'degraded',
    },
    routing_flags: routing_flags ?? {},
    lldbi,
    meta: {
      classifier_mode: 'degraded',
      warnings,
      ...metaExtra,
      ...(lldbiDerived && {
        u2_lldbi_hints: { derived: true, reasons: lldbiDerived.meta.reasons },
      }),
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
    const run = await loadRunForU2(run_id);
    if (!run) {
      logger.error('Run not found', { ...ctx, error: 'run_not_found' });
      incrementU2Failed();
      return;
    }

    // Resolve query: R2 overflow → use snapshot.input.query_preview (head + tail); else run.query
    const snapshotInput = (run.snapshot as { input?: { query_preview?: { head?: string; tail?: string }; query_overflow?: boolean } })?.input;
    const queryPreview = snapshotInput?.query_preview;
    let query =
      queryPreview?.head != null && queryPreview?.tail != null
        ? queryPreview.head + '\n...\n' + queryPreview.tail
        : run.query ?? (run.snapshot?.request as { query?: string })?.query ?? '';
    if (typeof query !== 'string') query = '';
    query = query.trim();
    if (query.length === 0) {
      logger.error('U2 empty query', { ...ctx, error: 'empty_query' });
      incrementU2Failed();
      try {
        await runRepo.markFailed(run_id, 'U2_EMPTY_QUERY');
      } catch (_) {
        // ignore
      }
      decrementU2Inflight();
      return;
    }
    const inputSource: 'db_query' | 'snapshot_preview' | 'r2_full' = queryPreview ? 'snapshot_preview' : 'db_query';

    const tenant_id = run.tenant_id ?? null;
    const user_id = run.user_id;
    const locale = (run.snapshot?.request as { locale?: string })?.locale;

    // Pre-extract (rule-based) — always run for hybrid
    const tPre = Date.now();
    const preExtract = extractEntities(query);
    let preEntities = preExtract.entities;
    const { has_direct_citation } = preExtract;
    const preExtractMs = Date.now() - tPre;

    // U2-preprocessor: long/noise + heuristics (contract/table/legal_text)
    const normalizer = normalizeInput(query, preEntities);
    const effectiveQuery = normalizer.effectiveQuery;
    const exactActAliasGrounding = await enrichEntitiesWithExactActAlias(
      effectiveQuery,
      preEntities
    );
    preEntities = exactActAliasGrounding.entities;
    const routingOverrides = normalizer.routingOverrides;
    const metaExtra =
      normalizer.inputTruncated
        ? {
            input_truncated: true,
            original_length: normalizer.originalLength,
            effective_length: normalizer.effectiveLength,
            input_source: inputSource,
            exact_act_alias_grounded: exactActAliasGrounding.exactActAliasGrounded || undefined,
          }
        : {
            input_source: inputSource,
            exact_act_alias_grounded: exactActAliasGrounding.exactActAliasGrounded || undefined,
          };

    const circuitOpen = isCircuitOpen();
    const useRulesOnlyConfig =
      config.useRuleBasedClassifier || !config.openRouterApiKey || circuitOpen;

    if (circuitOpen && config.openRouterApiKey) {
      logger.warn('U2 circuit open, using rules', { ...ctx });
    }

    // Run rules first to compute confidence (for gating decision)
    const t2a = Date.now();
    let intent = classifyIntent(effectiveQuery);
    const domain = tagLegalDomain(effectiveQuery) as LegalDomain;
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

    // Gating: structural cue from entities only (article_ref, act_abbrev, law_title). No topic wordlists.
    const explicitCue = hasStructuralDomainCue(preEntities);
    const reliableStructuralCue =
      explicitCue &&
      (has_direct_citation || preEntities.some((entity) => entity.type === 'law_title'));
    const skipLlmByGating =
      !useRulesOnlyConfig &&
      config.u2GatingEnabled &&
      explicitCue &&
      !normalizer.isComplexInput &&
      !ambiguity.is_ambiguous &&
      (
        rulesConfidence.overall >= config.u2GatingConfidenceThreshold ||
        (reliableStructuralCue && rulesConfidence.intent >= 0.6 && rulesConfidence.ambiguity >= 0.75)
      );
    const docsOnlyFastPath =
      !useRulesOnlyConfig &&
      config.u2GatingEnabled &&
      shouldUseDocsOnlyFastPath(effectiveQuery);

    const useRulesOnly = useRulesOnlyConfig || skipLlmByGating || docsOnlyFastPath;

    let gatingDecision: GatingDecision;
    if (circuitOpen && config.openRouterApiKey) gatingDecision = 'circuit_open';
    else if (config.useRuleBasedClassifier) gatingDecision = 'rules_only_config';
    else if (docsOnlyFastPath) gatingDecision = 'rules_docs_only_scope';
    else if (skipLlmByGating) gatingDecision = 'rules_high_confidence';
    else gatingDecision = gatingReasonForLlm(normalizer, ambiguity);

    let queryProfile: QueryProfile;
    let routing_flags: RoutingFlags | undefined;

    if (useRulesOnly) {
      const inferredContextMode = inferDeterministicContextMode(
        effectiveQuery,
        preEntities,
        has_direct_citation
      );
      if (skipLlmByGating || docsOnlyFastPath) {
        incrementU2GatingLlmSkipped();
        incrementU2GatingReason(docsOnlyFastPath ? 'rules_docs_only_scope' : 'rules_high_confidence');
      }
      logger.info('U2 rules path', { ...ctx, intent, domain, duration_ms: rulesMs, gating_decision: gatingDecision });
      incrementU2Intent(intent);
      incrementU2Domain(domain);
      if (ambiguity.is_ambiguous) incrementU2Ambiguous();
      const vocabulary = await getLldbiVocabulary();
      const domainHintForU4 = legalDomainToTaxonomyKey(domain) ?? undefined;
      const lldbiDerived = deriveLldbiHintsFromVocabulary({
        queryText: effectiveQuery,
        domainHint: domainHintForU4,
        legalDomain: domain,
        entities: preEntities,
        heuristicConfidence: rulesConfidence.overall,
        vocabulary,
      });
      const normalizedContextModeFromHints = normalizeContextModeForLldbiHints(
        effectiveQuery,
        inferredContextMode,
        lldbiDerived
      );
      const resolvedDomainHintForU4 = domainHintForU4 ?? lldbiDerived.categories_ranked_top3[0] ?? undefined;
      incrementU2RulesRoutingDerived();
      if (lldbiDerived.document_types_ranked_top3.length > 0) incrementU2RulesDocTypeNonempty();
      if (lldbiDerived.categories_ranked_top3.length > 0) incrementU2RulesCategoryNonempty();
      queryProfile = buildRulesProfile(
        query,
        intent,
        domain,
        preEntities,
        has_direct_citation,
        ambiguity,
        rulesMs + preExtractMs,
        {
          ...routingOverrides,
          ...(normalizedContextModeFromHints ? { context_mode: normalizedContextModeFromHints } : {}),
        },
        {
          ...metaExtra,
          gating_decision: gatingDecision,
          rules_confidence: rulesConfidence,
          llm_used_reason: skipLlmByGating ? [] : [gatingDecision],
          ambiguity_source: ambiguity.strength === 'hard' ? 'rules_hard_override' : 'rules_soft',
        },
        lldbiDerived,
        resolvedDomainHintForU4
      );
      if (circuitOpen && queryProfile.meta) {
        queryProfile.meta.warnings = [...(queryProfile.meta.warnings ?? []), 'circuit_open'];
      }
      attachLldbiVocabularyMeta(queryProfile, vocabulary);
      // Rules path: try to repair context_mode when not set and LLM is available
      if (
        queryProfile.routing_flags?.context_mode === undefined &&
        config.openRouterApiKey &&
        !circuitOpen
      ) {
        try {
          const repair = await repairContextMode(
            {
              apiKey: config.openRouterApiKey,
              modelId: config.clfModelId,
              fallbackModelId: config.clfFallbackModelId || undefined,
              timeoutSec: config.clfTimeoutSec,
            },
            effectiveQuery,
            { pre_entities: preEntities, has_direct_citation }
          );
          if ('context_mode' in repair) {
            queryProfile.routing_flags = { ...queryProfile.routing_flags, context_mode: repair.context_mode };
          } else if (queryProfile.meta) {
            queryProfile.meta.warnings = [...(queryProfile.meta.warnings ?? []), repair.reason];
          }
        } catch {
          // repair is best-effort; unresolved fallback remains explicit in U3
        }
      }
      queryProfile.routing_flags = {
        ...queryProfile.routing_flags,
        context_mode: normalizeContextModeForLldbiHints(
          effectiveQuery,
          queryProfile.routing_flags?.context_mode,
          lldbiDerived
        ),
      };
    } else {
      incrementU2GatingLlmCalled();
      incrementU2GatingReason(gatingDecision);
      try {
        const llmResult = await llmSemaphore.run(async () => {
          incrementU2LlmInflight();
          try {
            return await withTransientU2ClassifierRetry(() =>
              classifyWithLLM(
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
              )
            );
          } finally {
            decrementU2LlmInflight();
          }
        });
        incrementU2Intent(llmResult.intent);
        incrementU2Domain(llmResult.domain);
        const { final: finalAmbiguity, ambiguity_source: ambiguitySource, overrideWarning } = mergeAmbiguity(ambiguity, llmResult.ambiguity);
        if (finalAmbiguity.is_ambiguous) incrementU2Ambiguous();
        const mergedEntities = mergeEntities(effectiveQuery, preEntities, llmResult.entities);
        const now = new Date().toISOString();
        routing_flags = { ...routingOverrides, ...llmResult.routing_flags, ambiguous: finalAmbiguity.is_ambiguous };
        if (routing_flags.context_mode === undefined) {
          const inferredContextMode = inferDeterministicContextMode(
            effectiveQuery,
            mergedEntities,
            mergedEntities.some((e) => e.type === 'article_ref' || e.type === 'act_abbrev')
          );
          if (inferredContextMode) {
            routing_flags = { ...routing_flags, context_mode: inferredContextMode };
          } else {
            const repair = await withTransientU2ClassifierRetry(() =>
              repairContextMode(
                {
                  apiKey: config.openRouterApiKey,
                  modelId: config.clfModelId,
                  fallbackModelId: config.clfFallbackModelId || undefined,
                  timeoutSec: config.clfTimeoutSec,
                },
                effectiveQuery,
                {
                  pre_entities: preEntities,
                  has_direct_citation: mergedEntities.some(
                    (e) => e.type === 'article_ref' || e.type === 'act_abbrev'
                  ),
                }
              )
            );
            if ('context_mode' in repair) {
              routing_flags = { ...routing_flags, context_mode: repair.context_mode };
            } else {
              llmResult.meta.warnings = [...(llmResult.meta.warnings || []), repair.reason];
            }
          }
        }
        routing_flags = {
          ...routing_flags,
          context_mode: normalizeContextModeForStructuralLegalCue(
            effectiveQuery,
            mergedEntities,
            routing_flags.context_mode
          ),
        };
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
          lldbi: {
            categories_ranked_top3: [],
            document_types_ranked_top3: [],
            routing_confidence: rulesConfidence.overall,
            routing_source: 'heuristic',
          },
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
        // Навіть на LLM path: derive LLDBI hints із vocabulary (data-driven, без хардкод-словників).
        const vocabulary = await getLldbiVocabulary();
        const domainHintForU4 = legalDomainToTaxonomyKey(llmResult.domain) ?? undefined;
        const lldbiDerived = deriveLldbiHintsFromVocabulary({
          queryText: effectiveQuery,
          domainHint: domainHintForU4,
          legalDomain: llmResult.domain,
          entities: mergedEntities,
          heuristicConfidence: rulesConfidence.overall,
          vocabulary,
        });
        // Keep U4 contract invariant on LLM path; fallback to strongest vocabulary category.
        queryProfile.domainHint = domainHintForU4 ?? lldbiDerived.categories_ranked_top3[0] ?? undefined;
        queryProfile.lldbi = {
          categories_ranked_top3: lldbiDerived.categories_ranked_top3,
          document_types_ranked_top3: lldbiDerived.document_types_ranked_top3,
          routing_confidence: lldbiDerived.routing_confidence,
          routing_source: lldbiDerived.routing_source,
        };
        if (queryProfile.meta) {
          queryProfile.meta.u2_lldbi_hints = { derived: true, reasons: lldbiDerived.meta.reasons };
        }
        attachLldbiVocabularyMeta(queryProfile, vocabulary);
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
        const isTimeout =
          llmErr instanceof OpenRouterError && llmErr.code === 'TIMEOUT';
        const isInvalidJson =
          /Invalid JSON|parse|validation/i.test(warnMsg) ||
          (llmErr instanceof OpenRouterError && llmErr.code !== 'TIMEOUT' && llmErr.code !== 'HTTP_ERROR' && llmErr.code !== 'NETWORK');
        const warningCode = isTimeout
          ? 'llm_timeout_fallback_rules'
          : isInvalidJson
            ? 'llm_invalid_json_fallback_rules'
            : 'llm_fallback_rules';
        const warnings = [warningCode, warnMsg.slice(0, 100)];
        const vocabulary = await getLldbiVocabulary();
        const domainHintForU4 = legalDomainToTaxonomyKey(domain) ?? undefined;
        const lldbiDerived = deriveLldbiHintsFromVocabulary({
          queryText: effectiveQuery,
          domainHint: domainHintForU4,
          legalDomain: domain,
          entities: preEntities,
          heuristicConfidence: 0.5,
          vocabulary,
        });
        const normalizedContextModeFromHints = normalizeContextModeForLldbiHints(
          effectiveQuery,
          inferredContextMode,
          lldbiDerived
        );
        const resolvedDomainHintForU4 = domainHintForU4 ?? lldbiDerived.categories_ranked_top3[0] ?? undefined;
        incrementU2RulesRoutingDerived();
        if (lldbiDerived.document_types_ranked_top3.length > 0) incrementU2RulesDocTypeNonempty();
        if (lldbiDerived.categories_ranked_top3.length > 0) incrementU2RulesCategoryNonempty();
        const inferredContextMode = inferDeterministicContextMode(
          effectiveQuery,
          preEntities,
          has_direct_citation
        );
        queryProfile = buildDegradedProfile(
          query,
          preEntities,
          has_direct_citation,
          ambiguity,
          warnings,
          {
            ...routingOverrides,
            ...(normalizedContextModeFromHints ? { context_mode: normalizedContextModeFromHints } : {}),
          },
          {
            ...metaExtra,
            gating_decision: 'llm_fallback',
            rules_confidence: rulesConfidence,
            llm_used_reason: ['llm_fallback'],
            ambiguity_source: ambiguity.strength === 'hard' ? 'rules_hard_override' : 'rules_soft',
          },
          lldbiDerived,
          resolvedDomainHintForU4
        );
        attachLldbiVocabularyMeta(queryProfile, vocabulary);
        // Degraded/timeout path: try to repair context_mode when not set and LLM is available
        if (
          queryProfile.routing_flags?.context_mode === undefined &&
          config.openRouterApiKey &&
          !isCircuitOpen()
        ) {
          try {
            const repair = await withTransientU2ClassifierRetry(() =>
              repairContextMode(
                {
                  apiKey: config.openRouterApiKey,
                  modelId: config.clfModelId,
                  fallbackModelId: config.clfFallbackModelId || undefined,
                  timeoutSec: Math.min(config.clfTimeoutSec, 10),
                },
                effectiveQuery,
                { pre_entities: preEntities, has_direct_citation }
              )
            );
            if ('context_mode' in repair) {
              queryProfile.routing_flags = { ...queryProfile.routing_flags, context_mode: repair.context_mode };
            } else if (queryProfile.meta) {
              queryProfile.meta.warnings = [...(queryProfile.meta.warnings ?? []), repair.reason];
            }
          } catch {
            // repair is best-effort; unresolved fallback remains explicit in U3
          }
        }
        queryProfile.routing_flags = {
          ...queryProfile.routing_flags,
          context_mode: normalizeContextModeForLldbiHints(
            effectiveQuery,
            queryProfile.routing_flags?.context_mode,
            lldbiDerived
          ),
        };
        queryProfile.routing_flags = {
          ...queryProfile.routing_flags,
          context_mode: normalizeContextModeForStructuralLegalCue(
            effectiveQuery,
            preEntities,
            queryProfile.routing_flags?.context_mode
          ),
        };
        if (ambiguity.is_ambiguous) incrementU2Ambiguous();
        incrementU2Intent('question');
        incrementU2Domain('general');
      }
    }

    const finalDomain = queryProfile.domain;
    const triggerAiDomain =
      config.u2AiDomainEnabled &&
      !!config.openRouterApiKey &&
      (finalDomain === 'general' ||
        (queryProfile.meta?.classifier_mode === 'rules' && rulesConfidence.domain < 0.55));
    if (triggerAiDomain) {
      try {
        incrementU2AiDomainCalled();
        const vocabulary = await getLldbiVocabulary();
        const hasVocabulary =
          (vocabulary.categories.length > 0 || vocabulary.documentTypes.length > 0);
        if (hasVocabulary) incrementU2AiRoutingCalled();
        const aiResult = await withTransientU2ClassifierRetry(() =>
          classifyDomainWithAi(
            {
              openRouterApiKey: config.openRouterApiKey,
              u2AiDomainModel: config.u2AiDomainModel,
              u2AiDomainMaxTokens: config.u2AiDomainMaxTokens,
              u2AiDomainTimeoutMs: config.u2AiDomainTimeoutMs,
              u2AiDomainMaxCallsPerRun: config.u2AiDomainMaxCallsPerRun,
              u2AiDomainMinConfidence: config.u2AiDomainMinConfidence,
            },
            {
              query: effectiveQuery,
              heuristic_domain: finalDomain,
              heuristic_confidence: rulesConfidence.domain,
              run_id,
              vocabulary: hasVocabulary ? vocabulary : undefined,
            }
          )
        );
        const authorityCompatibleAiDocumentTypes = filterDocumentTypesByAuthorityCompatibility(
          aiResult.document_types_ranked_top3 ?? [],
          effectiveQuery,
          queryProfile.entities
        );
        if (queryProfile.meta) {
          queryProfile.meta.u2_domain = {
            primary: aiResult.meta.used ? aiResult.domain_primary : finalDomain,
            secondary: aiResult.domain_secondary,
            confidence: aiResult.confidence,
            source: aiResult.meta.used ? 'ai' : 'heuristic',
          };
          queryProfile.meta.u2_ai_domain = {
            called: aiResult.meta.called,
            used: aiResult.meta.used,
            not_used_reason: aiResult.meta.not_used_reason,
            attempts: aiResult.meta.attempts,
            parse_mode: aiResult.meta.parse_mode,
          };
          if (hasVocabulary) {
            queryProfile.meta.u2_ai_routing = {
              called: true,
              used:
                aiResult.meta.used &&
                (aiResult.confidence >= config.u2AiDomainMinConfidence) &&
                ((aiResult.categories_ranked_top3?.length ?? 0) > 0 ||
                  authorityCompatibleAiDocumentTypes.length > 0),
              categories_top3: aiResult.categories_ranked_top3,
              document_types_top3: authorityCompatibleAiDocumentTypes,
              confidence: aiResult.confidence,
              parse_mode: aiResult.meta.parse_mode,
              not_used_reason: aiResult.meta.not_used_reason,
            };
          }
        }
        if (queryProfile.lldbi) {
          queryProfile.lldbi = {
            categories_ranked_top3: aiResult.categories_ranked_top3 ?? [],
            document_types_ranked_top3: authorityCompatibleAiDocumentTypes,
            routing_confidence: aiResult.confidence,
            routing_source: aiResult.meta.used ? 'ai' : 'heuristic',
          };
        }
        if (aiResult.meta.used) {
          incrementU2AiDomainUsed();
          if (
            hasVocabulary &&
            (aiResult.categories_ranked_top3?.length ?? 0) + authorityCompatibleAiDocumentTypes.length > 0
          ) {
            incrementU2AiRoutingUsed();
          }
          queryProfile.domainHint = aiResult.domain_primary;
          queryProfile.domain_confidence = aiResult.confidence;
          queryProfile.domain_candidates_top2 = [aiResult.domain_primary, aiResult.domain_secondary].filter(
            (s): s is string => !!s && s !== 'unknown'
          );
          if (aiResult.domain_primary !== 'unknown') {
            queryProfile.domain = taxonomyKeyToLegalDomain(aiResult.domain_primary);
          }
        } else {
          if (aiResult.meta.parse_mode === 'failed') {
            incrementU2AiDomainInvalidJson();
            if (hasVocabulary) incrementU2AiRoutingInvalidJson();
          } else if (aiResult.confidence < config.u2AiDomainMinConfidence) {
            incrementU2AiDomainConfTooLow();
            if (hasVocabulary) incrementU2AiRoutingConfTooLow();
          } else if (
            aiResult.domain_primary !== 'unknown' &&
            aiResult.domain_primary !== finalDomain
          ) {
            incrementU2AiDomainDisagreesWithHeuristic();
            if (hasVocabulary) incrementU2AiRoutingDisagreesWithHeuristic();
          }
        }
      } catch (aiErr) {
        if (queryProfile.meta) {
          queryProfile.meta.u2_ai_domain = {
            called: true,
            used: false,
            not_used_reason: aiErr instanceof Error ? aiErr.message : String(aiErr),
            attempts: 1,
            parse_mode: 'failed',
          };
        }
        incrementU2AiDomainInvalidJson();
      }
    }

    let history: Array<{ role: string; content: string }> | undefined;
    if (run.conversation_id) {
      history = await withTransientGatewayIoRetry(() =>
        runRepo.listConversationMessages(run.conversation_id!, 20)
      );
    }
    const projectId =
      ((run.snapshot as { project_context?: { project_id?: string | null } } | undefined)?.project_context
        ?.project_id as string | null | undefined) ?? undefined;

    const persistOnce = async (): Promise<void> => {
      await runContextSet(
        run_id,
        {
          query_profile: queryProfile,
          routing_flags: queryProfile.routing_flags ?? {},
          user_input: effectiveQuery,
          tenant_id: tenant_id ?? undefined,
          user_id: user_id ?? undefined,
          conversation_id: (run.conversation_id as string | null) ?? undefined,
          project_id: projectId,
          history,
        },
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

    const now = new Date().toISOString();
    const taskQueue = getTaskQueue();
    await withTransientGatewayIoRetry(() =>
      taskQueue.enqueue({
        run_id,
        step: 'U3',
        created_at: now,
        trace_id,
      })
    );

    logger.info('U2 finished', {
      ...ctx,
      duration_ms: Date.now() - start,
      next_step: 'U3',
      classifier_mode: queryProfile.meta?.classifier_mode ?? 'rules',
    });
    logger.info('U3 enqueued', { run_id, trace_id });
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
