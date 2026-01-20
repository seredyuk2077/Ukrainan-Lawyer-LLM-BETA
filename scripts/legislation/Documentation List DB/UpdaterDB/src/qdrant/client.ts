import { QdrantClient } from '@qdrant/js-client-rest';
import type { Logger } from 'pino';
import { backoffDelayMs, safeJson, sleep, truncate } from '../utils.js';
import type { EnvConfig } from '../config.js';

export interface QdrantClientConfig {
  collectionName: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface RetrievedPoint {
  id: string | number;
  payload: Record<string, unknown> | null;
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

function safeString(v: unknown): string {
  if (typeof v === 'string') return v;
  return safeJson(v);
}

function toHttpError(e: unknown): unknown {
  if (e instanceof HttpError) return e;
  const anyE: any = e as any;
  const status =
    typeof anyE?.status === 'number'
      ? anyE.status
      : typeof anyE?.response?.status === 'number'
        ? anyE.response.status
        : typeof anyE?.$metadata?.httpStatusCode === 'number'
          ? anyE.$metadata.httpStatusCode
          : undefined;
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

function toQdrantFilter(filter: Record<string, unknown>): any {
  // Minimal mapping:
  // { dokid: 123 } -> { must: [{ key: 'dokid', match: { value: 123 } }] }
  if ((filter as any)?.must || (filter as any)?.should || (filter as any)?.must_not) return filter;
  const must: any[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    must.push({ key, match: { value } });
  }
  return { must };
}

function normalizeRetrieveResponse(res: any): RetrievedPoint[] {
  const arr = Array.isArray(res) ? res : Array.isArray(res?.result) ? res.result : Array.isArray(res?.points) ? res.points : null;
  if (!arr) return [];
  return arr
    .map((p: any) => ({
      id: (p?.id ?? '') as any,
      payload: (p?.payload ?? null) as any,
    }))
    .filter((p: any) => p.id !== '');
}

function normalizeScrollResponse(res: any): RetrievedPoint[] {
  const arr = Array.isArray(res?.points) ? res.points : Array.isArray(res?.result?.points) ? res.result.points : null;
  if (!arr) return [];
  return arr
    .map((p: any) => ({
      id: (p?.id ?? '') as any,
      payload: (p?.payload ?? null) as any,
    }))
    .filter((p: any) => p.id !== '');
}

export class QdrantDocListClient {
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

  async retrieveById(id: string | number): Promise<RetrievedPoint | null> {
    if (!this.client) throw new Error('Qdrant client not initialized');
    try {
      const res = await this.requestWithRetries('retrieve', async () => {
        if (!this.client) throw new Error('Qdrant client not initialized');
        // The JS client returns a variety of shapes between versions; normalize defensively.
        return await (this.client as any).retrieve(this.cfg.collectionName, {
          ids: [id],
          with_payload: true,
          with_vector: false,
        });
      });
      const pts = normalizeRetrieveResponse(res);
      return pts[0] || null;
    } catch (e: any) {
      const err = toHttpError(e);
      // Some versions throw 404 for missing ids, others return empty. Treat 404 as "not found".
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async findOneByFilter(filter: Record<string, unknown>): Promise<RetrievedPoint | null> {
    if (!this.client) throw new Error('Qdrant client not initialized');
    const qFilter = toQdrantFilter(filter);
    const res = await this.requestWithRetries('scroll', async () => {
      if (!this.client) throw new Error('Qdrant client not initialized');
      return await (this.client as any).scroll(this.cfg.collectionName, {
        limit: 1,
        with_payload: true,
        with_vector: false,
        filter: qFilter,
      });
    });
    const pts = normalizeScrollResponse(res);
    return pts[0] || null;
  }

  async upsertPoints(points: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }>): Promise<void> {
    if (!this.client) throw new Error('Qdrant client not initialized');
    if (points.length === 0) return;
    await this.requestWithRetries('upsert', async () => {
      if (!this.client) throw new Error('Qdrant client not initialized');
      return await this.client.upsert(this.cfg.collectionName, { wait: true, points } as any);
    });
  }

  async deleteByIds(ids: Array<string | number>): Promise<void> {
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
          this.logger.error({ op, attempt, err: toErrorFields(err) }, 'qdrant request failed');
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

export function getQdrantConnectionFromEnv(env: EnvConfig): { baseUrl: string; apiKey?: string } {
  // Re-export (helper kept here for portability of this folder).
  let rawApi = (env.qdrantApi || '').trim();
  const rawUrl = (env.qdrantUrl || '').trim();
  let rawKey = (env.qdrantApiKey || '').trim();

  const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v);

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

