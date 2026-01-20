import type { Logger } from 'pino';
import { backoffDelayMs, randomIntBetween, safeUrl, sleep, toErrorFields, truncate } from '../utils.js';

export interface RadaClientConfig {
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  delayMinMs: number;
  delayMaxMs: number;
  userAgent: string;
}

export type FetchOutcome<T> =
  | { ok: true; status: 200; data: T; lastModified: string | null }
  | { ok: true; status: 304; data: null; lastModified: string | null }
  | { ok: false; status: number; error: unknown; lastModified: string | null };

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

function isRetryableError(e: unknown): boolean {
  if (e instanceof HttpError) return e.retryable;
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ETIMEDOUT') || msg.toLowerCase().includes('timeout')) return true;
  if (msg.includes('ECONNRESET') || msg.includes('EAI_AGAIN') || msg.includes('fetch failed')) return true;
  return false;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function parseRetryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  // Could be an HTTP date; ignore for simplicity.
  return null;
}

/**
 * Simple global pacer to keep Rada requests gentle even with concurrency > 1.
 */
class RequestPacer {
  private chain: Promise<void> = Promise.resolve();
  private nextAtMs: number = 0;

  constructor(private readonly cfg: { delayMinMs: number; delayMaxMs: number }) {}

  async pace(): Promise<void> {
    const delay = randomIntBetween(this.cfg.delayMinMs, this.cfg.delayMaxMs);
    const task = async () => {
      const now = Date.now();
      const wait = Math.max(0, this.nextAtMs - now);
      if (wait > 0) await sleep(wait);
      // Reserve the next slot after this request "start".
      this.nextAtMs = Date.now() + delay;
    };
    this.chain = this.chain.then(task, task);
    await this.chain;
  }
}

export class RadaHttpClient {
  private readonly pacer: RequestPacer;

  constructor(
    private readonly logger: Logger,
    private readonly cfg: RadaClientConfig
  ) {
    this.pacer = new RequestPacer({ delayMinMs: cfg.delayMinMs, delayMaxMs: cfg.delayMaxMs });
  }

  async fetchText(url: string, opts?: { ifModifiedSince?: string | null }): Promise<FetchOutcome<string>> {
    return await this.requestWithRetries<string>(url, 'text', opts);
  }

  async fetchJson<T = any>(url: string, opts?: { ifModifiedSince?: string | null }): Promise<FetchOutcome<T>> {
    return await this.requestWithRetries<T>(url, 'json', opts);
  }

  private async requestWithRetries<T>(
    url: string,
    kind: 'text' | 'json',
    opts?: { ifModifiedSince?: string | null }
  ): Promise<FetchOutcome<T>> {
    const ifModifiedSince = (opts?.ifModifiedSince || '').trim() || null;

    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        await this.pacer.pace();

        const res = await fetch(url, {
          method: 'GET',
          headers: {
            // Critical for GitHub Actions / rotating IPs:
            'User-Agent': this.cfg.userAgent,
            ...(ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : {}),
            Accept: kind === 'json' ? 'application/json, text/plain;q=0.9, */*;q=0.8' : 'text/plain, */*;q=0.8',
          },
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });

        const lastModified = res.headers.get('last-modified');

        if (res.status === 304) {
          return { ok: true, status: 304, data: null, lastModified };
        }

        if (!res.ok) {
          const body = await safeReadText(res);
          const retryable = res.status === 429 || res.status >= 500;
          const e = new HttpError(res.status, body, retryable, `${res.status} ${res.statusText}`);
          if (res.status === 429) (e as any).__retryAfterMs = parseRetryAfterMs(res);
          throw e;
        }

        if (kind === 'text') {
          const text = await res.text();
          return { ok: true, status: 200, data: text as any, lastModified };
        }

        const text = await res.text();
        try {
          const json = text ? (JSON.parse(text) as T) : (null as any);
          return { ok: true, status: 200, data: json, lastModified };
        } catch (e) {
          throw new Error(`Failed to parse JSON from ${safeUrl(url)}: ${String(e)}; body=${truncate(text, 600)}`);
        }
      } catch (e) {
        const retryable = isRetryableError(e);
        const status = e instanceof HttpError ? e.status : undefined;
        const retryAfterMs = (e as any)?.__retryAfterMs as number | undefined;

        if (!retryable || attempt === this.cfg.maxRetries) {
          this.logger.error({ url: safeUrl(url), attempt, kind, status, err: toErrorFields(e) }, 'rada request failed');
          return { ok: false, status: status ?? 0, error: e, lastModified: null };
        }

        const backoff = backoffDelayMs(attempt, this.cfg.backoffBaseMs, this.cfg.backoffMaxMs);
        const delay = retryAfterMs ? Math.max(retryAfterMs, backoff) : backoff;
        this.logger.warn(
          { url: safeUrl(url), attempt, delayMs: delay, kind, status, err: toErrorFields(e) },
          'rada request retry'
        );
        await sleep(delay);
      }
    }

    return { ok: false, status: 0, error: new Error('unreachable'), lastModified: null };
  }
}

