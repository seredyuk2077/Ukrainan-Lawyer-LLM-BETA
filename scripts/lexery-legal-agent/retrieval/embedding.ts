/**
 * U4 Query embedding (LEX-114) — aligned with LLDBI index: 1536d, openai/text-embedding-3-small.
 * OpenRouter embeddings API; 1 retry on 5xx.
 */
import { config } from '../lib/config.js';

const EXPECTED_DIM = 1536;

export interface EmbedResult {
  embedding: number[];
  dimensions: number;
  model: string;
}

export async function embedQuery(text: string): Promise<EmbedResult> {
  const apiKey = config.openRouterApiKeyRag;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY_BRAIN or OPENROUTER_API_KEY_ONLINE required for U4 embeddings');
  }
  const trimmed = text.trim();
  const input = trimmed.length > 0 ? trimmed : 'query';
  const timeoutMs = config.lldbiEmbedTimeoutSec * 1000;

  const doFetch = async (): Promise<EmbedResult> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://lexery-legal-agent/u4-embeddings',
          'X-Title': 'Lexery Brain U4 Embeddings',
        },
        body: JSON.stringify({
          model: config.lldbiEmbedModelId,
          input: input.slice(0, 12000),
        }),
      });
      clearTimeout(t);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter embeddings ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
        error?: { message?: string };
      };
      if (data.error) {
        throw new Error(String(data.error.message || 'OpenRouter error'));
      }
      const embedding = data.data?.[0]?.embedding;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Invalid embedding response: no embedding array');
      }
      if (embedding.length !== EXPECTED_DIM) {
        throw new Error(
          `Embedding dimension mismatch: expected ${EXPECTED_DIM}, got ${embedding.length}`
        );
      }
      return {
        embedding,
        dimensions: embedding.length,
        model: config.lldbiEmbedModelId,
      };
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  };

  try {
    return await doFetch();
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const is5xx = msg.includes(' 5') || msg.includes('502') || msg.includes('503');
    if (is5xx) {
      await new Promise((r) => setTimeout(r, 500));
      return await doFetch();
    }
    throw firstErr;
  }
}

/** Batch embeddings (OpenRouter array input). Timeout and 1 retry on 5xx as in embedQuery. */
export async function embedMany(texts: string[]): Promise<EmbedResult[]> {
  const apiKey = config.openRouterApiKeyRag;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY_BRAIN or OPENROUTER_API_KEY_ONLINE required for embeddings');
  }
  const batchSize = config.lldbiEmbedBatchSize ?? 16;
  const timeoutMs = config.lldbiEmbedTimeoutSec * 1000;
  const results: EmbedResult[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize).map((t) => (t.trim() || 'query').slice(0, 12000));
    const doFetch = async (): Promise<EmbedResult[]> => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://lexery-legal-agent/u4-embeddings-batch',
            'X-Title': 'Lexery Brain U4 Embeddings Batch',
          },
          body: JSON.stringify({
            model: config.lldbiEmbedModelId,
            input: chunk.length === 1 ? chunk[0] : chunk,
          }),
        });
        clearTimeout(t);
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`OpenRouter embeddings ${res.status}: ${errText.slice(0, 200)}`);
        }
        const data = (await res.json()) as {
          data?: Array<{ embedding?: number[] }>;
          error?: { message?: string };
        };
        if (data.error) throw new Error(String(data.error.message || 'OpenRouter error'));
        const arr = data.data ?? [];
        const out: EmbedResult[] = [];
        for (let j = 0; j < chunk.length; j++) {
          const emb = arr[j]?.embedding;
          if (!emb || !Array.isArray(emb) || emb.length !== EXPECTED_DIM) {
            throw new Error(`Invalid embedding at index ${j}: expected length ${EXPECTED_DIM}`);
          }
          out.push({ embedding: emb, dimensions: emb.length, model: config.lldbiEmbedModelId });
        }
        return out;
      } catch (e) {
        clearTimeout(t);
        throw e;
      }
    };
    try {
      const part = await doFetch();
      results.push(...part);
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const is5xx = msg.includes(' 5') || msg.includes('502') || msg.includes('503');
      if (is5xx) {
        await new Promise((r) => setTimeout(r, 500));
        results.push(...(await doFetch()));
      } else {
        throw firstErr;
      }
    }
  }
  return results;
}
