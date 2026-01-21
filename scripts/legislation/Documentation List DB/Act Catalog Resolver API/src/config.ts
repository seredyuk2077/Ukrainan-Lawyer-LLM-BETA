export interface Env {
  // Qdrant
  QDRANT_URL?: string;
  QDRANT_API?: string;
  QDRANT_API_KEY?: string;
  QDRANT_COLLECTION?: string;
  QDRANT_TIMEOUT_MS?: string;
  qdrantUrl?: string;
  qdrantApi?: string;
  qdrantApiKey?: string;
  qdrantCollection?: string;
  qdrantTimeoutMs?: string;

  // Embeddings (OpenRouter-compatible)
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  EMBEDDING_ENDPOINT?: string;
  EMBEDDING_TIMEOUT_MS?: string;
  OPEN_ROUTER_API_RAG?: string;
  OPEN_ROUTER_API_KEY?: string;
  OPENROUTER_EMBEDDING_MODEL?: string;
  OPENROUTER_EMBEDDING_ENDPOINT?: string;
  OPENROUTER_TIMEOUT_MS?: string;

  // Optional rerank (OpenRouter chat)
  RERANK_ENABLED?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  OPEN_ROUTER_BASE_URL?: string;
  RERANK_MODEL?: string;
  RERANK_TIMEOUT_MS?: string;

  // Optional cache (R2 S3 API)
  CACHE_ENABLED?: string;
  R2_ENDPOINT?: string;
  R2_REGION?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_PREFIX?: string;
  r2Endpoint?: string;
  r2Region?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Bucket?: string;
  r2Prefix?: string;
  R2_ACCESS_KEY?: string;
  R2_SECRET_KEY?: string;
  R2_BUCKET_NAME?: string;
}

export interface AppConfig {
  qdrant: {
    baseUrl: string;
    apiKey?: string;
    collection: string;
    timeoutMs: number;
  };
  embedding: {
    apiKey: string;
    model: string;
    dimensions: number;
    endpoint: string;
    timeoutMs: number;
  };
  rerank: {
    enabled: boolean;
    apiKey?: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
  };
  cache: {
    enabled: boolean;
    r2?: {
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      prefix: string;
    };
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (!isNonEmptyString(v)) return fallback;
  const t = v.trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes' || t === 'y') return true;
  if (t === 'false' || t === '0' || t === 'no' || t === 'n') return false;
  return fallback;
}

function parsePositiveInt(v: unknown, fallback: number): number {
  if (!isNonEmptyString(v)) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function required(name: string, v: string | undefined): string {
  if (!isNonEmptyString(v)) throw new Error(`${name} is missing`);
  return v.trim();
}

function normalizeBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, '');
}

export function getConfig(env: Env): AppConfig {
  const rawQdrantUrl = (env.QDRANT_URL || env.qdrantUrl || '').trim();
  const rawQdrantApi = (env.QDRANT_API || env.qdrantApi || '').trim();
  const rawQdrantKey = (env.QDRANT_API_KEY || env.qdrantApiKey || '').trim();

  const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v);
  const qdrantBaseUrl = (() => {
    if (rawQdrantUrl && looksLikeUrl(rawQdrantUrl)) return rawQdrantUrl;
    if (rawQdrantApi && looksLikeUrl(rawQdrantApi)) return rawQdrantApi;
    throw new Error('Qdrant base URL missing. Set QDRANT_URL (preferred) or QDRANT_API (URL).');
  })();
  const qdrantApiKey = rawQdrantKey || (rawQdrantApi && !looksLikeUrl(rawQdrantApi) ? rawQdrantApi : '') || undefined;

  const qdrantCollection = String(env.QDRANT_COLLECTION || env.qdrantCollection || 'legislation-catalog-index').trim();

  const embeddingApiKey =
    (env.EMBEDDING_API_KEY || env.OPEN_ROUTER_API_RAG || env.OPEN_ROUTER_API_KEY || '').trim();
  if (!embeddingApiKey) throw new Error('Embedding API key missing. Set EMBEDDING_API_KEY or OPEN_ROUTER_API_RAG.');

  const embeddingModel = String(env.EMBEDDING_MODEL || env.OPENROUTER_EMBEDDING_MODEL || 'text-embedding-3-small').trim();
  const embeddingEndpoint = String(env.EMBEDDING_ENDPOINT || env.OPENROUTER_EMBEDDING_ENDPOINT || 'https://openrouter.ai/api/v1/embeddings').trim();
  const embeddingDims = parsePositiveInt(env.EMBEDDING_DIMENSIONS, 768);

  const rerankEnabled = parseBool(env.RERANK_ENABLED, false);
  const openrouterBaseUrl = (env.OPENROUTER_BASE_URL || env.OPEN_ROUTER_BASE_URL || 'https://openrouter.ai/api/v1')
    .trim()
    .replace(/\/+$/, '');
  const rerankModel = (env.RERANK_MODEL || 'openai/gpt-4o-mini').trim();

  const cacheEnabled = parseBool(env.CACHE_ENABLED, false);

  const cfg: AppConfig = {
    qdrant: {
      baseUrl: normalizeBaseUrl(qdrantBaseUrl),
      apiKey: qdrantApiKey,
      collection: qdrantCollection || 'legislation-catalog-index',
      timeoutMs: parsePositiveInt(env.QDRANT_TIMEOUT_MS || env.qdrantTimeoutMs, 15_000),
    },
    embedding: {
      apiKey: embeddingApiKey,
      model: embeddingModel,
      dimensions: embeddingDims,
      endpoint: embeddingEndpoint,
      timeoutMs: parsePositiveInt(env.EMBEDDING_TIMEOUT_MS || env.OPENROUTER_TIMEOUT_MS, 15_000),
    },
    rerank: {
      enabled: rerankEnabled,
      apiKey: isNonEmptyString(env.OPENROUTER_API_KEY)
        ? env.OPENROUTER_API_KEY.trim()
        : isNonEmptyString(env.OPEN_ROUTER_API_KEY)
          ? env.OPEN_ROUTER_API_KEY.trim()
          : isNonEmptyString(env.OPEN_ROUTER_API_RAG)
            ? env.OPEN_ROUTER_API_RAG.trim()
            : undefined,
      baseUrl: openrouterBaseUrl,
      model: rerankModel,
      timeoutMs: parsePositiveInt(env.RERANK_TIMEOUT_MS, 20_000),
    },
    cache: {
      enabled: cacheEnabled,
    },
  };

  // Guardrails
  if (!Number.isFinite(cfg.embedding.dimensions) || cfg.embedding.dimensions <= 0) {
    throw new Error(`EMBEDDING_DIMENSIONS invalid: ${String(env.EMBEDDING_DIMENSIONS)}`);
  }

  if (cfg.rerank.enabled && !cfg.rerank.apiKey) {
    throw new Error('RERANK_ENABLED=true but OPENROUTER_API_KEY is missing.');
  }

  if (cfg.cache.enabled) {
    const endpoint = required('R2_ENDPOINT', (env.R2_ENDPOINT || env.r2Endpoint) as any);
    const accessKeyId = required('R2_ACCESS_KEY_ID', (env.R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY || env.r2AccessKeyId) as any);
    const secretAccessKey = required(
      'R2_SECRET_ACCESS_KEY',
      (env.R2_SECRET_ACCESS_KEY || env.R2_SECRET_KEY || env.r2SecretAccessKey) as any
    );
    const bucket = required('R2_BUCKET', (env.R2_BUCKET || env.R2_BUCKET_NAME || env.r2Bucket) as any);
    const region = (env.R2_REGION || env.r2Region || 'auto').trim() || 'auto';
    const prefix = (env.R2_PREFIX || env.r2Prefix || 'legislation/ActCatalogResolver/cache/').trim().replace(/^\/+/, '');

    cfg.cache.r2 = {
      endpoint: endpoint.trim().replace(/\/+$/, ''),
      region,
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
      bucket: bucket.trim(),
      prefix,
    };
  }

  return cfg;
}

