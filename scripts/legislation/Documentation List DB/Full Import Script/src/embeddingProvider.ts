import type { Logger } from 'pino';
import { backoffDelayMs, safeUrl, sleep } from './utils.js';

export interface EmbeddingProviderConfig {
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  endpoint?: string;
}

export class OpenRouterEmbeddingProvider {
  private readonly endpoint: string;

  constructor(
    private readonly logger: Logger,
    private readonly cfg: EmbeddingProviderConfig
  ) {
    this.endpoint = cfg.endpoint || 'https://openrouter.ai/api/v1/embeddings';
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const payload: any = {
      model: this.cfg.model,
      input: texts,
    };
    if (this.cfg.dimensions) {
      payload.dimensions = this.cfg.dimensions;
    }

    const res = await this.requestWithRetries(payload, texts.length);
    const vectors = normalizeEmbeddingResponse(res, texts.length);
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const vectors = await this.embedTexts([text]);
    if (vectors.length !== 1) throw new Error('Embedding provider returned unexpected result size');
    return vectors[0];
  }

  private async requestWithRetries(payload: unknown, inputCount: number): Promise<any> {
    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            'Content-Type': 'application/json',
            // OpenRouter optionally uses these, but they are safe defaults:
            'X-Title': 'doclistdb-full-import-script',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });

        if (!response.ok) {
          const body = await safeReadText(response);
          const retryable = response.status === 429 || response.status >= 500;
          throw new HttpError(response.status, body, retryable);
        }

        return await response.json();
      } catch (e) {
        const retryable = isRetryableError(e);
        if (!retryable || attempt === this.cfg.maxRetries) {
          this.logger.error(
            {
              kind: 'embeddings_error',
              attempt,
              inputCount,
              endpoint: safeUrl(this.endpoint),
              err: toErrorFields(e),
            },
            'embeddings request failed'
          );
          throw e;
        }

        const delay = backoffDelayMs(attempt, this.cfg.backoffBaseMs, this.cfg.backoffMaxMs);
        this.logger.warn(
          { attempt, delayMs: delay, inputCount, endpoint: safeUrl(this.endpoint), err: toErrorFields(e) },
          'embeddings request retry'
        );
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
    public readonly retryable: boolean
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

function isRetryableError(e: any): boolean {
  if (e instanceof HttpError) return e.retryable;
  const msg = String(e?.message || e);
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('ECONNRESET')) return true;
  return false;
}

function toErrorFields(e: any): { message: string; name?: string; stack?: string; status?: number; body?: string } {
  if (e instanceof HttpError) return { name: 'HttpError', message: e.message, status: e.status, body: truncate(e.body, 1200) };
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { message: String(e) };
}

function truncate(v: string, max: number): string {
  if (v.length <= max) return v;
  return v.slice(0, max) + '…';
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function normalizeEmbeddingResponse(json: any, expectedCount: number): number[][] {
  const data = json?.data;
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected embeddings response shape (missing data[]): ${JSON.stringify(json)?.slice(0, 500)}`);
  }
  if (data.length !== expectedCount) {
    // OpenAI-style API should return one embedding per input
    throw new Error(`Embeddings response count mismatch: expected ${expectedCount}, got ${data.length}`);
  }
  const vectors: number[][] = [];
  for (const item of data) {
    const emb = item?.embedding;
    if (!Array.isArray(emb)) throw new Error('Unexpected embedding item shape (missing embedding[])');
    vectors.push(emb as number[]);
  }
  return vectors;
}

