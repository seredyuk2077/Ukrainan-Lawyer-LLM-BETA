/**
 * U4 Qdrant client (LEX-114) — prod-ready, timeout + 1 retry on 502/timeout.
 * No secret logging. Returns hits with score + payload.
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../lib/config.js';

export interface QdrantSearchHit {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

/** Qdrant filter: must (AND) or should (OR). For "rada_nreg in [a,b]" use should with match value. */
export type QdrantFilter =
  | { must: Array<{ key: string; match: { value: string } }> }
  | { should: Array<{ key: string; match: { value: string } }> };

export interface QdrantSearchOptions {
  collection: string;
  vector: number[];
  limit: number;
  filter?: QdrantFilter;
  timeoutMs?: number;
}

let clientInstance: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!clientInstance) {
    if (!config.qdrantUrl) {
      throw new Error('QDRANT_URL (or qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB) not set');
    }
    clientInstance = new QdrantClient({
      url: config.qdrantUrl.replace(/\/+$/, ''),
      apiKey: config.qdrantApiKey || undefined,
      timeout: config.qdrantTimeoutSec * 1000,
      checkCompatibility: false,
    });
  }
  return clientInstance;
}

/**
 * Search Qdrant collection. One retry on 502/timeout when QDRANT_RETRY_ONCE=true.
 */
export async function qdrantSearch(
  options: QdrantSearchOptions
): Promise<QdrantSearchHit[]> {
  const timeoutMs = options.timeoutMs ?? config.qdrantTimeoutSec * 1000;
  const client = getClient();

  const doSearch = async (): Promise<QdrantSearchHit[]> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await client.search(options.collection, {
        vector: options.vector,
        limit: options.limit,
        filter: options.filter as never,
        with_payload: true,
      });
      clearTimeout(t);
      return (result || []).map((p: { id?: string | number; score?: number; payload?: Record<string, unknown> }) => ({
        id: p.id ?? '',
        score: typeof p.score === 'number' ? p.score : 0,
        payload: p.payload ?? {},
      }));
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  };

  try {
    return await doSearch();
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const isRetryable =
      config.qdrantRetryOnce &&
      (msg.includes('502') ||
        msg.includes('timeout') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('aborted'));
    if (isRetryable) {
      await new Promise((r) => setTimeout(r, 300));
      return await doSearch();
    }
    throw firstErr;
  }
}

export function getQdrantCollections(): { chunks: string; acts: string } {
  return {
    chunks: config.lldbiCollectionChunks,
    acts: config.lldbiCollectionActs,
  };
}

/** Scroll points (read-only). For inspection/debug; filter by rada_nreg etc. */
export interface QdrantScrollFilter {
  must?: Array<{ key: string; match: { value: string } }>;
}

export interface QdrantScrollResult {
  points: Array<{ id: string | number; payload: Record<string, unknown> }>;
  next_page_offset: string | number | null;
}

export async function qdrantScroll(
  collection: string,
  options: {
    limit?: number;
    filter?: QdrantScrollFilter;
    with_payload?: boolean;
    with_vector?: boolean;
    offset?: string | number;
  }
): Promise<QdrantScrollResult> {
  const client = getClient();
  const limit = options.limit ?? 100;
  const withPayload = options.with_payload !== false;
  const withVector = options.with_vector === true;
  const res = await client.scroll(collection, {
    limit,
    filter: options.filter as never,
    with_payload: withPayload,
    with_vector: withVector,
    offset: options.offset as never,
  });
  const points = ((res as { points?: Array<{ id?: string | number; payload?: Record<string, unknown> }> }).points ?? []).map(
    (p) => ({
      id: p.id ?? '',
      payload: p.payload ?? {},
    })
  );
  const next = (res as { next_page_offset?: string | number | null }).next_page_offset ?? null;
  return { points, next_page_offset: next };
}
