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
const _rawConcurrent = parseInt(process.env.OPENROUTER_MAX_CONCURRENT ?? '8', 10);
const MAX_CONCURRENT_LLM = Number.isFinite(_rawConcurrent) && _rawConcurrent >= 1 ? _rawConcurrent : 8;
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
  /** OpenRouter: reasoning effort (e.g. "low") to reduce reasoning token burn. */
  reasoning?: { effort?: string };
  /** OpenRouter: response_format for structured output (e.g. json_schema). */
  response_format?: unknown;
  /** OpenRouter: max_completion_tokens (alias or in addition to max_tokens). */
  max_completion_tokens?: number;
  /** Passthrough: merged into request body. Keys must be valid OpenRouter API fields. */
  extra?: Record<string, unknown>;
}

export interface OpenRouterResult {
  content: string;
  model_id: string;
  provider?: string;
  latency_ms: number;
  finish_reason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  /** Diagnostics: raw shape of message.content for observability. */
  raw_content_type?: 'string' | 'array' | 'null';
  /** True when only reasoning parts were present (no text part); content may be reasoning fallback. */
  had_reasoning_only?: boolean;
  /** Top-level keys on message object (for forensics when content is null). */
  raw_message_keys?: string[];
  /** From usage.completion_tokens_details.reasoning_tokens or usage.reasoning_tokens. */
  reasoning_tokens?: number;
  /** Request: max_tokens if set. */
  request_max_tokens?: number;
  /** Request: max_completion_tokens if set. */
  request_max_completion_tokens?: number;
  /** Request: effective token budget used (max_completion_tokens ?? max_tokens ?? 1024). */
  request_effective_token_budget?: number;
}

export type OpenRouterErrorCode =
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK'
  | 'EMPTY_OUTPUT_LENGTH'
  | 'EMPTY_ASSISTANT_CONTENT';

/** Used when content is empty: maps finish_reason to error code. Exported for unit tests. */
export function getEmptyContentErrorCode(finishReason: string | undefined): OpenRouterErrorCode {
  return finishReason === 'length' ? 'EMPTY_OUTPUT_LENGTH' : 'EMPTY_ASSISTANT_CONTENT';
}

const MAX_RESPONSE_BODY_SNIPPET = 500;

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public code: OpenRouterErrorCode,
    public statusCode?: number,
    meta?: {
      error_code?: string;
      finish_reason?: string;
      raw_content_type?: OpenRouterResult['raw_content_type'];
      request_effective_token_budget?: number;
      /** Bounded snippet of API error response body for 400/5xx diagnostics. */
      response_body_snippet?: string;
    }
  ) {
    super(message);
    this.name = 'OpenRouterError';
    this.error_code = meta?.error_code ?? code;
    this.finish_reason = meta?.finish_reason;
    this.raw_content_type = meta?.raw_content_type;
    this.request_effective_token_budget = meta?.request_effective_token_budget;
    this.response_body_snippet = meta?.response_body_snippet;
  }

  /** Optional diagnostics for caller telemetry (triage trails). */
  public error_code?: string;
  public finish_reason?: string;
  public raw_content_type?: OpenRouterResult['raw_content_type'];
  public request_effective_token_budget?: number;
  /** Bounded snippet of error response body (e.g. OpenRouter 400). */
  public response_body_snippet?: string;
}

/** Content part from providers that return message.content as array (e.g. reasoning models). */
type ContentPart = { type?: string; text?: string };

/**
 * Extract assistant text from OpenRouter/OpenAI-style message.content.
 * Handles: string, array of { type, text } (prefer type=text, fallback to reasoning), null with optional reasoning_content.
 * Model-agnostic: no provider-specific hardcoding beyond common shapes.
 */
export function extractAssistantText(raw: unknown): { text: string; raw_content_type: 'string' | 'array' | 'null'; had_reasoning_only: boolean } {
  if (raw === null || raw === undefined) {
    return { text: '', raw_content_type: 'null', had_reasoning_only: false };
  }
  if (typeof raw === 'string') {
    return { text: raw.trim(), raw_content_type: 'string', had_reasoning_only: false };
  }
  if (!Array.isArray(raw)) {
    return { text: '', raw_content_type: 'null', had_reasoning_only: false };
  }
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const part of raw as ContentPart[]) {
    const t = part?.text;
    if (typeof t !== 'string') continue;
    const type = (part?.type ?? 'text').toLowerCase();
    if (type === 'reasoning' || type === 'reasoning_content') {
      reasoningParts.push(t);
    } else {
      textParts.push(t);
    }
  }
  const text = textParts.length > 0 ? textParts.join('\n').trim() : reasoningParts.join('\n').trim();
  return {
    text,
    raw_content_type: 'array',
    had_reasoning_only: textParts.length === 0 && reasoningParts.length > 0,
  };
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

type Choice = {
  message?: { content?: string | unknown[] | null; reasoning_content?: unknown; reasoning_details?: unknown[] };
  finish_reason?: string;
};
type UsageShape = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

async function _openRouterChatInner(
  apiKey: string,
  options: OpenRouterChatOptions,
  timeoutSec: number
): Promise<OpenRouterResult> {
  const url = `${OPENROUTER_BASE}/chat/completions`;
  const started = Date.now();
  const timeoutMs = Math.max(1000, timeoutSec * 1000);
  const referer = options.caller
    ? `${LEXERY_REFERER_BASE}/${options.caller}`
    : LEXERY_REFERER_BASE;

  // For reasoning models, OpenRouter may use max_completion_tokens for assistant output;
  // send both when set so provider can cap completion separately from total.
  const effectiveMaxTokens = options.max_completion_tokens ?? options.max_tokens ?? 1024;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.1,
    max_tokens: effectiveMaxTokens,
    ...(options.max_completion_tokens != null && { max_completion_tokens: options.max_completion_tokens }),
    ...(options.reasoning != null && { reasoning: options.reasoning }),
    ...(options.response_format != null && { response_format: options.response_format }),
    ...(options.extra != null && options.extra),
  };

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new OpenRouterError(`OpenRouter timeout after ${timeoutSec}s`, 'TIMEOUT')),
      timeoutMs
    );
  });

  const doRequest = async (): Promise<{ res: Response; json: { choices?: Choice[]; model?: string; usage?: UsageShape } | null }> => {
    const ac = new AbortController();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    let json: { choices?: Choice[]; model?: string; usage?: UsageShape } | null = null;
    try {
      json = (await res.json().catch(() => null)) as typeof json;
    } catch {
      // body already consumed
    }
    return { res, json };
  };

  const doRequestWithRetry = async (): Promise<{ res: Response; json: { choices?: Choice[]; model?: string; usage?: UsageShape } | null }> => {
    let { res, json } = await doRequest();
    if (!res.ok && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500));
      const second = await doRequest();
      res = second.res;
      json = second.json;
    }
    return { res, json };
  };

  try {
    const { res, json } = await Promise.race([doRequestWithRetry(), timeoutPromise]);
    clearTimeout(timeoutId!);

    if (!res.ok) {
      const errBody = json as { error?: { message?: string; code?: number } } | null;
      const errMsg = errBody?.error?.message;
      const detail = errMsg ? `: ${String(errMsg).slice(0, 200)}` : '';
      const bodySnippet =
        json != null ? String(JSON.stringify(json)).slice(0, MAX_RESPONSE_BODY_SNIPPET) : undefined;
      throw new OpenRouterError(
        `OpenRouter HTTP ${res.status}${detail}`,
        'HTTP_ERROR',
        res.status,
        { response_body_snippet: bodySnippet }
      );
    }

    const message = json?.choices?.[0]?.message;
    const finish_reason = json?.choices?.[0]?.finish_reason;
    const raw_message_keys = message ? (Object.keys(message) as string[]) : undefined;
    const usage = json?.usage;
    const reasoning_tokens =
      usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;

    let rawContent: unknown = message?.content;
    if (rawContent === null || rawContent === undefined) {
      rawContent = (message as { reasoning_content?: unknown })?.reasoning_content ?? null;
    }
    const { text: content, raw_content_type, had_reasoning_only } = extractAssistantText(rawContent);

    if (content === '') {
      const code = getEmptyContentErrorCode(finish_reason);
      const err = new OpenRouterError(
        code === 'EMPTY_OUTPUT_LENGTH'
          ? 'OpenRouter response: finish_reason=length and no text content (reasoning-only or truncated)'
          : 'OpenRouter response missing assistant content',
        code,
        undefined,
        {
          error_code: code,
          finish_reason,
          raw_content_type,
          request_effective_token_budget: effectiveMaxTokens,
        }
      );
      throw err;
    }

    const latency_ms = Date.now() - started;
    const model_id = json?.model ?? options.model;
    const provider = model_id.includes('/') ? model_id.split('/')[0] : undefined;
    return {
      content,
      model_id,
      provider,
      latency_ms,
      finish_reason,
      usage,
      raw_content_type,
      had_reasoning_only,
      raw_message_keys,
      reasoning_tokens,
      request_max_tokens: options.max_tokens,
      request_max_completion_tokens: options.max_completion_tokens,
      request_effective_token_budget: effectiveMaxTokens,
    };
  } catch (err) {
    clearTimeout(timeoutId!);
    if (err instanceof OpenRouterError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new OpenRouterError(`OpenRouter timeout after ${timeoutSec}s`, 'TIMEOUT');
    }
    throw new OpenRouterError((err as Error).message ?? 'OpenRouter request failed', 'NETWORK');
  }
}
