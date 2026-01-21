import type { Logger } from '../util/logger';

export interface OpenRouterClientConfig {
  apiKey: string;
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  timeoutMs: number;
}

export class OpenRouterClient {
  constructor(
    private readonly logger: Logger,
    private readonly cfg: OpenRouterClientConfig
  ) {}

  async chatCompletions(params: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const started = Date.now();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'act-catalog-resolver-api',
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          temperature: params.temperature ?? 0.1,
          max_tokens: params.max_tokens ?? 600,
        }),
        signal: ac.signal,
      });

      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        this.logger.error(
          { status: res.status, endpoint: safeUrl(url), resp_preview: safeJsonPreview(json) },
          'openrouter chat request failed'
        );
        throw new Error(`OpenRouter HTTP ${res.status}`);
      }

      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('OpenRouter response missing choices[0].message.content');
      }
      this.logger.debug({ took_ms: Date.now() - started, model: params.model }, 'openrouter chat ok');
      return content;
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

