/**
 * U4 CacheRAG runner (LEX-114, LEX-117) — run retrieval from SearchPlan/steps, produce RawHits + RetrievalTrace.
 * Data-driven: ActTaxonomyStore for anchors/candidates; no score-filter-to-zero; two-stage merges taxonomy + acts.
 */
import type { SearchPlan, SearchStep } from '../plan/types.js';
import type { RawHit, RetrievalTrace, DegradedSources } from './types.js';
import { embedQuery } from './embedding.js';
import { qdrantSearch, getQdrantCollections } from './qdrant-client.js';
import { config } from '../lib/config.js';
import { shapeQueryForRetrieval } from './query-shaping.js';
import {
  getTaxonomyCandidates,
  getActMeta,
  scoreActCandidate,
  type TaxonomyCandidatesResult,
} from './act-taxonomy-store.js';

const QUERY_MAX_CHARS = 12000;
/** Hybrid re-score weights (no extra LLM). Vector remains primary. */
const W_VEC = 0.6;
const W_ALIAS = 0.15;
const W_ARTICLE = 0.15;
const W_CATEGORY = 0.05;
const W_TITLE = 0.05;
const MIN_HITS_FOR_TWO_STAGE = 3;
const GOOD_SCORE_THRESHOLD = 0.4;
const TWO_STAGE_ACTS_TOP = 5;
/** Chunks per act in within-act retrieval (so relevant article can appear within each act). */
const TWO_STAGE_CHUNKS_PER_ACT = 35;
/** Diversity cap: max hits from same act in top N (avoids one act dominating). */
const DIVERSITY_TOP_N = 25;
const DIVERSITY_MAX_SAME_ACT = 16;

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
  /** Optional domain from query_profile (hint only; no hardcoded mapping). */
  domainHint?: string;
  /** Optional U2 entities for taxonomy scoring (act_abbrev, article_ref). */
  entities?: { act_abbrev?: string; article_ref?: string }[];
}

export interface RunCacheRagResult {
  rawHits: RawHit[];
  retrievalTrace: RetrievalTrace;
}

function dedupeHits(hits: RawHit[]): RawHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.r2_key}:${h.json_path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Diversity cap: in top DIVERSITY_TOP_N, allow at most DIVERSITY_MAX_SAME_ACT from same rada_nreg.
 * Pushes excess same-act hits after top N (generalizable; no act name hardcode).
 */
function applyDiversityCap(hits: RawHit[]): RawHit[] {
  const inTop: RawHit[] = [];
  const afterTop: RawHit[] = [];
  const countByAct = new Map<string, number>();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const nreg = h.rada_nreg ?? '_unknown';
    const count = countByAct.get(nreg) ?? 0;
    if (inTop.length < DIVERSITY_TOP_N && count < DIVERSITY_MAX_SAME_ACT) {
      inTop.push(h);
      countByAct.set(nreg, count + 1);
    } else {
      afterTop.push(h);
    }
  }
  return [...inTop, ...afterTop];
}

function tokenSet(s: string): Set<string> {
  const n = (s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return new Set(n.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2));
}

/** Title overlap score 0..1 (query vs hit title). */
function titleOverlapScore(query: string, title: string | undefined): number {
  if (!title?.trim()) return 0;
  const qSet = tokenSet(query);
  if (qSet.size === 0) return 0;
  const tSet = tokenSet(title);
  let match = 0;
  for (const t of qSet) if (tSet.has(t)) match += 1;
  return match / qSet.size;
}

/**
 * Hybrid score (no LLM): vector + alias + article_ref + category_hint + title_overlap.
 * Used for ordering only; hit.score stays the vector score for audit.
 */
function hybridScore(
  hit: RawHit,
  query: string,
  taxonomy: TaxonomyCandidatesResult,
  entities: { act_abbrev?: string; article_ref?: string }[] | undefined
): number {
  const vec = Math.min(1, Math.max(0, hit.score));
  const aliasMatch =
    hit.rada_nreg && taxonomy.rada_nreg_candidates.includes(hit.rada_nreg) ? 1 : 0;
  const articleMatch =
    entities?.some(
      (e) => e?.article_ref && hit.article_number !== null && hit.article_number === e.article_ref
    )
      ? 1
      : 0;
  const categoryHint =
    hit.rada_nreg &&
    taxonomy.alias_hits.some(
      (a) => a.rada_nreg === hit.rada_nreg && a.category && taxonomy.category_hints.includes(a.category)
    )
      ? 1
      : 0;
  const titleOverlap = titleOverlapScore(query, hit.title);
  return (
    W_VEC * vec +
    W_ALIAS * aliasMatch +
    W_ARTICLE * articleMatch +
    W_CATEGORY * categoryHint +
    W_TITLE * titleOverlap
  );
}

export async function runCacheRag(input: RunCacheRagInput): Promise<RunCacheRagResult> {
  const { query, searchPlan, steps, domainHint, entities } = input;
  const collections = getQdrantCollections();
  const allHits: RawHit[] = [];
  const stepsLatencyMs: number[] = [];
  const degraded: DegradedSources = {};
  const collectionsUsed: string[] = [];
  const stepsRequested: string[] = [];
  let usedFilteredChunksSearch = false;
  const queryVariantsUsed: string[] = [];
  let taxonomySnapshotVersion: number | null = null;

  if (!searchPlan.sources.use_lldbi) {
    const trace: RetrievalTrace = {
      version: 1,
      hits: [],
      top_score: null,
      latency_ms: 0,
      degraded_sources: undefined,
      meta: {
        collections_used: [],
        steps_latency_ms: [],
        steps_requested: [],
        steps_executed: [],
        query_used: query.slice(0, 200),
        hits_count: 0,
      },
    };
    return { rawHits: [], retrievalTrace: trace };
  }

  const taxonomyResult = await getTaxonomyCandidates({
    query,
    domainHint,
    entities,
  });
  taxonomySnapshotVersion = taxonomyResult.debug.taxonomy_snapshot_version ?? null;
  const { shapedQuery, anchorsUsed } = shapeQueryForRetrieval(
    query,
    domainHint,
    taxonomyResult.anchor_tokens
  );
  const effective = effectiveQuery(shapedQuery);
  queryVariantsUsed.push(effective.slice(0, 200));

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
        steps_requested: [],
        steps_executed: [],
        query_used: effective.slice(0, 200),
        hits_count: 0,
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
      meta: {
        collections_used: [],
        steps_latency_ms: stepsLatencyMs,
        steps_requested: [],
        steps_executed: [],
        query_used: effective.slice(0, 200),
        hits_count: 0,
      },
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
  stepsRequested.push(...stepsToRun.map((s) => s.kind));
  const usedActsSearch = stepsToRun.some((s) => s.kind === 'lldbi_acts');

  const rawPerStep: RawHit[] = [];
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
        const raw = payloadToRawHit(h, kind);
        if (raw.r2_key && raw.json_path) rawPerStep.push(raw);
      }
    } catch (err) {
      degraded.lldbi = true;
      stepsLatencyMs.push(Date.now() - stepStart);
      collectionsUsed.push(collection);
    }
  }

  const aboveThreshold = rawPerStep.filter((h) => h.score >= minScore);
  const useLowConfidenceFallback = aboveThreshold.length === 0 && rawPerStep.length > 0;
  const candidateHits = useLowConfidenceFallback ? rawPerStep : aboveThreshold;
  candidateHits.sort((a, b) => b.score - a.score);
  const merged = dedupeHits(candidateHits);
  allHits.push(...merged);

  let topScore = allHits.length > 0 ? Math.max(...allHits.map((h) => h.score)) : null;
  const needTwoStage =
    allHits.length < MIN_HITS_FOR_TWO_STAGE ||
    (topScore != null && topScore < GOOD_SCORE_THRESHOLD);
  const hasActCandidates =
    (taxonomyResult.rada_nreg_candidates?.length ?? 0) > 0 || stepsToRun.some((s) => s.kind === 'lldbi_acts');

  // Always run within-act retrieval when we have act candidates (taxonomy or acts search).
  // This surfaces articles (e.g. ст.130) that rank lower globally but are relevant within the right act.
  if (hasActCandidates && !degraded.lldbi && stepsToRun.some((s) => s.kind === 'lldbi_acts')) {
    const actsStep = stepsToRun.find((s) => s.kind === 'lldbi_acts');
    if (actsStep) {
      const actLimit = searchPlan.thresholds?.top_k_acts ?? 10;
      try {
        const actStart = Date.now();
        const actHits = await qdrantSearch({
          collection: actsStep.collection,
          vector,
          limit: actLimit,
          timeoutMs: config.qdrantTimeoutSec * 1000,
        });
        stepsLatencyMs.push(Date.now() - actStart);
        const actNregs = actHits
          .map((h) => (h.payload?.rada_nreg as string)?.trim())
          .filter((n): n is string => !!n);
        const taxonomyNregs = taxonomyResult.rada_nreg_candidates ?? [];
        const mergedNregs = [...new Set([...actNregs, ...taxonomyNregs])].slice(0, TWO_STAGE_ACTS_TOP);
        const topNregs = mergedNregs.length > 0 ? mergedNregs : actNregs.slice(0, TWO_STAGE_ACTS_TOP);
        if (topNregs.length > 0) {
          const chunkStart = Date.now();
          // Per-act retrieval: top N chunks per act so relevant article (e.g. ст.130) can appear within act.
          const filteredChunkHits: { score: number; payload: Record<string, unknown> }[] = [];
          for (const nreg of topNregs) {
            const actHits = await qdrantSearch({
              collection: collections.chunks,
              vector,
              limit: TWO_STAGE_CHUNKS_PER_ACT,
              filter: { must: [{ key: 'rada_nreg', match: { value: nreg } }] },
              timeoutMs: config.qdrantTimeoutSec * 1000,
            });
            filteredChunkHits.push(...actHits);
          }
          stepsLatencyMs.push(Date.now() - chunkStart);
          collectionsUsed.push(`${collections.chunks}(filtered)`);
          usedFilteredChunksSearch = true;
          for (const h of filteredChunkHits) {
            const raw = payloadToRawHit(h, 'lldbi_chunks');
            if (raw.r2_key && raw.json_path) allHits.push(raw);
          }
          const deduped = dedupeHits(allHits).sort((a, b) => b.score - a.score);
          allHits.length = 0;
          allHits.push(...deduped);
          topScore = allHits.length > 0 ? Math.max(...allHits.map((h) => h.score)) : null;
        }
      } catch {
        // two-stage best-effort; keep first-pass hits
      }
    }
  }

  // Hybrid re-score for ordering (no extra LLM); hit.score unchanged for audit
  if (allHits.length > 0 && taxonomyResult.debug.source === 'supabase') {
    allHits.sort(
      (a, b) =>
        hybridScore(b, query, taxonomyResult, entities) -
        hybridScore(a, query, taxonomyResult, entities)
    );
  }

  // Diversity cap: limit same-act dominance in top N
  const capped = applyDiversityCap(allHits);
  allHits.length = 0;
  allHits.push(...capped);

  const totalLatency = stepsLatencyMs.reduce((a, b) => a + b, 0);
  const avgScore =
    allHits.length > 0 ? allHits.reduce((s, h) => s + h.score, 0) / allHits.length : undefined;

  // Act candidates top 5 (for trace): taxonomy + act search nregs, with title and score
  const actNregsFromSearch = [
    ...new Set(
      rawPerStep
        .filter((h) => h.source === 'lldbi_acts')
        .map((h) => h.rada_nreg)
        .filter((n): n is string => !!n)
    ),
  ];
  const top5Nregs = [
    ...new Set([...taxonomyResult.rada_nreg_candidates, ...actNregsFromSearch]),
  ].slice(0, 5);
  const queryTokens = query
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  const actCandidatesTop = await Promise.all(
    top5Nregs.map(async (nreg) => {
      const meta = await getActMeta(nreg);
      const { score, reasons } = await scoreActCandidate(nreg, queryTokens, domainHint);
      return { rada_nreg: nreg, title: meta?.title ?? undefined, score, reasons };
    })
  );

  // Distribution: hits by act in top 3 acts (by hit count in top 30)
  const top30 = allHits.slice(0, 30);
  const countByAct = new Map<string, number>();
  for (const h of top30) {
    const nreg = h.rada_nreg ?? '_unknown';
    countByAct.set(nreg, (countByAct.get(nreg) ?? 0) + 1);
  }
  const top3Acts = [...countByAct.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([nreg]) => nreg);
  const hitsByActTop3: Record<string, number> = {};
  const avgScoreByActTop3: Record<string, number> = {};
  for (const nreg of top3Acts) {
    const fromAct = allHits.filter((h) => (h.rada_nreg ?? '_unknown') === nreg);
    hitsByActTop3[nreg] = fromAct.length;
    avgScoreByActTop3[nreg] =
      fromAct.length > 0
        ? fromAct.reduce((s, h) => s + h.score, 0) / fromAct.length
        : 0;
  }

  const reasonCodes: string[] = [];
  if (useLowConfidenceFallback) reasonCodes.push('low_confidence_fallback');

  const sampleHits = allHits.slice(0, 5).map((h) => ({
    source: h.source,
    score: h.score,
    r2_key: h.r2_key,
    json_path: h.json_path,
    act_title: h.title,
    article_ref: h.article_number ?? null,
  }));

  const retrievalTrace: RetrievalTrace = {
    version: 1,
    hits: allHits,
    top_score: topScore,
    latency_ms: totalLatency,
    degraded_sources: Object.keys(degraded).length ? degraded : undefined,
    meta: {
      collections_used: collectionsUsed,
      steps_latency_ms: stepsLatencyMs,
      sample_hits: sampleHits,
      steps_requested: stepsRequested,
      steps_executed: [...collectionsUsed],
      query_used: effective.slice(0, 200),
      hits_count: allHits.length,
      avg_score: avgScore,
      low_confidence: useLowConfidenceFallback,
      why_low_confidence:
        useLowConfidenceFallback && rawPerStep.length > 0
          ? 'all_hits_below_min_score_fallback_to_top_k'
          : undefined,
      query_variants_used: queryVariantsUsed.length ? queryVariantsUsed : undefined,
      used_filtered_chunks_search: usedFilteredChunksSearch || undefined,
      anchors_used: anchorsUsed.length ? anchorsUsed : undefined,
      taxonomy_snapshot_version: taxonomySnapshotVersion ?? undefined,
      hybrid_rescore_used: taxonomyResult.debug.source === 'supabase' ? true : undefined,
      thesaurus_version: 1,
      act_candidates_top: actCandidatesTop,
      stage_decisions: {
        used_taxonomy: taxonomyResult.debug.source === 'supabase',
        used_acts_search: usedActsSearch,
        used_filtered_chunks: usedFilteredChunksSearch,
        used_llm_rewrite: false,
        used_llm_rerank: false,
      },
      distribution:
        Object.keys(hitsByActTop3).length > 0
          ? { hits_by_act_top3: hitsByActTop3, avg_score_by_act_top3: avgScoreByActTop3 }
          : undefined,
      reason_codes: reasonCodes.length ? reasonCodes : undefined,
    },
  };

  return { rawHits: allHits, retrievalTrace };
}
