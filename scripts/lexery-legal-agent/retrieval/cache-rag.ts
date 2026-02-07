/**
 * U4 CacheRAG runner (LEX-114, LEX-117) — run retrieval from SearchPlan/steps, produce RawHits + RetrievalTrace.
 * No full text fetch from R2 here; only refs (r2_key, json_path).
 */
import type { SearchPlan, SearchStep } from '../plan/types.js';
import type { RawHit, RetrievalTrace, DegradedSources } from './types.js';
import { embedQuery } from './embedding.js';
import { qdrantSearch, getQdrantCollections } from './qdrant-client.js';
import { config } from '../lib/config.js';

const QUERY_MAX_CHARS = 12000;

function effectiveQuery(query: string): string {
  const t = query.trim();
  if (t.length <= QUERY_MAX_CHARS) return t;
  const head = t.slice(0, 6000);
  const tail = t.slice(-6000);
  return head + '\n...[truncated]...\n' + tail;
}

function payloadToRawHit(
  hit: { score: number; payload: Record<string, unknown> },
  source: 'lldbi_chunks' | 'lldbi_acts'
): RawHit {
  const p = hit.payload;
  return {
    r2_key: String(p?.r2_key ?? ''),
    json_path: String(p?.json_path ?? ''),
    score: hit.score,
    source,
    rada_nreg: typeof p?.rada_nreg === 'string' ? p.rada_nreg : undefined,
    article_number:
      p?.article_number != null ? String(p.article_number) : null,
    title: typeof p?.title === 'string' ? p.title : undefined,
    metadata: p ? { ...p } : undefined,
  };
}

export interface RunCacheRagInput {
  query: string;
  searchPlan: SearchPlan;
  steps?: SearchStep[];
}

export interface RunCacheRagResult {
  rawHits: RawHit[];
  retrievalTrace: RetrievalTrace;
}

export async function runCacheRag(input: RunCacheRagInput): Promise<RunCacheRagResult> {
  const { query, searchPlan, steps } = input;
  const collections = getQdrantCollections();
  const allHits: RawHit[] = [];
  const stepsLatencyMs: number[] = [];
  const degraded: DegradedSources = {};
  const collectionsUsed: string[] = [];

  if (!searchPlan.sources.use_lldbi) {
    const trace: RetrievalTrace = {
      version: 1,
      hits: [],
      top_score: null,
      latency_ms: 0,
      degraded_sources: undefined,
      meta: { collections_used: [], steps_latency_ms: [] },
    };
    return { rawHits: [], retrievalTrace: trace };
  }

  const effective = effectiveQuery(query);
  const topK = searchPlan.thresholds?.top_k_chunks ?? config.lldbiTopK;
  const minScore = searchPlan.thresholds?.min_score ?? config.minScoreThreshold;

  let vector: number[] | null = null;
  const embedStart = Date.now();
  try {
    const emb = await embedQuery(effective);
    vector = emb.embedding;
    stepsLatencyMs.push(Date.now() - embedStart);
  } catch (err) {
    degraded.lldbi = true;
    const trace: RetrievalTrace = {
      version: 1,
      hits: [],
      top_score: null,
      latency_ms: Date.now() - embedStart,
      degraded_sources: degraded,
      meta: {
        collections_used: [],
        steps_latency_ms: [Date.now() - embedStart],
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      },
    };
    return { rawHits: [], retrievalTrace: trace };
  }

  if (!vector || vector.length === 0) {
    degraded.lldbi = true;
    const emptyTrace: RetrievalTrace = {
      version: 1,
      hits: [],
      top_score: null,
      latency_ms: stepsLatencyMs[0] ?? 0,
      degraded_sources: degraded,
      meta: { collections_used: [], steps_latency_ms: stepsLatencyMs },
    };
    return { rawHits: [], retrievalTrace: emptyTrace };
  }

  const stepsToRun: Array<{ kind: 'lldbi_chunks' | 'lldbi_acts'; collection: string }> = [];
  if (steps?.length) {
    for (const s of steps) {
      if (s.kind === 'lldbi_chunks') stepsToRun.push({ kind: 'lldbi_chunks', collection: collections.chunks });
      else if (s.kind === 'lldbi_acts') stepsToRun.push({ kind: 'lldbi_acts', collection: collections.acts });
    }
  }
  if (stepsToRun.length === 0) {
    stepsToRun.push({ kind: 'lldbi_chunks', collection: collections.chunks });
    stepsToRun.push({ kind: 'lldbi_acts', collection: collections.acts });
  }

  for (const { kind, collection } of stepsToRun) {
    const stepStart = Date.now();
    try {
      const limit = kind === 'lldbi_chunks' ? topK : (searchPlan.thresholds?.top_k_acts ?? 10);
      const hits = await qdrantSearch({
        collection,
        vector,
        limit,
        timeoutMs: config.qdrantTimeoutSec * 1000,
      });
      stepsLatencyMs.push(Date.now() - stepStart);
      collectionsUsed.push(collection);
      for (const h of hits) {
        if (h.score >= minScore) {
          const raw = payloadToRawHit(h, kind);
          if (raw.r2_key && raw.json_path) allHits.push(raw);
        }
      }
    } catch (err) {
      degraded.lldbi = true;
      stepsLatencyMs.push(Date.now() - stepStart);
      collectionsUsed.push(collection);
    }
  }

  const topScore =
    allHits.length > 0
      ? Math.max(...allHits.map((h) => h.score))
      : null;
  const totalLatency = stepsLatencyMs.reduce((a, b) => a + b, 0);

  const retrievalTrace: RetrievalTrace = {
    version: 1,
    hits: allHits,
    top_score: topScore,
    latency_ms: totalLatency,
    degraded_sources: Object.keys(degraded).length ? degraded : undefined,
    meta: {
      collections_used: collectionsUsed,
      steps_latency_ms: stepsLatencyMs,
    },
  };

  return { rawHits: allHits, retrievalTrace };
}
