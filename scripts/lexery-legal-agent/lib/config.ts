/**
 * Lexery Legal Agent — Config
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../.env') });

export const config = {
  port: parseInt(process.env.BRAIN_PORT || '3081', 10),
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

  // OpenRouter for U2 Classify (CLF_*). Canonical key: OPENROUTER_API_KEY_ONLINE.
  openRouterApiKey:
    process.env.OPENROUTER_API_KEY_ONLINE ||
    process.env.OPENROUTER_API_KEY ||
    '',
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
  lldbiTopK: Math.max(1, Math.min(200, parseInt(process.env.LLDBI_TOP_K || '50', 10))),
  minScoreThreshold: Math.min(1, Math.max(0, parseFloat(process.env.MIN_SCORE_THRESHOLD || '0.1'))),
  u4QdrantConcurrency: Math.max(1, parseInt(process.env.U4_QDRANT_CONCURRENCY || '20', 10)),

  // U4 Embeddings (aligned with LLDBI index: 1536d, openai/text-embedding-3-small)
  lldbiEmbedModelId: process.env.LLDBI_EMBED_MODEL_ID || 'openai/text-embedding-3-small',
  lldbiEmbedTimeoutSec: Math.max(1, parseInt(process.env.LLDBI_EMBED_TIMEOUT_SEC || '5', 10)),
  openRouterApiKeyRag:
    process.env.OPEN_ROUTER_API_RAG ||
    process.env.OPENROUTER_API_KEY_ONLINE ||
    process.env.OPENROUTER_API_KEY ||
    '',

  // U5 Gate (LEX-118)
  gateMinHitsThreshold: Math.max(0, parseInt(process.env.GATE_MIN_HITS_THRESHOLD || '3', 10)),
  gateMinAvgScore: Math.min(1, Math.max(0, parseFloat(process.env.GATE_MIN_AVG_SCORE || '0.18'))),
  doclistEnabled: process.env.DOCLIST_ENABLED !== 'false',
  forceExpand: process.env.FORCE_EXPAND === 'true',
  gateDecisionVersion: Math.max(1, parseInt(process.env.GATE_DECISION_VERSION || '1', 10)),

  // U4 optional rerank (LLM): only when enabled; strict timeout; fallback to hybrid re-score
  u4RerankEnabled: process.env.U4_RERANK_ENABLED === 'true',
  u4RerankTimeoutSec: Math.max(1, Math.min(5, parseInt(process.env.U4_RERANK_TIMEOUT_SEC || '3', 10))),

  // U4 multi-goal evidence (evidence goals max; heuristic splitter cap)
  u4GoalsMax: Math.max(1, Math.min(5, parseInt(process.env.U4_GOALS_MAX || '3', 10))),
  /** Per-goal min hits in top N when coverage enforced (multi-goal fusion). */
  u4FusionTopN: Math.max(10, Math.min(50, parseInt(process.env.U4_FUSION_TOP_N || '30', 10))),
  u4FusionMinHitsPerGoal: Math.max(2, Math.min(15, parseInt(process.env.U4_FUSION_MIN_HITS_PER_GOAL || '5', 10))),

  // U4 Selective LLM Retrieval Planner (only when triggers; reuse OpenRouter + circuit)
  u4PlannerEnabled: process.env.U4_PLANNER_ENABLED === 'true',
  u4PlannerModelId: process.env.U4_PLANNER_MODEL_ID || process.env.CLF_MODEL_ID || 'anthropic/claude-sonnet-4',
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
  u4ActPlannerEnabled: process.env.U4_ACT_PLANNER_ENABLED === 'true',
  u4ActPlannerModel: process.env.U4_ACT_PLANNER_MODEL || process.env.CLF_MODEL_ID || 'openai/gpt-4o-mini',
  u4ActPlannerMaxTokensTier1: Math.max(220, Math.min(350, parseInt(process.env.U4_ACT_PLANNER_MAX_TOKENS_TIER1 || '280', 10))),
  u4ActPlannerMaxTokensTier2: Math.max(450, Math.min(700, parseInt(process.env.U4_ACT_PLANNER_MAX_TOKENS_TIER2 || '550', 10))),
  u4ActPlannerMaxCallsPerRun: Math.max(1, Math.min(2, parseInt(process.env.U4_ACT_PLANNER_MAX_CALLS_PER_RUN || '1', 10))),
  u4ActPlannerTimeoutSec: Math.max(3, Math.min(15, parseInt(process.env.U4_ACT_PLANNER_TIMEOUT_SEC || '10', 10))),

  // U4 Routing-hints LLM (Phase 6.1): budgeted, rare; only when evidence weak/conflict/coverage failed
  u4RoutingHintsEnabled: process.env.U4_ROUTING_HINTS_ENABLED === 'true',
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
} as const;

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}
