import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { LogLevel } from './logger.js';
import { isNonEmptyString, parseOptionalPositiveInt, parsePositiveInt } from './utils.js';

export interface CliOptions {
  dryRun: boolean;
  backstop: boolean;
  selftest: boolean;
  maxDocs?: number;
  concurrency: number;
  radaDelayMinMs: number;
  radaDelayMaxMs: number;
  skipRetrieve: boolean;
  logLevel: LogLevel;
  logPretty: boolean;
}

export interface EnvConfig {
  qdrantApi?: string; // can be URL (preferred) or legacy key-like value
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection?: string;
  qdrantTimeoutMs?: number;

  embeddingApiKey?: string; // OpenRouter key by default
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingEndpoint?: string;
  embeddingTimeoutMs: number;

  r2Endpoint: string;
  r2Region: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  r2Prefix: string;
}

export interface Defaults {
  defaultQdrantCollection: string;
  defaultQdrantTimeoutMs: number;
  defaultEmbeddingModel: string;
  defaultEmbeddingDimensions: number;
  defaultEmbeddingTimeoutMs: number;
  defaultMaxRetries: number;
  defaultBackoffBaseMs: number;
  defaultBackoffMaxMs: number;
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

function findUpAll(startDir: string, filename: string, maxDepth: number = 12): string[] {
  const out: string[] = [];
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) out.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function loadEnv(): void {
  // Layer all `.env` files found while walking up from CWD.
  //
  // Requirements:
  // - Allow a local `UpdaterDB/.env` to override a repo-root `.env`.
  // - Never override real environment variables (GitHub Actions secrets).
  //
  // We implement this by:
  // - capturing the set of keys already present in process.env
  // - parsing env files from farthest -> nearest
  // - setting keys only if they were NOT present in the original process.env
  const originalKeys = new Set(Object.keys(process.env));
  const envFiles = findUpAll(process.cwd(), '.env').reverse(); // farthest -> nearest
  for (const p of envFiles) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = dotenv.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        if (originalKeys.has(k)) continue; // do not override external env (CI/secrets)
        process.env[k] = v;
      }
    } catch {
      // ignore
    }
  }
}

export function getDefaults(): Defaults {
  return {
    defaultQdrantCollection: process.env.QDRANT_COLLECTION || process.env.qdrantCollection || 'legislation-catalog-index',
    defaultQdrantTimeoutMs: parsePositiveInt(process.env.QDRANT_TIMEOUT_MS || process.env.qdrantTimeoutMs, 60_000),

    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || process.env.OPENROUTER_EMBEDDING_MODEL || 'text-embedding-3-small',
    defaultEmbeddingDimensions: parsePositiveInt(process.env.EMBEDDING_DIMENSIONS, 768),
    defaultEmbeddingTimeoutMs: parsePositiveInt(process.env.EMBEDDING_TIMEOUT_MS || process.env.OPENROUTER_TIMEOUT_MS, 60_000),

    defaultMaxRetries: parsePositiveInt(process.env.MAX_RETRIES, 5),
    defaultBackoffBaseMs: parsePositiveInt(process.env.BACKOFF_BASE_MS, 750),
    defaultBackoffMaxMs: parsePositiveInt(process.env.BACKOFF_MAX_MS, 20_000),
  };
}

export function getEnv(): EnvConfig {
  const d = getDefaults();

  const r2Bucket =
    process.env.R2_BUCKET ||
    process.env.r2Bucket ||
    'legislation';

  const normalizeR2Prefix = (p: string): string => {
    const t = String(p || '').trim().replace(/^\/+/, '');
    if (!t) return t;

    // IMPORTANT: keep compatibility with the previous (wrong) prefix variant we used:
    // - old: legislation/DocListDB/rada gov updater log/
    // - new (existing in your bucket): legislation/DocListDB rada gov updater log/
    const oldPrefix = 'legislation/DocListDB/rada gov updater log';
    const newPrefix = 'legislation/DocListDB rada gov updater log';
    if (t === oldPrefix || t.startsWith(oldPrefix + '/')) {
      return newPrefix + t.slice(oldPrefix.length);
    }
    return t;
  };

  const r2PrefixRaw =
    process.env.R2_PREFIX ||
    process.env.r2Prefix ||
    // Default to the existing prefix in the `legislation` bucket (with spaces).
    'legislation/DocListDB rada gov updater log/';
  const r2Prefix = normalizeR2Prefix(r2PrefixRaw);

  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY || process.env.r2AccessKeyId || '';
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY || process.env.r2SecretAccessKey || '';

  return {
    qdrantApi: process.env.QDRANT_API || process.env.qdrantApi,
    qdrantUrl: process.env.QDRANT_URL || process.env.qdrantUrl,
    qdrantApiKey: process.env.QDRANT_API_KEY || process.env.qdrantApiKey,
    qdrantCollection: process.env.QDRANT_COLLECTION || process.env.qdrantCollection || d.defaultQdrantCollection,
    qdrantTimeoutMs: parseOptionalPositiveInt(process.env.QDRANT_TIMEOUT_MS || process.env.qdrantTimeoutMs),

    embeddingApiKey: process.env.EMBEDDING_API_KEY || process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY,
    embeddingModel: d.defaultEmbeddingModel,
    embeddingDimensions: d.defaultEmbeddingDimensions,
    embeddingEndpoint: process.env.EMBEDDING_ENDPOINT || process.env.OPENROUTER_EMBEDDING_ENDPOINT,
    embeddingTimeoutMs: d.defaultEmbeddingTimeoutMs,

    r2Endpoint: (process.env.R2_ENDPOINT || process.env.r2Endpoint || '').trim(),
    r2Region: (process.env.R2_REGION || process.env.r2Region || 'auto').trim(),
    r2AccessKeyId: r2AccessKeyId.trim(),
    r2SecretAccessKey: r2SecretAccessKey.trim(),
    r2Bucket: r2Bucket.trim(),
    r2Prefix: r2Prefix.trim().replace(/^\/+/, ''),
  };
}

export function validateCliOptions(o: CliOptions): void {
  if (!Number.isFinite(o.concurrency) || o.concurrency <= 0) throw new Error(`Invalid --concurrency: ${o.concurrency}`);
  if (!Number.isFinite(o.radaDelayMinMs) || o.radaDelayMinMs < 0) throw new Error(`Invalid --rada-delay-min-ms: ${o.radaDelayMinMs}`);
  if (!Number.isFinite(o.radaDelayMaxMs) || o.radaDelayMaxMs < 0) throw new Error(`Invalid --rada-delay-max-ms: ${o.radaDelayMaxMs}`);
  if (o.maxDocs !== undefined && (!Number.isFinite(o.maxDocs) || o.maxDocs <= 0)) throw new Error(`Invalid --max-docs: ${o.maxDocs}`);
}

export function validateEnv(env: EnvConfig, cli: CliOptions): void {
  // R2 is required for state + lock + reports (per task).
  if (!isNonEmptyString(env.r2Endpoint)) throw new Error('R2_ENDPOINT is missing.');
  if (!isNonEmptyString(env.r2AccessKeyId)) throw new Error('R2_ACCESS_KEY_ID (or R2_ACCESS_KEY) is missing.');
  if (!isNonEmptyString(env.r2SecretAccessKey)) throw new Error('R2_SECRET_ACCESS_KEY (or R2_SECRET_KEY) is missing.');
  if (!isNonEmptyString(env.r2Bucket)) throw new Error('R2_BUCKET is missing.');
  if (!isNonEmptyString(env.r2Prefix)) throw new Error('R2_PREFIX is missing (or default prefix is empty).');

  // Qdrant is required unless the user explicitly skips retrieve AND does not run selftest.
  // (Dry-run still normally compares payloads, so Qdrant is expected.)
  const needsQdrant = !cli.skipRetrieve || cli.selftest || !cli.dryRun;
  if (needsQdrant) {
    const { baseUrl } = getQdrantConnectionFromEnv(env);
    if (!isNonEmptyString(baseUrl)) throw new Error('Qdrant base URL missing.');
    if (!isNonEmptyString(env.qdrantCollection)) throw new Error('QDRANT_COLLECTION is missing.');
  }

  // Embeddings only required for non-dry-run updates or selftest (selftest inserts a temp point).
  const needsEmbeddings = (!cli.dryRun && !cli.skipRetrieve) || (!cli.dryRun && true) || cli.selftest; // selftest needs vector too
  if (needsEmbeddings) {
    if (!isNonEmptyString(env.embeddingApiKey)) {
      throw new Error('Embedding API key missing. Set EMBEDDING_API_KEY or OPEN_ROUTER_API_RAG.');
    }
    if (!isNonEmptyString(env.embeddingModel)) {
      throw new Error('Embedding model missing. Set EMBEDDING_MODEL or OPENROUTER_EMBEDDING_MODEL.');
    }
    if (!Number.isFinite(env.embeddingDimensions) || env.embeddingDimensions <= 0) {
      throw new Error(`Invalid embedding dimensions: ${env.embeddingDimensions}`);
    }
  }
}

export function getQdrantConnectionFromEnv(env: EnvConfig): { baseUrl: string; apiKey?: string } {
  // Supported:
  // - QDRANT_URL + QDRANT_API_KEY
  // - OR QDRANT_API as base URL (legacy name)
  //
  // Defensive behavior:
  // - If QDRANT_API looks like a key (not a URL) and QDRANT_URL exists, treat QDRANT_API as API key.
  let rawApi = (env.qdrantApi || '').trim();
  const rawUrl = (env.qdrantUrl || '').trim();
  let rawKey = (env.qdrantApiKey || '').trim();

  const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v);

  // Some managed Qdrant envs provide API as "cluster_id|api_key"
  if (rawApi.includes('|') && !looksLikeUrl(rawApi)) {
    const parts = rawApi.split('|');
    if (parts.length >= 2) {
      if (!rawKey) rawKey = parts[1].trim();
      rawApi = '';
    }
  }

  if (rawUrl && looksLikeUrl(rawUrl)) {
    const apiKey = rawKey || (rawApi && !looksLikeUrl(rawApi) ? rawApi : '') || undefined;
    return { baseUrl: rawUrl.replace(/\/+$/, ''), apiKey };
  }

  if (rawApi && looksLikeUrl(rawApi)) {
    return { baseUrl: rawApi.replace(/\/+$/, ''), apiKey: rawKey || undefined };
  }

  if (rawApi && !looksLikeUrl(rawApi)) {
    throw new Error(
      'Qdrant base URL missing or invalid. It looks like QDRANT_API contains a key, not a URL.\n' +
        'Set QDRANT_URL (e.g. https://<host>:6333) and optionally QDRANT_API_KEY, or set QDRANT_API to a URL.'
    );
  }

  throw new Error('Qdrant base URL missing. Set QDRANT_URL or set QDRANT_API to a URL.');
}

