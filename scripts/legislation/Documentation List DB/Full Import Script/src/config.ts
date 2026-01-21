import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { isNonEmptyString, parsePositiveInt, parseOptionalPositiveInt } from './utils.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface ImporterPaths {
  projectRoot: string;
  tmpDir: string;
  docZipPath: string;
  docTxtPath: string;
  statePath: string;
  errorsPath: string;
  insertedIdsPath: string;
  reportPath: string;
}

export interface EnvConfig {
  qdrantApi?: string; // can be URL (preferred) or legacy key-like value
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection?: string;
  qdrantTimeoutMs?: number;

  openRouterApiKey?: string;

  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
}

export interface DefaultConfig {
  sourceUrl: string;
  defaultIndexName: string;
  defaultExpectedIndexDimensions: number;

  defaultBatchSize: number;
  defaultHeartbeatSeconds: number;
  defaultEmbeddingModel: string;
  defaultOpenRouterTimeoutMs: number;
  defaultHttpTimeoutMs: number;
  defaultQdrantTimeoutMs: number;
  defaultMaxRetries: number;
  defaultBackoffBaseMs: number;
  defaultBackoffMaxMs: number;

  defaultLogLevel: LogLevel;
}

export interface CliCommonOptions {
  indexName: string;
  expectedIndexDimensions: number;
  batchSize: number;
  timeLimitSeconds?: number;
  pauseAfterBatches?: number;
  maxRecords?: number;
  skipSupabaseSync: boolean;
  openrouterModel: string;
  openrouterDimensions?: number;
  logLevel: LogLevel;
  logPretty: boolean;
}

export function getProjectRoot(): string {
  // In both src/ and dist/ this resolves to the package root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function findUp(startDir: string, filename: string, maxDepth: number = 8): string | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadEnv(): void {
  // Prefer the repo-root .env if found.
  const cwdEnv = findUp(process.cwd(), '.env');
  const localEnv = findUp(getProjectRoot(), '.env');
  const envPath = cwdEnv || localEnv;
  if (envPath) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

export function getPaths(): ImporterPaths {
  const projectRoot = getProjectRoot();
  const tmpDir = path.join(projectRoot, 'tmp');
  return {
    projectRoot,
    tmpDir,
    docZipPath: path.join(tmpDir, 'doc.zip'),
    docTxtPath: path.join(tmpDir, 'doc.txt'),
    statePath: path.join(tmpDir, 'state.json'),
    errorsPath: path.join(tmpDir, 'errors.jsonl'),
    insertedIdsPath: path.join(tmpDir, 'inserted_ids.jsonl'),
    reportPath: path.join(tmpDir, 'report.json'),
  };
}

export function getEnv(): EnvConfig {
  return {
    qdrantApi: process.env.QDRANT_API || process.env.qdrantApi,
    qdrantUrl: process.env.QDRANT_URL || process.env.qdrantUrl,
    qdrantApiKey: process.env.QDRANT_API_KEY || process.env.qdrantApiKey,
    qdrantCollection: process.env.QDRANT_COLLECTION || process.env.qdrantCollection,
    qdrantTimeoutMs: parseOptionalPositiveInt(process.env.QDRANT_TIMEOUT_MS || process.env.qdrantTimeoutMs),
    openRouterApiKey: process.env.OPEN_ROUTER_API_RAG,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

export function getDefaults(): DefaultConfig {
  const defaultLogLevel = ((): LogLevel => {
    const v = process.env.LOG_LEVEL;
    if (!isNonEmptyString(v)) return 'info';
    const lv = v.toLowerCase() as LogLevel;
    return lv;
  })();

  return {
    sourceUrl: 'https://data.rada.gov.ua/ogd/zak/laws/data/csv/doc.zip',
    defaultIndexName: process.env.QDRANT_COLLECTION || process.env.qdrantCollection || 'legislation-catalog-index',
    defaultExpectedIndexDimensions: 768,

    defaultBatchSize: parsePositiveInt(process.env.BATCH_SIZE, 200),
    defaultHeartbeatSeconds: parsePositiveInt(process.env.HEARTBEAT_SECONDS, 8),
    defaultEmbeddingModel: process.env.OPENROUTER_EMBEDDING_MODEL || 'text-embedding-3-small',

    defaultOpenRouterTimeoutMs: parsePositiveInt(process.env.OPENROUTER_TIMEOUT_MS, 60_000),
    defaultHttpTimeoutMs: parsePositiveInt(process.env.HTTP_TIMEOUT_MS, 60_000),
    defaultQdrantTimeoutMs: parsePositiveInt(process.env.QDRANT_TIMEOUT_MS, 60_000),
    defaultMaxRetries: parsePositiveInt(process.env.MAX_RETRIES, 5),
    defaultBackoffBaseMs: parsePositiveInt(process.env.BACKOFF_BASE_MS, 750),
    defaultBackoffMaxMs: parsePositiveInt(process.env.BACKOFF_MAX_MS, 20_000),

    defaultLogLevel,
  };
}

export function validateCliOptions(o: CliCommonOptions): void {
  if (!Number.isFinite(o.batchSize) || o.batchSize <= 0) {
    throw new Error(`Invalid --batch-size: ${o.batchSize}`);
  }
  if (!Number.isFinite(o.expectedIndexDimensions) || o.expectedIndexDimensions <= 0) {
    throw new Error(`Invalid --expected-index-dimensions: ${o.expectedIndexDimensions}`);
  }
  if (o.timeLimitSeconds !== undefined && (!Number.isFinite(o.timeLimitSeconds) || o.timeLimitSeconds <= 0)) {
    throw new Error(`Invalid --time-limit: ${o.timeLimitSeconds}`);
  }
  if (o.pauseAfterBatches !== undefined && (!Number.isFinite(o.pauseAfterBatches) || o.pauseAfterBatches <= 0)) {
    throw new Error(`Invalid --pause-after-batches: ${o.pauseAfterBatches}`);
  }
  if (o.maxRecords !== undefined && (!Number.isFinite(o.maxRecords) || o.maxRecords <= 0)) {
    throw new Error(`Invalid --max-records: ${o.maxRecords}`);
  }
  if (!isNonEmptyString(o.indexName)) {
    throw new Error(`Invalid --index-name: ${o.indexName}`);
  }
  if (!isNonEmptyString(o.openrouterModel)) {
    throw new Error(`Invalid --openrouter-model: ${o.openrouterModel}`);
  }
  if (o.openrouterDimensions !== undefined && (!Number.isFinite(o.openrouterDimensions) || o.openrouterDimensions <= 0)) {
    throw new Error(`Invalid --openrouter-dimensions: ${o.openrouterDimensions}`);
  }
}

export function parseCliCommonOptions(input: {
  indexName?: string;
  expectedIndexDimensions?: string | number;
  batchSize?: string | number;
  timeLimit?: string | number;
  pauseAfterBatches?: string | number;
  maxRecords?: string | number;
  skipSupabaseSync?: boolean;
  openrouterModel?: string;
  openrouterDimensions?: string | number;
  logLevel?: string;
  logPretty?: boolean;
}): CliCommonOptions {
  const d = getDefaults();
  const logLevel = ((): LogLevel => {
    const v = input.logLevel ?? d.defaultLogLevel;
    const s = typeof v === 'string' ? v : String(v);
    return (s.toLowerCase() as LogLevel) || 'info';
  })();

  const options: CliCommonOptions = {
    indexName: input.indexName || d.defaultIndexName,
    expectedIndexDimensions: parsePositiveInt(input.expectedIndexDimensions, d.defaultExpectedIndexDimensions),
    batchSize: parsePositiveInt(input.batchSize, d.defaultBatchSize),
    timeLimitSeconds: parseOptionalPositiveInt(input.timeLimit),
    pauseAfterBatches: parseOptionalPositiveInt(input.pauseAfterBatches),
    maxRecords: parseOptionalPositiveInt(input.maxRecords),
    skipSupabaseSync: Boolean(input.skipSupabaseSync),
    openrouterModel: input.openrouterModel || d.defaultEmbeddingModel,
    // Default to the index dimensions to avoid silent mismatch.
    // If the provider/model doesn't support this, we'll fail fast with a clear error.
    openrouterDimensions:
      parseOptionalPositiveInt(input.openrouterDimensions) ??
      parsePositiveInt(input.expectedIndexDimensions, d.defaultExpectedIndexDimensions),
    logLevel,
    logPretty: Boolean(input.logPretty),
  };

  validateCliOptions(options);
  return options;
}

