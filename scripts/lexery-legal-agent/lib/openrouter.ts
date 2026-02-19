/**
 * OpenRouter chat completions — lightweight wrapper for U2/U4 LLM calls.
 * Timeout, 1 retry, structured errors. Caller id for OpenRouter attribution (Referer path).
 *
 * Concurrency limiter: MAX 8 simultaneous LLM calls (OPENROUTER_MAX_CONCURRENT env).
 * Under 50 concurrent users, without this all 50 fire LLM calls at once → OpenRouter 429/slow.
 * With limiter: burst serialized, p95 improves significantly for later requests.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const LEXERY_REFERER_BASE = 'https://lexery-legal-agent';

// ── Concurrency semaphore ──────────────────────────────────────────────────
const MAX_CONCURRENT_LLM = parseInt(process.env.OPENROUTER_MAX_CONCURRENT ?? '8', 10);
let _activeLlmCalls = 0;
const _llmWaitQueue: Array<() => void> = [];

function _acquireLlmSlot(): Promise<void> {
  if (_activeLlmCalls < MAX_CONCURRENT_LLM) {
    _activeLlmCalls++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _llmWaitQueue.push(() => {
      _activeLlmCalls++;
      resolve();
    });
  });
}

function _releaseLlmSlot(): void {
  _activeLlmCalls--;
  const next = _llmWaitQueue.shift();
  if (next) next();
}

export interface OpenRouterChatOptions {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  /** Caller id for OpenRouter attribution: e.g. 'u2-classify', 'u4-query-rewrite'. Sets HTTP-Referer to base/caller. */
  caller?: string;
}

export interface OpenRouterResult {
  content: string;
  model_id: string;
  provider?: string;
  latency_ms: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public code: 'TIMEOUT' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'NETWORK',
    public statusCode?: number
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export async function openRouterChat(
  apiKey: string,
  options: OpenRouterChatOptions,
  timeoutSec: number
): Promise<OpenRouterResult> {
  await _acquireLlmSlot();
  try {
    return await _openRouterChatInner(apiKey, options, timeoutSec);
  } finally {
    _releaseLlmSlot();
  }
}

async function _openRouterChatInner(
  apiKey: string,
  options: OpenRouterChatOptions,
  timeoutSec: number
): Promise<OpenRouterResult> {
  const url = `${OPENROUTER_BASE}/chat/completions`;
  const started = Date.now();
  const timeoutMs = Math.max(1000, timeoutSec * 1000);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  const referer = options.caller
    ? `${LEXERY_REFERER_BASE}/${options.caller}`
    : LEXERY_REFERER_BASE;
  const doFetch = async (): Promise<Response> => {
    return fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.1,
        max_tokens: options.max_tokens ?? 1024,
      }),
      signal: ac.signal,
    });
  };

  try {
    let res = await doFetch();
    if (!res.ok && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500));
      clearTimeout(t);
      const ac2 = new AbortController();
      const t2 = setTimeout(() => ac2.abort(), timeoutMs);
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': referer,
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.max_tokens ?? 1024,
        }),
        signal: ac2.signal,
      });
      clearTimeout(t2);
    } else {
      clearTimeout(t);
    }

    const json = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      model?: string;
      id?: string;
    } | null;

    if (!res.ok) {
      throw new OpenRouterError(
        `OpenRouter HTTP ${res.status}`,
        'HTTP_ERROR',
        res.status
      );
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new OpenRouterError('OpenRouter response missing content', 'INVALID_RESPONSE');
    }

    const latency_ms = Date.now() - started;
    const model_id = json?.model ?? options.model;
    const provider = model_id.includes('/') ? model_id.split('/')[0] : undefined;
    return { content, model_id, provider, latency_ms };
  } catch (err) {
    clearTimeout(t);
    if (err instanceof OpenRouterError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new OpenRouterError(`OpenRouter timeout after ${timeoutSec}s`, 'TIMEOUT');
    }
    throw new OpenRouterError((err as Error).message ?? 'OpenRouter request failed', 'NETWORK');
  }
}
