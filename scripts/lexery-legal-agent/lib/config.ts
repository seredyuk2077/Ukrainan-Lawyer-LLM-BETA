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

  // R2 (for attachments overflow)
  r2Endpoint: process.env.R2_ENDPOINT || '',
  r2AccessKey: process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY || '',
  r2SecretKey: process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY || '',
  r2BucketRuns: process.env.R2_RUNS_BUCKET || process.env.R2_BUCKET_RUNS || 'lexery-legal-agent',
  r2BucketLegislation: process.env.R2_LEGISLATION_BUCKET || 'legislation',
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
} as const;

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}
