import type { Logger } from '../util/logger';

export interface EmbeddingClientConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

export class EmbeddingClient {
  constructor(
    private readonly logger: Logger,
    private readonly cfg: EmbeddingClientConfig
  ) {}

  async embedQuery(text: string): Promise<number[]> {
    const vecs = await this.embedTexts([text]);
    if (vecs.length !== 1) throw new Error('Embedding response size mismatch');
    return vecs[0];
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const payload: any = { model: this.cfg.model, input: texts };
    if (this.cfg.dimensions) payload.dimensions = this.cfg.dimensions;

    const started = Date.now();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), this.cfg.timeoutMs);
    try {
      const res = await fetch(this.cfg.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'act-catalog-resolver-api',
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        const preview = safeJsonPreview(json);
        this.logger.error({ status: res.status, endpoint: safeUrl(this.cfg.endpoint), resp_preview: preview }, 'embeddings request failed');
        throw new Error(`Embeddings HTTP ${res.status}`);
      }
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error('Unexpected embeddings response shape');
      }
      const out: number[][] = [];
      for (const item of data) {
        const emb = item?.embedding;
        if (!Array.isArray(emb)) throw new Error('Unexpected embedding item shape');
        out.push(emb as number[]);
      }
      if (this.cfg.dimensions) {
        for (const v of out) {
          if (v.length !== this.cfg.dimensions) {
            throw new Error(`Embedding dimensions mismatch: got ${v.length}, expected ${this.cfg.dimensions}`);
          }
        }
      }
      this.logger.debug({ took_ms: Date.now() - started, n: texts.length }, 'embeddings ok');
      return out;
    } finally {
      clearTimeout(t);
    }
  }
}

function safeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid_url';
  }
}

function safeJsonPreview(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 900);
  } catch {
    return String(v).slice(0, 900);
  }
}

