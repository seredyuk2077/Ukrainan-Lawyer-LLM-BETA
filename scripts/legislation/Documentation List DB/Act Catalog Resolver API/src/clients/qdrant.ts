import type { DocCardPayload } from '../types';
import type { Logger } from '../util/logger';

export interface QdrantClientConfig {
  baseUrl: string;
  apiKey?: string;
  collection: string;
  timeoutMs: number;
}

export interface QdrantSearchHit {
  id: string | number;
  score: number;
  payload: DocCardPayload | null;
}

export class QdrantClient {
  constructor(
    private readonly logger: Logger,
    private readonly cfg: QdrantClientConfig
  ) {}

  async search(params: { vector: number[]; limit: number; filter?: unknown }): Promise<QdrantSearchHit[]> {
    const url = `${this.cfg.baseUrl}/collections/${encodeURIComponent(this.cfg.collection)}/points/search`;
    const body = {
      vector: params.vector,
      limit: params.limit,
      with_payload: true,
      with_vector: false,
      ...(params.filter ? { filter: params.filter } : {}),
    };
    const json = await this.fetchJson(url, body);
    const arr = Array.isArray(json?.result) ? json.result : Array.isArray(json) ? json : [];
    return arr.map((r: any) => ({
      id: r?.id,
      score: typeof r?.score === 'number' ? r.score : 0,
      payload: (r?.payload ?? null) as DocCardPayload | null,
    }));
  }

  async scroll(params: { limit: number; filter?: unknown }): Promise<QdrantSearchHit[]> {
    const url = `${this.cfg.baseUrl}/collections/${encodeURIComponent(this.cfg.collection)}/points/scroll`;
    const body = {
      limit: params.limit,
      with_payload: true,
      with_vector: false,
      ...(params.filter ? { filter: params.filter } : {}),
    };
    const json = await this.fetchJson(url, body);
    const arr =
      Array.isArray(json?.result?.points) ? json.result.points : Array.isArray(json?.points) ? json.points : Array.isArray(json) ? json : [];
    return arr.map((p: any) => ({
      id: p?.id,
      score: 0,
      payload: (p?.payload ?? null) as DocCardPayload | null,
    }));
  }

  private async fetchJson(url: string, body: unknown): Promise<any> {
    const started = Date.now();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.apiKey ? { 'api-key': this.cfg.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text().catch(() => '');
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        this.logger.error(
          { status: res.status, url, body_preview: safeJsonPreview(body), resp_preview: text.slice(0, 800) },
          'qdrant request failed'
        );
        throw new Error(`Qdrant HTTP ${res.status}`);
      }
      this.logger.debug({ url, took_ms: Date.now() - started }, 'qdrant request ok');
      return json;
    } finally {
      clearTimeout(t);
    }
  }
}

function safeJsonPreview(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 600);
  } catch {
    return String(v).slice(0, 600);
  }
}

