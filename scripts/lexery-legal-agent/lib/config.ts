/**
 * Lexery Legal Agent — Config
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../.env') });

/** OpenRouter key precedence: BRAIN > ONLINE. Used by config and by unit tests. */
function getOpenRouterKeyFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.OPENROUTER_API_KEY_BRAIN || env.OPENROUTER_API_KEY_ONLINE || '') as string;
}

function parsePort(value: string, defaultPort: number): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : defaultPort;
}

export const config = {
  port: parsePort(process.env.BRAIN_PORT || '3081', 3081),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  // Dev auth (LEX-69)
  devApiKey: process.env.DEV_API_KEY || '',
  devAllowAnonymous: process.env.DEV_ALLOW_ANONYMOUS === 'true',

  // Supabase (LEXERY LEGAL AGENT DB)
  supabaseUrl: process.env.SUPABASE_LEXERY_LEGAL_AGENT_DB_URL || '',
  supabaseServiceKey: process.env.SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY || '',

  // Supabase Legislation (metadata for ActTaxonomyStore; optional — graceful no-taxonomy if missing)
  supabaseLegislationUrl:
    process.env.SUPABASE_LEGISLATION_URL ||
    process.env.SUPABASE_LEGISLATION_RAG_URL ||
    '',
  supabaseLegislationServiceKey:
    process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_LEGISLATION_RAG_SERVICE_ROLE_KEY ||
    '',
  actTaxonomyTtlSec: Math.max(60, parseInt(process.env.ACT_TAXONOMY_TTL_SEC || '3600', 10)),

  // R2 (for attachments overflow)
  r2Endpoint: process.env.R2_ENDPOINT || '',
  r2AccessKey: process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY || '',
  r2SecretKey: process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY || '',
  r2BucketRuns: process.env.R2_RUNS_BUCKET || process.env.R2_BUCKET_RUNS || 'lexery-legal-agent',
  /** LLDBI canonical JSON bucket. Aliases: R2_LEGISLATION_BUCKET, R2_BUCKET_LEGISLATION. */
  r2BucketLegislation:
    process.env.LLDBI_R2_BUCKET ||
    process.env.R2_LEGISLATION_BUCKET ||
    process.env.R2_BUCKET_LEGISLATION ||
    'legislation',
  /** Optional prefix for LLDBI keys (e.g. "legislation/"). Keys may already include it. */
  lldbiR2Prefix: process.env.LLDBI_R2_PREFIX || '',
  r2Region: process.env.R2_REGION || 'auto',

  // Limits (LEX-70)
  runsPerMinute: parseInt(process.env.RUNS_PER_MINUTE || '30', 10),
  maxConcurrentRuns: parseInt(process.env.MAX_CONCURRENT_RUNS || '10', 10),

  // Attachments (LEX-72)
  attachmentInlineMaxBytes: parseInt(process.env.ATTACHMENT_INLINE_MAX_BYTES || '524288', 10), // 512KB
  requestInlineMaxBytes: parseInt(process.env.REQUEST_INLINE_MAX_BYTES || '2097152', 10), // 2MB

  // Query overflow to R2 (U1): store full query in R2 when over threshold, DB keeps preview only
  queryR2ThresholdBytes: parseInt(process.env.QUERY_R2_THRESHOLD_BYTES || '32768', 10), // 32KB
  queryPreviewHeadChars: parseInt(process.env.QUERY_PREVIEW_HEAD_CHARS || '2000', 10),
  queryPreviewTailChars: parseInt(process.env.QUERY_PREVIEW_TAIL_CHARS || '1000', 10),

  // API version
  apiVersion: 'v1',

  // U2 Query Profiling (LEX-91) + LLM-first (answer.md)
  u2DisableConsumer: process.env.U2_DISABLE_CONSUMER === 'true',
  useRuleBasedClassifier: process.env.USE_RULE_BASED_CLASSIFIER === 'true',
  u2IntentLlmEnabled: process.env.U2_INTENT_LLM_ENABLED !== 'false',
  u2DomainLlmEnabled: process.env.U2_DOMAIN_LLM_ENABLED !== 'false',
  u2EntityExtractorStrict: process.env.U2_ENTITY_EXTRACTOR_STRICT === 'true',

  // OpenRouter: BRAIN takes precedence for U2/U9/U10 and submodules (composer, triage, embeddings, memory extractor).
  /** Single key for all Brain LLM/embedding calls. Precedence: OPENROUTER_API_KEY_BRAIN > OPENROUTER_API_KEY_ONLINE. */
  openRouterApiKey: getOpenRouterKeyFromEnv(process.env),
  clfModelId: process.env.CLF_MODEL_ID || 'openai/gpt-4o-mini',
  clfFallbackModelId: process.env.CLF_FALLBACK_MODEL_ID || '',
  clfTimeoutSec: Math.max(1, parseInt(process.env.CLF_TIMEOUT_SEC || '5', 10)),

  // Concurrency & stores (prod-ready)
  redisUrl: process.env.REDIS_URL || '',
  runContextDriver: (process.env.RUN_CONTEXT_DRIVER || 'inmemory').toLowerCase() as 'inmemory' | 'redis',
  queueDriver: (process.env.QUEUE_DRIVER || 'inmemory').toLowerCase() as 'inmemory' | 'redis',
  u2WorkerConcurrency: Math.max(1, parseInt(process.env.U2_WORKER_CONCURRENCY || '10', 10)),
  u2LlmConcurrency: Math.max(1, parseInt(process.env.U2_LLM_CONCURRENCY || '4', 10)),

  // Smart gating: skip LLM when rules confidence >= threshold and input not complex
  u2GatingConfidenceThreshold: Math.min(1, Math.max(0, parseFloat(process.env.U2_GATING_CONFIDENCE_THRESHOLD || '0.75'))),
  u2GatingEnabled: process.env.U2_GATING_ENABLED !== 'false',

  // U2 AI Domain Classifier (Phase 6): optional, only when heuristic low/unknown; max 1 call/run
  u2AiDomainEnabled: process.env.U2_AI_DOMAIN_ENABLED === 'true',
  u2AiDomainModel: process.env.U2_AI_DOMAIN_MODEL || 'anthropic/claude-3.5-haiku',
  u2AiDomainMaxTokens: Math.max(64, Math.min(256, parseInt(process.env.U2_AI_DOMAIN_MAX_TOKENS || '160', 10))),
  u2AiDomainTimeoutMs: Math.max(2000, Math.min(10000, parseInt(process.env.U2_AI_DOMAIN_TIMEOUT_MS || '4500', 10))),
  u2AiDomainMaxCallsPerRun: Math.max(1, Math.min(2, parseInt(process.env.U2_AI_DOMAIN_MAX_CALLS_PER_RUN || '1', 10))),
  u2AiDomainMinConfidence: Math.min(1, Math.max(0, parseFloat(process.env.U2_AI_DOMAIN_MIN_CONFIDENCE || '0.55'))),

  // U4 CacheRAG (LEX-114, LEX-117): Qdrant + embeddings
  qdrantUrl:
    process.env.QDRANT_URL ||
    process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LEGISLATION_DB ||
    process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB ||
    '',
  qdrantApiKey:
    process.env.QDRANT_API_KEY ||
    process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB ||
    '',
  qdrantTimeoutSec: Math.max(1, parseInt(process.env.QDRANT_TIMEOUT_SEC || '5', 10)),
  qdrantRetryOnce: process.env.QDRANT_RETRY_ONCE !== 'false',
  lldbiCollectionChunks: process.env.LLDBI_COLLECTION_CHUNKS || 'lexery_legislation_chunks',
  lldbiCollectionActs: process.env.LLDBI_COLLECTION_ACTS || 'lexery_legislation_acts',
  // Reduced from 50→40: saves ~20% Qdrant bandwidth per goal without recall regression
  // on current 7/7 smoke (act planner + routing-hints remain primary recall drivers)
  lldbiTopK: Math.max(1, Math.min(200, parseInt(process.env.LLDBI_TOP_K || '40', 10))),
  /** Mixed mode (law + memory): cap law chunks to reduce noise. */
  mixedModeLawTopKChunks: Math.max(1, Math.min(50, parseInt(process.env.MIXED_MODE_LAW_TOP_K_CHUNKS || '10', 10))),
  /** Mixed mode: max law snippets in assembled prompt (lower than pure-law to avoid law-heavy drift). */
  mixedModeLawMaxSnippets: Math.max(4, Math.min(20, parseInt(process.env.MIXED_MODE_LAW_MAX_SNIPPETS || '8', 10))),
  /** Legacy knob retained for compatibility; pure memory callers now hard-zero law snippets. */
  memoryRecallLawMaxSnippets: Math.max(0, Math.min(5, parseInt(process.env.MEMORY_RECALL_LAW_MAX_SNIPPETS || '0', 10))),
  minScoreThreshold: Math.min(1, Math.max(0, parseFloat(process.env.MIN_SCORE_THRESHOLD || '0.1'))),
  u4QdrantConcurrency: Math.max(1, parseInt(process.env.U4_QDRANT_CONCURRENCY || '20', 10)),

  // U4 Embeddings (aligned with LLDBI index: 1536d, openai/text-embedding-3-small)
  lldbiEmbedModelId: process.env.LLDBI_EMBED_MODEL_ID || 'openai/text-embedding-3-small',
  lldbiEmbedTimeoutSec: Math.max(1, parseInt(process.env.LLDBI_EMBED_TIMEOUT_SEC || '5', 10)),
  /** Max batch size for embedMany (OpenRouter embeddings array input). */
  lldbiEmbedBatchSize: Math.max(1, Math.min(64, parseInt(process.env.LLDBI_EMBED_BATCH_SIZE || '16', 10))),
  // U4 embeddings + MM use same Brain key (BRAIN > ONLINE).
  openRouterApiKeyRag: getOpenRouterKeyFromEnv(process.env),

  // U5 Gate (LEX-118)
  gateMinHitsThreshold: Math.max(0, parseInt(process.env.GATE_MIN_HITS_THRESHOLD || '3', 10)),
  gateMinAvgScore: Math.min(1, Math.max(0, parseFloat(process.env.GATE_MIN_AVG_SCORE || '0.18'))),
  doclistEnabled: process.env.DOCLIST_ENABLED !== 'false',
  forceExpand: process.env.FORCE_EXPAND === 'true',
  gateDecisionVersion: Math.max(1, parseInt(process.env.GATE_DECISION_VERSION || '1', 10)),

  // U10 Legal Agent (LEX-133; DEV RUN v17: GPT-5.2 via OpenRouter)
  legalAgentModelId:
    process.env.LEGAL_AGENT_MODEL_ID || process.env.U10_MODEL_ID || 'openai/gpt-5.2',
  legalAgentTimeoutSec: Math.max(30, Math.min(120, parseInt(process.env.LEGAL_AGENT_TIMEOUT_SEC || '55', 10))),
  legalAgentMaxTokens: Math.max(512, Math.min(16384, parseInt(process.env.LEGAL_AGENT_MAX_TOKENS || '4096', 10))),
  /** Skip real LLM in U10 (verify/CI). Use dry_run on run or LEGAL_AGENT_DISABLE_LLM=true. */
  legalAgentDisableLlm:
    process.env.LEGAL_AGENT_DISABLE_LLM === 'true' || process.env.LLM_MODE === 'mock',
  /** When true and LEGAL_AGENT_DISABLE_LLM=true: run focus + evidence triage + u10_selection snapshot, then stub LLM (smoke validates U10 triage). */
  u10DryRunKeepTriage: process.env.U10_DRY_RUN_KEEP_TRIAGE === 'true',

  // Prompt Composer (pre-U10; DEV RUN v17: GPT-5 nano / GPT-5.2)
  promptComposerEnabled: process.env.PROMPT_COMPOSER_ENABLED !== 'false',
  promptComposerModelComplexId:
    process.env.PROMPT_COMPOSER_MODEL_COMPLEX_ID || 'openai/gpt-5.2',
  promptComposerModelSimpleId:
    process.env.PROMPT_COMPOSER_MODEL_SIMPLE_ID || 'openai/gpt-5-nano',
  promptComposerSkipThreshold: Math.min(10, Math.max(0, parseInt(process.env.PROMPT_COMPOSER_SKIP_THRESHOLD || '2', 10))),
  promptComposerUseComplexThreshold: Math.min(10, Math.max(0, parseInt(process.env.PROMPT_COMPOSER_USE_COMPLEX_THRESHOLD || '6', 10))),
  promptComposerTimeoutSec: Math.max(5, Math.min(30, parseInt(process.env.PROMPT_COMPOSER_TIMEOUT_SEC || '15', 10))),
  promptComposerMaxTokens: Math.max(256, Math.min(2048, parseInt(process.env.PROMPT_COMPOSER_MAX_TOKENS || '512', 10))),

  // U4 optional rerank (LLM): only when enabled; strict timeout; fallback to hybrid re-score
  u4RerankEnabled: process.env.U4_RERANK_ENABLED === 'true',
  u4RerankTimeoutSec: Math.max(1, Math.min(5, parseInt(process.env.U4_RERANK_TIMEOUT_SEC || '3', 10))),

  // U4 multi-goal evidence (evidence goals max; heuristic splitter cap)
  u4GoalsMax: Math.max(1, Math.min(5, parseInt(process.env.U4_GOALS_MAX || '3', 10))),
  /** Per-goal min hits in top N when coverage enforced (multi-goal fusion). */
  u4FusionTopN: Math.max(10, Math.min(50, parseInt(process.env.U4_FUSION_TOP_N || '30', 10))),
  u4FusionMinHitsPerGoal: Math.max(2, Math.min(15, parseInt(process.env.U4_FUSION_MIN_HITS_PER_GOAL || '5', 10))),

  // U4 Selective LLM Retrieval Planner (only when triggers; reuse OpenRouter + circuit)
  // Default true: planner is proven production-critical for multi-clause quality (LEX-2026-03-10)
  u4PlannerEnabled: process.env.U4_PLANNER_ENABLED !== 'false',
  u4PlannerModelId: process.env.U4_PLANNER_MODEL_ID || process.env.CLF_MODEL_ID || 'openai/gpt-4o-mini',
  u4PlannerTimeoutSec: Math.max(2, Math.min(15, parseInt(process.env.U4_PLANNER_TIMEOUT_SEC || '8', 10))),
  u4PlannerMaxTokens: Math.max(256, Math.min(2048, parseInt(process.env.U4_PLANNER_MAX_TOKENS || '512', 10))),
  u4PlannerConcurrency: Math.max(1, parseInt(process.env.U4_PLANNER_CONCURRENCY || '2', 10)),

  /** Max raw hits returned to downstream (U5/U9); prevents payload blow-up. */
  u4HitsCap: Math.max(30, Math.min(200, parseInt(process.env.U4_HITS_CAP || '100', 10))),

  // U4 Weak-labeling (Phase 5.1): optional LLM labeler for low-confidence queries
  u4LabelerEnabled: process.env.U4_LABELER_ENABLED === 'true',
  u4LabelerModel: process.env.U4_LABELER_MODEL || process.env.CLF_MODEL_ID || 'openai/gpt-4o-mini',
  u4LabelerMaxTokens: Math.max(128, Math.min(512, parseInt(process.env.U4_LABELER_MAX_TOKENS || '256', 10))),
  u4LabelerConfidenceThreshold: Math.min(1, Math.max(0, parseFloat(process.env.U4_LABELER_CONFIDENCE_THRESHOLD || '0.5'))),

  // U4 Act Retrieval Planner (Phase 5.4): LLM-first act routing, budgeted
  // Default true: act planner is proven production-critical; used in >80% of smoke cases (LEX-2026-03-10)
  u4ActPlannerEnabled: process.env.U4_ACT_PLANNER_ENABLED !== 'false',
  u4ActPlannerModel: process.env.U4_ACT_PLANNER_MODEL || process.env.CLF_MODEL_ID || 'openai/gpt-4o-mini',
  u4ActPlannerMaxTokensTier1: Math.max(220, Math.min(350, parseInt(process.env.U4_ACT_PLANNER_MAX_TOKENS_TIER1 || '280', 10))),
  u4ActPlannerMaxTokensTier2: Math.max(450, Math.min(700, parseInt(process.env.U4_ACT_PLANNER_MAX_TOKENS_TIER2 || '550', 10))),
  u4ActPlannerMaxCallsPerRun: Math.max(1, Math.min(2, parseInt(process.env.U4_ACT_PLANNER_MAX_CALLS_PER_RUN || '1', 10))),
  // Reduced from 10s→8s: tighter timeout reduces stuck-planner tail latency; quality unaffected for sub-8s calls
  u4ActPlannerTimeoutSec: Math.max(3, Math.min(15, parseInt(process.env.U4_ACT_PLANNER_TIMEOUT_SEC || '8', 10))),

  // U4 Routing-hints LLM (Phase 6.1): budgeted, rare; only when evidence weak/conflict/coverage failed
  // Default true: routing-hints are a recovery path for low/zero-recall; deploy-safe (LEX-2026-03-10)
  u4RoutingHintsEnabled: process.env.U4_ROUTING_HINTS_ENABLED !== 'false',
  u4RoutingHintsModel:
    process.env.U4_ROUTING_HINTS_MODEL || process.env.CLF_MODEL_ID || 'anthropic/claude-3.5-haiku',
  u4RoutingHintsMaxTokens: Math.max(128, Math.min(512, parseInt(process.env.U4_ROUTING_HINTS_MAX_TOKENS || '256', 10))),
  u4RoutingHintsMaxCallsPerRun: Math.max(1, Math.min(2, parseInt(process.env.U4_ROUTING_HINTS_MAX_CALLS_PER_RUN || '1', 10))),
  u4RoutingHintsConcurrency: Math.max(1, parseInt(process.env.U4_ROUTING_HINTS_CONCURRENCY || '1', 10)),
  u4RoutingHintsTimeoutSec: Math.max(3, Math.min(15, parseInt(process.env.U4_ROUTING_HINTS_TIMEOUT_SEC || '8', 10))),
  u4RoutingHintsCacheByRunId: process.env.U4_ROUTING_HINTS_CACHE_BY_RUN_ID !== 'false',

  // U4 Reference expansion: extract refs from top chunks, resolve via taxonomy, add hits (budgeted)
  u4ReferenceExpansionEnabled: process.env.U4_REFERENCE_EXPANSION_ENABLED !== 'false',
  u4ReferenceExpansionMaxReferencedActs: Math.min(4, Math.max(1, parseInt(process.env.U4_REFERENCE_EXPANSION_MAX_ACTS || '2', 10))),
  u4ReferenceExpansionMaxAddedHits: Math.min(20, Math.max(5, parseInt(process.env.U4_REFERENCE_EXPANSION_MAX_HITS || '10', 10))),
  u4ReferenceExpansionMaxQdrantCalls: Math.min(8, Math.max(2, parseInt(process.env.U4_REFERENCE_EXPANSION_MAX_QDRANT_CALLS || '4', 10))),

  // U4 Article-reference backfill: add hits for query article refs missing from semantic results (no domain wordlists)
  u4ArticleBackfillEnabled: process.env.U4_ARTICLE_BACKFILL_ENABLED !== 'false',
  u4ArticleBackfillMaxCalls: Math.min(10, Math.max(1, parseInt(process.env.U4_ARTICLE_BACKFILL_MAX_CALLS || '3', 10))),
  u4ArticleBackfillMaxAddedHits: Math.min(15, Math.max(3, parseInt(process.env.U4_ARTICLE_BACKFILL_MAX_ADDED_HITS || '8', 10))),

  // U4 Always-on Query Rewriter (Phase 7): budgeted, every run; enriches short/raw queries for retrieval
  u4QueryRewriteEnabled: process.env.U4_QUERY_REWRITE_ENABLED !== 'false',
  // gpt-4o-mini надійніше дотримується "return ONLY JSON" ніж haiku; 600 токенів достатньо для
  // rewritten_query + 3 variants + negative_terms у Ukrainian без truncation.
  u4QueryRewriteModel: process.env.U4_QUERY_REWRITE_MODEL || 'openai/gpt-4o-mini',
  u4QueryRewriteMaxTokens: Math.max(300, Math.min(800, parseInt(process.env.U4_QUERY_REWRITE_MAX_TOKENS || '600', 10))),
  u4QueryRewriteTimeoutSec: Math.max(3, Math.min(15, parseInt(process.env.U4_QUERY_REWRITE_TIMEOUT_SEC || '8', 10))),
  u4QueryRewriteMaxCallsPerRun: Math.max(1, Math.min(2, parseInt(process.env.U4_QUERY_REWRITE_MAX_CALLS_PER_RUN || '1', 10))),
  /** Min overall_confidence to use rewritten_query; below this keep original (trace not_used_reason_codes: LOW_CONFIDENCE). */
  u4QueryRewriteMinConfidence: Math.min(1, Math.max(0, parseFloat(process.env.U4_QUERY_REWRITE_MIN_CONFIDENCE || '0.5'))),

  // U4 Multi-query retrieval (RRF): use query_variants for semantic expansion; improves recall for synonyms/paraphrases
  u4MultiQueryEnabled: process.env.U4_MULTI_QUERY_ENABLED !== 'false',
  u4MultiQueryMaxVariants: Math.min(3, Math.max(1, parseInt(process.env.U4_MULTI_QUERY_MAX_VARIANTS || '2', 10))),

  // U4 LLDBI Soft Prior: boost act candidates whose category/doc_type matches U2 LLDBI hints (data-driven, no wordlists)
  u4LldbiSoftPriorEnabled: process.env.U4_LLDBI_SOFT_PRIOR_ENABLED !== 'false',
  /** Category match boost: 0.08 for top hint, 0.04 for 2nd/3rd. Capped at 0.1. */
  u4LldbiSoftPriorCategoryBoost: Math.min(0.2, Math.max(0, parseFloat(process.env.U4_LLDBI_SOFT_PRIOR_CATEGORY_BOOST || '0.08'))),
  /** Document type match boost (soft, separate from category). */
  u4LldbiSoftPriorDocTypeBoost: Math.min(0.15, Math.max(0, parseFloat(process.env.U4_LLDBI_SOFT_PRIOR_DOC_TYPE_BOOST || '0.06'))),

  // U4 OOD Confidence Guard: force low_confidence=true when evidence is weak + domain unknown + no hints
  u4OodGuardEnabled: process.env.U4_OOD_GUARD_ENABLED !== 'false',
  /** top_score threshold below which OOD guard may fire (combined with other conditions). */
  u4OodGuardTopScoreThreshold: Math.min(1, Math.max(0, parseFloat(process.env.U4_OOD_GUARD_TOP_SCORE_THRESHOLD || '0.55'))),
  /** avg_score threshold (of finalHits) below which OOD guard may fire. */
  u4OodGuardAvgScoreThreshold: Math.min(1, Math.max(0, parseFloat(process.env.U4_OOD_GUARD_AVG_SCORE_THRESHOLD || '0.52'))),

  // U9 Assemble budgeting (LEX-132; DEV RUN v18: GPT-5.2 profile)
  /** Profile: "gpt5" = larger snippet/total for GPT-5.2 context (fewer but fuller). */
  u9BudgetProfile: (process.env.U9_BUDGET_PROFILE || '').toLowerCase() === 'gpt5' ? 'gpt5' : 'default',
  /** Max law snippets to load from R2 (after dedup). */
  u9MaxLawSnippets: Math.max(5, Math.min(30, parseInt(process.env.U9_MAX_LAW_SNIPPETS || '20', 10))),
  /** Max chars per single law snippet (truncated at word boundary). gpt5: 2600. */
  u9MaxSnippetChars: (() => {
    const profile = (process.env.U9_BUDGET_PROFILE || '').toLowerCase() === 'gpt5';
    const raw = process.env.U9_MAX_SNIPPET_CHARS || (profile ? '2600' : '2000');
    return Math.max(500, Math.min(5000, parseInt(raw, 10)));
  })(),
  /** Max total chars for all law snippets combined. gpt5: 42000. */
  u9MaxTotalLawChars: (() => {
    const profile = (process.env.U9_BUDGET_PROFILE || '').toLowerCase() === 'gpt5';
    const raw = process.env.U9_MAX_TOTAL_LAW_CHARS || (profile ? '42000' : '30000');
    return Math.max(5000, Math.min(80000, parseInt(raw, 10)));
  })(),
  /** Per-mode max total law chars: mixed (tighter to meet prompt ceiling). */
  u9MixedModeMaxTotalLawChars: Math.max(4000, Math.min(40000, parseInt(process.env.U9_MIXED_MODE_MAX_TOTAL_LAW_CHARS || '4200', 10))),
  /** Per-mode max total law chars: law mode (tighter to meet prompt ceiling). */
  u9LawModeMaxTotalLawChars: Math.max(4000, Math.min(60000, parseInt(process.env.U9_LAW_MODE_MAX_TOTAL_LAW_CHARS || '4200', 10))),
  /** Per-mode max chars per law snippet: mixed (to meet prompt ceiling). */
  u9MixedModeMaxLawSnippetChars: Math.max(200, Math.min(2000, parseInt(process.env.U9_MIXED_MODE_MAX_LAW_SNIPPET_CHARS || '700', 10))),
  /** Per-mode max chars per law snippet: law mode. */
  u9LawModeMaxLawSnippetChars: Math.max(200, Math.min(2000, parseInt(process.env.U9_LAW_MODE_MAX_LAW_SNIPPET_CHARS || '700', 10))),
  /** Max total chars for memory channel (memory mode). */
  u9MaxTotalMemoryChars: Math.max(1000, Math.min(20000, parseInt(process.env.U9_MAX_TOTAL_MEMORY_CHARS || '6000', 10))),
  /** Max history messages (memory mode). */
  u9MaxHistoryMessages: Math.max(1, Math.min(20, parseInt(process.env.U9_MAX_HISTORY_MESSAGES || '10', 10))),
  /** Per-mode history cap: mixed mode (tighter for prompt ceiling). */
  u9MixedModeHistoryMessages: Math.max(1, Math.min(10, parseInt(process.env.U9_MIXED_MODE_HISTORY_MESSAGES || '1', 10))),
  /** Per-mode history cap: law mode (strict minimal continuity). */
  u9LawModeHistoryMessages: Math.max(1, Math.min(5, parseInt(process.env.U9_LAW_MODE_HISTORY_MESSAGES || '1', 10))),
  /** Per-mode memory chars: mixed mode (bounded). */
  u9MixedModeMemoryChars: Math.max(0, Math.min(10000, parseInt(process.env.U9_MIXED_MODE_MEMORY_CHARS || '4000', 10))),
  /** Law mode: memory channel disabled (0). */
  u9LawModeMemoryChars: 0,
  /** Per-mode docs chars: mixed mode (bounded; keep below legal+memory budget). */
  u9MixedModeDocChars: Math.max(0, Math.min(12000, parseInt(process.env.U9_MIXED_MODE_DOC_CHARS || '2600', 10))),
  /** Per-mode docs chars: law mode (allow document evidence but keep it bounded). */
  u9LawModeDocChars: Math.max(0, Math.min(12000, parseInt(process.env.U9_LAW_MODE_DOC_CHARS || '3200', 10))),
  /** Max chars per single MM Docs snippet loaded into U9. */
  u9DocMaxSnippetChars: Math.max(200, Math.min(2500, parseInt(process.env.U9_DOC_MAX_SNIPPET_CHARS || '1100', 10))),
  /** Max concurrent R2 fragment fetches. */
  u9R2Concurrency: Math.max(1, Math.min(10, parseInt(process.env.U9_R2_CONCURRENCY || '6', 10))),
  /** Soft cap: max chunks per r2_key in U9 selection (diversity). */
  u9MaxChunksPerSource: Math.max(2, Math.min(12, parseInt(process.env.U9_MAX_CHUNKS_PER_SOURCE || '6', 10))),
  /** Anchor top-K by retrieval score in candidate pool. */
  u9AnchorTopK: Math.max(1, Math.min(20, parseInt(process.env.U9_ANCHOR_TOP_K || '5', 10))),
  /** U9 multi-signal weights: retrieval, model, query_number, lexical, novelty (novelty is penalty). Sum should be 1 if novelty not used. */
  u9WeightRetrieval: Math.min(1, Math.max(0, parseFloat(process.env.U9_WEIGHT_RETRIEVAL || '0.25'))),
  u9WeightModel: Math.min(1, Math.max(0, parseFloat(process.env.U9_WEIGHT_MODEL || '0.25'))),
  u9WeightQueryNumber: Math.min(1, Math.max(0, parseFloat(process.env.U9_WEIGHT_QUERY_NUMBER || '0.15'))),
  u9WeightLexical: Math.min(1, Math.max(0, parseFloat(process.env.U9_WEIGHT_LEXICAL || '0.25'))),
  u9WeightNovelty: Math.min(1, Math.max(0, parseFloat(process.env.U9_WEIGHT_NOVELTY || '0.1'))),
  /** PHASE 3: lightweight semantic title/metadata signal (embed query + candidate meta). Default 0.20. */
  u9WeightSemanticMeta: Math.min(0.5, Math.max(0, parseFloat(process.env.U9_WEIGHT_SEMANTIC_META || '0.20'))),
  /** Relevance floor on multi-signal score (noise control). Explicit signals (query-number / model pick) can bypass. */
  u9RelevanceFloor: Math.min(1, Math.max(0, parseFloat(process.env.U9_RELEVANCE_FLOOR || '0.08'))),
  /** PHASE 3: hard floor — candidate always cut below this unless explicit article ref match. */
  u9RelevanceFloorHard: (() => {
    const v = process.env.U9_RELEVANCE_FLOOR_HARD;
    if (v != null && v !== '') return Math.min(1, Math.max(0, parseFloat(v)));
    return Math.min(1, Math.max(0, parseFloat(process.env.U9_RELEVANCE_FLOOR || '0.08')));
  })(),
  /** PHASE 3: soft floor — penalty only when score below this. */
  u9RelevanceFloorSoft: (() => {
    const v = process.env.U9_RELEVANCE_FLOOR_SOFT;
    if (v != null && v !== '') return Math.min(1, Math.max(0, parseFloat(v)));
    return Math.min(1, Math.max(0, parseFloat(process.env.U9_RELEVANCE_FLOOR || '0.08')));
  })(),
  /** Source redundancy penalty: per-duplicate penalty when multiple candidates share same source family. Default 0.02 (mild). */
  u9SourceRedundancyPenalty: Math.min(0.3, Math.max(0, parseFloat(process.env.U9_SOURCE_REDUNDANCY_PENALTY || '0.02'))),
  /** Weight for structural legalness feature (article_number + heading/token richness). Default conservative. */
  u9WeightStructuralLegalness: Math.min(0.15, Math.max(0, parseFloat(process.env.U9_WEIGHT_STRUCTURAL_LEGALNESS || '0.05'))),

  // U4 Memory Retrieval (LEX-MEM): fetch recent mm_memory_items for tenant+user; non-fatal degraded on failure.
  // Tables live in the same Supabase project as runs (supabaseUrl / supabaseServiceKey).
  /** Enable recent memory fetch from mm_memory_items (Supabase). Default: true. Disable with MEMORY_RECENT_ENABLED=false. */
  memoryRecentEnabled: process.env.MEMORY_RECENT_ENABLED !== 'false',
  /** Max items from mm_memory_items per run. */
  memoryRecentLimit: Math.max(1, Math.min(20, parseInt(process.env.MEMORY_RECENT_LIMIT || '5', 10))),
  /** Timeout for mm_memory_items fetch (ms). Non-fatal if exceeded. */
  memoryRecentTimeoutMs: Math.max(300, Math.min(5000, parseInt(process.env.MEMORY_RECENT_TIMEOUT_MS || '1500', 10))),
  /**
   * Enable semantic memory search via Qdrant (lexery_memory_semantic_v1).
   * Requires memory cluster (LEXERY-LA). Default: false.
   */
  memorySemanticEnabled: process.env.MEMORY_SEMANTIC_ENABLED === 'true',
  /** Allow fallback to legislation cluster for memory only when explicitly set. Default: false. */
  memoryQdrantAllowLegislationFallback:
    process.env.MEMORY_QDRANT_ALLOW_LEGISLATION_FALLBACK === 'true',
  /**
   * Qdrant memory cluster URL. LEXERY-LA only; no silent fallback to legislation.
   * Precedence: QDRANT_MEMORY_URL > LEXERY_LA cluster env (all naming variants).
   */
  memoryQdrantUrl: (() => {
    const canonical =
      process.env.QDRANT_MEMORY_URL ||
      process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA ||
      process.env.qdrant_clusterENDPOINT_LEXERY_LA ||
      process.env.Qdrant_clusterENDPOINT_LEXERY_LA ||
      '';
    if (canonical) return canonical;
    const allowFallback = process.env.MEMORY_QDRANT_ALLOW_LEGISLATION_FALLBACK === 'true';
    if (allowFallback) {
      return (
        process.env.QDRANT_URL ||
        process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LEGISLATION_DB ||
        process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB ||
        ''
      );
    }
    return '';
  })(),
  memoryQdrantApiKey: (() => {
    const canonical =
      process.env.QDRANT_MEMORY_API_KEY ||
      process.env.QDRANT_CLUSTER_API_KEY_LEXERY_LA ||
      process.env.qdrant_clusterAPI_LEXERY_LA ||
      process.env.Qdrant_clusterAPI_LEXERY_LA ||
      '';
    if (canonical) return canonical;
    const allowFallback = process.env.MEMORY_QDRANT_ALLOW_LEGISLATION_FALLBACK === 'true';
    if (allowFallback) {
      return process.env.QDRANT_API_KEY || process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB || '';
    }
    return '';
  })(),
  memoryQdrantCollection: process.env.MEMORY_QDRANT_COLLECTION || 'lexery_memory_semantic_v1',
  memorySemanticTopK: Math.max(1, Math.min(20, parseInt(process.env.MEMORY_TOP_K || '8', 10))),
  memorySemanticTimeoutMs: Math.max(500, Math.min(8000, parseInt(process.env.MEMORY_SEMANTIC_TIMEOUT_MS || '3000', 10))),

  // MM Outbox Worker (DEV RUN v10; LEX-145: runtime scheduling)
  /** Enable background polling of mm_outbox. Default false (batch API only); set true for server. */
  mmOutboxWorkerEnabled: process.env.MM_OUTBOX_WORKER_ENABLED === 'true',
  /** Poll interval in ms. Min 2000, max 300000. Default 5000 for faster materialization. */
  mmOutboxPollIntervalMs: Math.max(
    2000,
    Math.min(300000, parseInt(process.env.MM_OUTBOX_POLL_INTERVAL_MS || '5000', 10))
  ),
  /** Max events to process per worker poll cycle. */
  mmOutboxBatchSize: Math.max(1, Math.min(20, parseInt(process.env.MM_OUTBOX_BATCH_SIZE || '5', 10))),
  /** Lease window in seconds; after this processing row is eligible for reclaim. Default 300 (5 min). */
  mmOutboxLeaseWindowSec: Math.max(60, Math.min(3600, parseInt(process.env.MM_OUTBOX_LEASE_WINDOW_SEC || '300', 10))),
  /** Stale processing threshold: rows processing longer than this (sec) are reset to pending. Default 1800 (30 min). */
  mmOutboxStaleProcessingThresholdSec: Math.max(300, Math.min(7200, parseInt(process.env.MM_OUTBOX_STALE_PROCESSING_THRESHOLD_SEC || '1800', 10))),
  /** Max attempts per row before marking failed. */
  mmOutboxMaxAttempts: Math.max(1, Math.min(10, parseInt(process.env.MM_OUTBOX_MAX_ATTEMPTS || '3', 10))),
  /** LLM model for memory fact extraction (cheap, fast). */
  mmExtractionModelId: process.env.MM_EXTRACTION_MODEL_ID || 'anthropic/claude-3-5-haiku',
  /** Max facts to extract per event. */
  mmMaxFactsPerEvent: Math.max(1, Math.min(10, parseInt(process.env.MM_MAX_FACTS_PER_EVENT || '5', 10))),
  /** Max chars to embed per memory fact. Embedding is bounded. */
  mmEmbeddingMaxChars: Math.max(100, Math.min(2000, parseInt(process.env.MM_EMBEDDING_MAX_CHARS || '500', 10))),
  /** Timeout for MM extraction LLM call (ms). */
  mmExtractionTimeoutMs: Math.max(3000, Math.min(20000, parseInt(process.env.MM_EXTRACTION_TIMEOUT_MS || '8000', 10))),

  // MM Offload (DEV RUN v11): Supabase minimal — heavy content in R2
  /** Enable R2 offload for memory items when content exceeds threshold. Default: false (tests). */
  mmOffloadEnabled: process.env.MM_OFFLOAD_ENABLED === 'true',
  /** Content length (chars) above which to offload to R2. Min 10 for dev proof; prod typically 800–1000. */
  mmOffloadThresholdChars: Math.max(10, Math.min(5000, parseInt(process.env.MM_OFFLOAD_THRESHOLD_CHARS || '1000', 10))),
  /** Preview length (chars) stored in Supabase when offloaded. */
  mmOffloadPreviewChars: Math.max(50, Math.min(500, parseInt(process.env.MM_OFFLOAD_PREVIEW_CHARS || '200', 10))),
  /** Max length (chars) per extracted fact text. Enforced before store. */
  mmMaxFactTextChars: Math.max(100, Math.min(2000, parseInt(process.env.MM_MAX_FACT_TEXT_CHARS || '500', 10))),

  // MM Docs foundation: separate user-document storage + retrieval (chat/project/global scopes)
  mmDocsEnabled: process.env.MM_DOCS_ENABLED !== 'false',
  /** Raw/canonical document artifacts live in the legal-agent bucket under tenant/{tenant}/mm/docs/user/{user}/... */
  mmDocsBucket: process.env.MM_DOCS_BUCKET || process.env.R2_MM_DOCS_BUCKET || process.env.R2_RUNS_BUCKET || 'lexery-legal-agent',
  /** Hard cap on raw upload bytes processed by MM Docs ingest. */
  mmDocsRawMaxBytes: Math.max(16_384, Math.min(50_000_000, parseInt(process.env.MM_DOCS_RAW_MAX_BYTES || '12000000', 10))),
  /** Max chars per semantic chunk. */
  mmDocsChunkMaxChars: Math.max(300, Math.min(4000, parseInt(process.env.MM_DOCS_CHUNK_MAX_CHARS || '1400', 10))),
  /** Overlap between adjacent chunks. */
  mmDocsChunkOverlapChars: Math.max(0, Math.min(800, parseInt(process.env.MM_DOCS_CHUNK_OVERLAP_CHARS || '180', 10))),
  /** Query-time topK for MM Docs retrieval. */
  mmDocsTopK: Math.max(1, Math.min(20, parseInt(process.env.MM_DOCS_TOP_K || '8', 10))),
  /** Qdrant timeout for MM Docs semantic retrieval. Slightly above memory-cluster jitter to avoid false aborts. */
  mmDocsQdrantTimeoutMs: Math.max(500, Math.min(12000, parseInt(process.env.MM_DOCS_QDRANT_TIMEOUT_MS || '6000', 10))),
  /** Legacy flag retained for compatibility; shared Lexery-LA cluster is now an accepted production topology. */
  mmDocsQdrantUseMemoryFallback: process.env.MM_DOCS_QDRANT_USE_MEMORY_FALLBACK === 'true',
  /** MM Docs Qdrant endpoint. Defaults to the shared Lexery-LA cluster when no docs-specific endpoint is set. */
  mmDocsQdrantUrl: (() => {
    const canonical =
      process.env.MM_DOCS_QDRANT_URL ||
      process.env.QDRANT_DOCS_URL ||
      process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA_DOCS ||
      process.env.qdrant_clusterENDPOINT_LEXERY_LA_DOCS ||
      process.env.Qdrant_clusterENDPOINT_LEXERY_LA_DOCS ||
      '';
    if (canonical) return canonical;
    return (
      process.env.QDRANT_MEMORY_URL ||
      process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA ||
      process.env.qdrant_clusterENDPOINT_LEXERY_LA ||
      process.env.Qdrant_clusterENDPOINT_LEXERY_LA ||
      ''
    );
  })(),
  mmDocsQdrantApiKey: (() => {
    const canonical =
      process.env.MM_DOCS_QDRANT_API_KEY ||
      process.env.QDRANT_DOCS_API_KEY ||
      process.env.QDRANT_CLUSTER_API_KEY_LEXERY_LA_DOCS ||
      process.env.qdrant_clusterAPI_LEXERY_LA_DOCS ||
      process.env.Qdrant_clusterAPI_LEXERY_LA_DOCS ||
      '';
    if (canonical) return canonical;
    return (
      process.env.QDRANT_MEMORY_API_KEY ||
      process.env.QDRANT_CLUSTER_API_KEY_LEXERY_LA ||
      process.env.qdrant_clusterAPI_LEXERY_LA ||
      process.env.Qdrant_clusterAPI_LEXERY_LA ||
      ''
    );
  })(),
  mmDocsQdrantCollection: process.env.MM_DOCS_QDRANT_COLLECTION || 'lexery_mm_docs_chunks_v1',
  /** Test-only cheaper model override for heavy MM Docs verification. */
  mmDocsTestModelId: process.env.MM_DOCS_TEST_MODEL_ID || 'openai/gpt-4o-mini',
  /** Vision parsing for direct image uploads. Cheap multimodal extraction; used only for image formats. */
  mmDocsVisionEnabled: process.env.MM_DOCS_VISION_ENABLED !== 'false',
  mmDocsVisionModelId: process.env.MM_DOCS_VISION_MODEL_ID || 'openai/gpt-4o-mini',
  mmDocsVisionTimeoutSec: Math.max(5, Math.min(45, parseInt(process.env.MM_DOCS_VISION_TIMEOUT_SEC || '18', 10))),
  mmDocsVisionMaxTokens: Math.max(128, Math.min(2048, parseInt(process.env.MM_DOCS_VISION_MAX_TOKENS || '700', 10))),
  mmDocsVisionMaxImageBytes: Math.max(16_384, Math.min(12_000_000, parseInt(process.env.MM_DOCS_VISION_MAX_IMAGE_BYTES || '6000000', 10))),
  /** Best-effort OCR fallback for scanned/image-only PDFs. Runs only when pdftotext yields no blocks. */
  mmDocsPdfVisionOcrEnabled: process.env.MM_DOCS_PDF_VISION_OCR_ENABLED !== 'false',
  /** Limit scanned-PDF OCR cost by processing only a small page prefix. */
  mmDocsPdfVisionMaxPages: Math.max(1, Math.min(3, parseInt(process.env.MM_DOCS_PDF_VISION_MAX_PAGES || '2', 10))),
  /** Keep MM Docs ingest log bounded so Supabase row volume does not grow forever. */
  mmDocsIngestLogRetentionDays: Math.max(1, Math.min(180, parseInt(process.env.MM_DOCS_INGEST_LOG_RETENTION_DAYS || '21', 10))),
  /** Soft cap for mm_doc_ingest_log row count. Oldest rows are pruned opportunistically after inserts. */
  mmDocsIngestLogMaxRows: Math.max(500, Math.min(200_000, parseInt(process.env.MM_DOCS_INGEST_LOG_MAX_ROWS || '5000', 10))),
  /** Maximum rows to delete in one bounded ingest-log prune cycle. */
  mmDocsIngestLogPruneBatch: Math.max(25, Math.min(5_000, parseInt(process.env.MM_DOCS_INGEST_LOG_PRUNE_BATCH || '250', 10))),
  /** Cooldown for ingest-log pruning so normal writes do not pay repeated cleanup cost. */
  mmDocsIngestLogPruneCooldownMs: Math.max(60_000, Math.min(86_400_000, parseInt(process.env.MM_DOCS_INGEST_LOG_PRUNE_COOLDOWN_MS || '900000', 10))),

  // U9 Metadata Pre-Triage (DEV RUN v16; v17: GPT-5 nano + JSON hardening)
  /** Enable LLM metadata pre-triage in U9: selects relevant hits from ALL retrieved (not just top-N). Default true. */
  u9MetaTriageEnabled: process.env.U9_META_TRIAGE_ENABLED !== 'false',
  /** Min raw hits count to trigger U9 meta-triage. */
  u9MetaTriageThreshold: Math.max(5, Math.min(50, parseInt(process.env.U9_META_TRIAGE_THRESHOLD || '25', 10))),
  /** Max hits to select via meta-triage (will be merged with top-by-score). */
  u9MetaTriageMaxSelect: Math.max(5, Math.min(40, parseInt(process.env.U9_META_TRIAGE_MAX_SELECT || '20', 10))),
  /** Model for U9 meta-triage (default: gpt-4o-mini for stable structured JSON). */
  // Primary: fast nano model (low latency for the simple integer-array selection task).
  // Fallback: gpt-4o-mini (higher quality if nano returns invalid JSON or empty output).
  u9MetaTriageModelId: process.env.U9_META_TRIAGE_MODEL_ID || 'openai/gpt-5-nano',
  /** Fallback model when primary returns EMPTY_OUTPUT_LENGTH/INVALID_RESPONSE or parse fail. */
  u9MetaTriageFallbackModelId: process.env.U9_META_TRIAGE_FALLBACK_MODEL_ID || 'openai/gpt-4o-mini',
  // Tightened from 12s→8s: slow nano stalls should fall through to fallback model instead of spending
  // a full long-tail budget on metadata selection.
  u9MetaTriageTimeoutSec: Math.max(5, Math.min(30, parseInt(process.env.U9_META_TRIAGE_TIMEOUT_SEC || '8', 10))),
  /**
   * Primary budget increased from 384 to 512.
   * Live U9 traces repeatedly show EMPTY_OUTPUT_LENGTH on the first nano attempt at 384
   * followed by a successful higher-budget retry, which adds tail latency without helping cost.
   */
  u9MetaTriageMaxTokens: Math.max(256, Math.min(1024, parseInt(process.env.U9_META_TRIAGE_MAX_TOKENS || '512', 10))),
  /** Match the completion-token default to the primary budget to avoid empty-first-attempt retries. */
  u9MetaTriageMaxCompletionTokens: Math.max(256, Math.min(1024, parseInt(process.env.U9_META_TRIAGE_MAX_COMPLETION_TOKENS || process.env.U9_META_TRIAGE_MAX_TOKENS || '512', 10))),
  /** Retry budget stays modestly higher than primary to preserve recovery without a large cost jump. */
  u9MetaTriageRetryMaxTokens: Math.max(512, Math.min(2048, parseInt(process.env.U9_META_TRIAGE_RETRY_MAX_TOKENS || '640', 10))),
  /** Retry completion token budget; slightly above primary for truncation recovery. */
  u9MetaTriageRetryMaxCompletionTokens: Math.max(512, Math.min(2048, parseInt(process.env.U9_META_TRIAGE_RETRY_MAX_COMPLETION_TOKENS || process.env.U9_META_TRIAGE_RETRY_MAX_TOKENS || '640', 10))),
  /** Retries for meta-triage on invalid JSON (0 or 1). */
  u9MetaTriageRetries: process.env.U9_META_TRIAGE_RETRIES === '0' ? 0 : 1,

  // Evidence Triage (DEV RUN v10; v16: default ON; v17: GPT-5 nano)
  /** Enable two-stage evidence triage in U10. Default true; set EVIDENCE_TRIAGE_ENABLED=false to disable. */
  evidenceTriageEnabled: process.env.EVIDENCE_TRIAGE_ENABLED !== 'false',
  /** Min law snippet count to trigger triage (below threshold → skip triage). */
  evidenceTriageThreshold: Math.max(2, Math.min(20, parseInt(process.env.EVIDENCE_TRIAGE_THRESHOLD || '8', 10))),
  /** Primary model for evidence triage (default: gpt-4o-mini for stable structured JSON). */
  evidenceTriageModelId: process.env.EVIDENCE_TRIAGE_MODEL_ID || 'openai/gpt-4o-mini',
  /** Fallback model when primary returns empty/invalid or parse fail. */
  evidenceTriageFallbackModelId: process.env.EVIDENCE_TRIAGE_FALLBACK_MODEL_ID || 'openai/gpt-5-nano',
  /** Max tokens for triage response (first attempt); env-controlled (384/512 default). */
  evidenceTriageMaxTokens: Math.max(128, Math.min(1024, parseInt(process.env.EVIDENCE_TRIAGE_MAX_TOKENS || '384', 10))),
  /** Max completion tokens for evidence triage; fallback to max_tokens. */
  evidenceTriageMaxCompletionTokens: Math.max(128, Math.min(1024, parseInt(process.env.EVIDENCE_TRIAGE_MAX_COMPLETION_TOKENS || process.env.EVIDENCE_TRIAGE_MAX_TOKENS || '384', 10))),
  /** Retry attempt (same or fallback model) gets higher cap to avoid length cutoff. */
  evidenceTriageRetryMaxTokens: Math.max(256, Math.min(1024, parseInt(process.env.EVIDENCE_TRIAGE_RETRY_MAX_TOKENS || '512', 10))),
  /** Retry completion token budget for evidence triage; env-controlled. */
  evidenceTriageRetryMaxCompletionTokens: Math.max(256, Math.min(1024, parseInt(process.env.EVIDENCE_TRIAGE_RETRY_MAX_COMPLETION_TOKENS || process.env.EVIDENCE_TRIAGE_RETRY_MAX_TOKENS || '512', 10))),
  /** Excerpt length (chars) shown to triage model per snippet. */
  evidenceTriageExcerptChars: Math.max(50, Math.min(500, parseInt(process.env.EVIDENCE_TRIAGE_EXCERPT_CHARS || '200', 10))),
  /** Min law snippets to keep after triage; top-up by score if LLM selects fewer (DEV RUN v16). */
  evidenceTriageMinSelected: Math.max(2, Math.min(12, parseInt(process.env.EVIDENCE_TRIAGE_MIN_SELECTED || '6', 10))),
  /** Max law snippets to select; configurable bounds (Phase 3). */
  evidenceTriageMaxSelected: Math.max(4, Math.min(16, parseInt(process.env.EVIDENCE_TRIAGE_MAX_SELECTED || '8', 10))),
  /** Soft min: above this no top-up when parse_ok (anti-noise). */
  evidenceTriageSoftMin: Math.max(2, Math.min(8, parseInt(process.env.EVIDENCE_TRIAGE_SOFT_MIN || '3', 10))),
  /** Hard min: top-up only when selected < hardMin when parse_ok. */
  evidenceTriageHardMin: Math.max(1, Math.min(4, parseInt(process.env.EVIDENCE_TRIAGE_HARD_MIN || '2', 10))),
} as const;

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}

export { getOpenRouterKeyFromEnv };
