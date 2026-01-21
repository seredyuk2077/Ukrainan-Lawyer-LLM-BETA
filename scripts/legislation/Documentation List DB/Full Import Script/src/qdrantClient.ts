import { QdrantClient } from '@qdrant/js-client-rest';
import type { Logger } from 'pino';
import { backoffDelayMs, sleep } from './utils.js';
import type { EnvConfig } from './config.js';

export interface QdrantClientConfig {
  collectionName: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface QdrantQueryMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export class QdrantVectorDbClient {
  private client: QdrantClient | null = null;
  private vectorSize: number | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly cfg: QdrantClientConfig
  ) {}

  getIndexDimensions(): number | null {
    return this.vectorSize;
  }

  async initialize(): Promise<void> {
    this.client = new QdrantClient({
      url: this.cfg.baseUrl,
      apiKey: this.cfg.apiKey,
      timeout: this.cfg.timeoutMs,
      checkCompatibility: false,
    } as any);

    const info = await this.requestWithRetries('getCollection', async () => {
      if (!this.client) throw new Error('Qdrant client not initialized');
      return await this.client.getCollection(this.cfg.collectionName);
    });

    const size = (info as any)?.config?.params?.vectors?.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      throw new Error(`Could not determine Qdrant vector size for collection "${this.cfg.collectionName}"`);
    }
    this.vectorSize = size;
    this.logger.info({ collection: this.cfg.collectionName, dimensions: size }, 'qdrant client initialized');
  }

  async upsertPoints(points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>): Promise<void> {
    if (!this.client) throw new Error('Qdrant client not initialized');
    if (points.length === 0) return;
    await this.requestWithRetries('upsert', async () => {
      if (!this.client) throw new Error('Qdrant client not initialized');
      return await this.client.upsert(this.cfg.collectionName, { wait: true, points });
    });
  }

  async search(params: { vector: number[]; topK: number; filter?: Record<string, unknown> }): Promise<QdrantQueryMatch[]> {
    if (!this.client) throw new Error('Qdrant client not initialized');
    const filter = params.filter ? toQdrantFilter(params.filter) : undefined;
    const res = await this.requestWithRetries('search', async () => {
      if (!this.client) throw new Error('Qdrant client not initialized');
      return await this.client.search(this.cfg.collectionName, {
        vector: params.vector,
        limit: params.topK,
        filter,
        with_payload: true,
      } as any);
    });

    if (!Array.isArray(res)) {
      throw new Error(`Unexpected Qdrant search response shape: ${JSON.stringify(res)?.slice(0, 500)}`);
    }

    return res.map((r: any) => ({
      id: String(r.id),
      score: typeof r.score === 'number' ? r.score : 0,
      metadata: (r.payload || undefined) as any,
    }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (!this.client) throw new Error('Qdrant client not initialized');
    if (ids.length === 0) return;
    await this.requestWithRetries('delete', async () => {
      if (!this.client) throw new Error('Qdrant client not initialized');
      return await this.client.delete(this.cfg.collectionName, { wait: true, points: ids } as any);
    });
  }

  private async requestWithRetries<T>(op: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const err = toHttpError(e);
        const retryable = isRetryableError(err);

        if (!retryable || attempt === this.cfg.maxRetries) {
          // Avoid noisy logs during binary-splitting of batches; the caller will record details to tmp/errors.jsonl.
          throw err;
        }

        const delay = backoffDelayMs(attempt, this.cfg.backoffBaseMs, this.cfg.backoffMaxMs);
        this.logger.warn({ op, attempt, delayMs: delay, err: toErrorFields(err) }, 'qdrant request retry');
        await sleep(delay);
      }
    }
    throw new Error('unreachable');
  }
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryable: boolean,
    message?: string
  ) {
    super(message || `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

function toHttpError(e: unknown): unknown {
  if (e instanceof HttpError) return e;
  const anyE: any = e as any;
  const status = typeof anyE?.status === 'number' ? anyE.status : typeof anyE?.response?.status === 'number' ? anyE.response.status : undefined;
  const bodyLike =
    typeof anyE?.body === 'string'
      ? anyE.body
      : typeof anyE?.data === 'string'
        ? anyE.data
        : anyE?.data
          ? safeJson(anyE.data)
          : anyE?.response?.data
            ? safeJson(anyE.response.data)
            : undefined;

  if (typeof status === 'number') {
    const retryable = status === 429 || status >= 500;
    return new HttpError(status, bodyLike || '', retryable, anyE?.message ? String(anyE.message) : undefined);
  }
  return e;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isRetryableError(e: unknown): boolean {
  if (e instanceof HttpError) return e.retryable;
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ETIMEDOUT') || msg.toLowerCase().includes('timeout')) return true;
  if (msg.includes('ECONNRESET') || msg.includes('EAI_AGAIN') || msg.includes('fetch failed')) return true;
  return false;
}

function toErrorFields(e: any): { message: string; name?: string; stack?: string; status?: number; body?: string } {
  if (e instanceof HttpError) return { name: 'HttpError', message: e.message, status: e.status, body: truncate(e.body, 800) };
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { message: String(e) };
}

function truncate(v: string, max: number): string {
  if (!v) return '';
  if (v.length <= max) return v;
  return v.slice(0, max) + '…';
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

function toQdrantFilter(filter: Record<string, unknown>): any {
  // Minimal 1:1 mapping for the importer use-cases:
  // { nreg: "..." } / { is_test: true } / { test_run_id: "..." }
  // -> { must: [{ key, match: { value } }, ...] }
  if ((filter as any)?.must || (filter as any)?.should || (filter as any)?.must_not) return filter;
  const must: any[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    // Qdrant match supports string/bool/int
    must.push({ key, match: { value } });
  }
  return { must };
}

