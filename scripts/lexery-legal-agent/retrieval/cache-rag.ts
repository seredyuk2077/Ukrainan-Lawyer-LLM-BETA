/**
 * U4 CacheRAG runner (LEX-114, LEX-117) — run retrieval from SearchPlan/steps, produce RawHits + RetrievalTrace.
 * Data-driven: ActTaxonomyStore for anchors/candidates; no score-filter-to-zero; two-stage merges taxonomy + acts.
 * Multi-goal: heuristic goal split → per-goal retrieval → coverage fusion + diversity cap.
 */
import type { SearchPlan, SearchStep } from '../plan/types.js';
import type { RawHit, RetrievalTrace, DegradedSources } from './types.js';
import type { RoutingFlags } from '../classify/types.js';
import type { EvidenceGoal } from './goals.js';
import { embedQuery } from './embedding.js';
import { qdrantSearch, getQdrantCollections } from './qdrant-client.js';
import { config } from '../lib/config.js';
import { shapeQueryForRetrieval } from './query-shaping.js';
import { heuristicGoalSplit } from './goal-splitter.js';
import { callLlmRetrievalPlanner, type LlmPlannerResult } from './llm-planner.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import { Semaphore } from '../lib/semaphore.js';
import { isCircuitOpen, recordLlmFailure } from '../classify/circuit-breaker.js';
import {
  getTaxonomyCandidates,
  getActMeta,
  scoreActCandidate,
  type TaxonomyCandidatesResult,
} from './act-taxonomy-store.js';

const u4PlannerSemaphore = new Semaphore(config.u4PlannerConcurrency);

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
  /** Optional routing flags for multi-goal (contract/table/large input). */
  routing_flags?: RoutingFlags | null;
  /** Optional run_id for caching LLM planner result in RunContext. */
  run_id?: string;
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
 * Coverage fusion: in top N ensure at least minPerGoal hits from each goal (when available).
 * Order: top minPerGoal per goal by score, then fill rest by score.
 */
function applyCoverageFusion(
  hits: RawHit[],
  goals: EvidenceGoal[],
  topN: number,
  minPerGoal: number
): RawHit[] {
  const byGoal = new Map<string, RawHit[]>();
  for (const h of hits) {
    const gid = h.goal_id ?? '_single';
    if (!byGoal.has(gid)) byGoal.set(gid, []);
    byGoal.get(gid)!.push(h);
  }
  for (const [_, list] of byGoal) list.sort((a, b) => b.score - a.score);

  const coveredKeys = new Set<string>();
  const covered: RawHit[] = [];
  for (const g of goals) {
    const list = byGoal.get(g.id) ?? [];
    const take = Math.min(minPerGoal, list.length);
    for (let i = 0; i < take; i++) {
      const h = list[i];
      const key = `${h.r2_key}:${h.json_path}`;
      if (!coveredKeys.has(key)) {
        coveredKeys.add(key);
        covered.push(h);
      }
    }
  }
  covered.sort((a, b) => b.score - a.score);
  const remaining = hits.filter((h) => !coveredKeys.has(`${h.r2_key}:${h.json_path}`));
  remaining.sort((a, b) => b.score - a.score);
  return [...covered, ...remaining].slice(0, topN);
}

/** Heuristic noise: title patterns that are not primary legal content (e.g. separate opinion, trade order). */
const NOISE_TITLE_PATTERNS = [/окрем[ауі]\s+думк/i, /порядок\s+торгівл/i];
const NOISE_PENALTY = 0.15;
const NOISE_PENALTY_DELTA = 0.1;
const NOISE_PENALTY_POLICY_VERSION = 1;
/** Primary-law-like: codex, law, constitution, procedural codes (for guard: penalty only when alternative exists). */
const PRIMARY_LAW_TITLE_PATTERN = /кодекс|закон|конституція|процесуальн|кримінальн|цивільн.*кодекс|господарськ.*кодекс/i;

function isPrimaryLawLike(hit: RawHit): boolean {
  const title = (hit.title ?? '').normalize('NFC');
  return PRIMARY_LAW_TITLE_PATTERN.test(title);
}

export interface NoisePenaltyResult {
  hits: RawHit[];
  penaltyCount: number;
  guardBlockedCount: number;
  guardReasonCodes: string[];
}

function applyNoisePenalty(hits: RawHit[], topNForGuard: number = 30): NoisePenaltyResult {
  let penaltyCount = 0;
  let guardBlockedCount = 0;
  const guardReasonCodes: string[] = [];
  const topN = Math.min(topNForGuard, hits.length);
  const topHits = hits.slice(0, topN);
  const goalCountInTopN = new Map<string, number>();
  for (const h of topHits) {
    const gid = h.goal_id ?? '_single';
    goalCountInTopN.set(gid, (goalCountInTopN.get(gid) ?? 0) + 1);
  }
  const withPenalty = hits.map((h) => {
    const title = (h.title ?? '').normalize('NFC');
    const isNoise = NOISE_TITLE_PATTERNS.some((re) => re.test(title));
    if (!isNoise) return { hit: h, effectiveScore: h.score ?? 0 };
    const score = h.score ?? 0;
    const hasPrimaryInDelta = topHits.some(
      (o) => o !== h && isPrimaryLawLike(o) && (o.score ?? 0) >= score - NOISE_PENALTY_DELTA
    );
    const gid = h.goal_id ?? '_single';
    const onlySourceForGoal = (goalCountInTopN.get(gid) ?? 0) <= 1;
    if (!hasPrimaryInDelta) {
      guardBlockedCount += 1;
      if (!guardReasonCodes.includes('NO_PRIMARY_ALTERNATIVE')) guardReasonCodes.push('NO_PRIMARY_ALTERNATIVE');
      return { hit: h, effectiveScore: score };
    }
    if (onlySourceForGoal) {
      guardBlockedCount += 1;
      if (!guardReasonCodes.includes('ONLY_SOURCE_FOR_GOAL')) guardReasonCodes.push('ONLY_SOURCE_FOR_GOAL');
      return { hit: h, effectiveScore: score };
    }
    penaltyCount += 1;
    return { hit: h, effectiveScore: Math.max(0, score - NOISE_PENALTY) };
  });
  withPenalty.sort((a, b) => b.effectiveScore - a.effectiveScore);
  return {
    hits: withPenalty.map((x) => x.hit),
    penaltyCount,
    guardBlockedCount,
    guardReasonCodes,
  };
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

/** Single-goal retrieval: embed + taxonomy + steps + within-act + hybrid sort. Returns hits with goal_id set. */
async function runOneGoal(
  goal: EvidenceGoal,
  entities: { act_abbrev?: string; article_ref?: string }[] | undefined,
  searchPlan: SearchPlan,
  steps: SearchStep[] | undefined,
  collections: { chunks: string; acts: string },
  callCounter?: { count: number }
): Promise<{
  hits: RawHit[];
  actNregsForSummary: string[];
  usedFilteredChunks: boolean;
  stepsLatencyMs: number[];
  collectionsUsed: string[];
  taxonomyResult: TaxonomyCandidatesResult;
}> {
  const stepsLatencyMs: number[] = [];
  const collectionsUsed: string[] = [];
  const hits: RawHit[] = [];
  const topK = searchPlan.thresholds?.top_k_chunks ?? config.lldbiTopK;
  const minScore = searchPlan.thresholds?.min_score ?? config.minScoreThreshold;

  const taxonomyResult = await getTaxonomyCandidates({
    query: goal.subquery,
    domainHint: goal.domain_hint,
    entities,
  });
  const { shapedQuery, anchorsUsed } = shapeQueryForRetrieval(
    goal.subquery,
    goal.domain_hint,
    taxonomyResult.anchor_tokens
  );
  const effective = effectiveQuery(shapedQuery);
  let vector: number[] | null = null;
  const embedStart = Date.now();
  try {
    const emb = await embedQuery(effective);
    vector = emb.embedding;
    stepsLatencyMs.push(Date.now() - embedStart);
  } catch {
    return { hits: [], actNregsForSummary: [], usedFilteredChunks: false, stepsLatencyMs, collectionsUsed, taxonomyResult };
  }
  if (!vector?.length) return { hits: [], actNregsForSummary: [], usedFilteredChunks: false, stepsLatencyMs, collectionsUsed, taxonomyResult };

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
  const rawPerStep: RawHit[] = [];
  for (const { kind, collection } of stepsToRun) {
    const stepStart = Date.now();
    try {
      const limit = kind === 'lldbi_chunks' ? topK : (searchPlan.thresholds?.top_k_acts ?? 10);
      const res = await qdrantSearch({
        collection,
        vector,
        limit,
        timeoutMs: config.qdrantTimeoutSec * 1000,
        callCounter,
      });
      stepsLatencyMs.push(Date.now() - stepStart);
      collectionsUsed.push(collection);
      for (const h of res) {
        const raw = payloadToRawHit(h, kind);
        if (raw.r2_key && raw.json_path) {
          raw.goal_id = goal.id;
          rawPerStep.push(raw);
        }
      }
    } catch {
      stepsLatencyMs.push(Date.now() - stepStart);
      collectionsUsed.push(collection);
    }
  }
  const aboveThreshold = rawPerStep.filter((h) => h.score >= minScore);
  const candidateHits = aboveThreshold.length === 0 && rawPerStep.length > 0 ? rawPerStep : aboveThreshold;
  candidateHits.sort((a, b) => b.score - a.score);
  hits.push(...dedupeHits(candidateHits));

  let topScore = hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
  const hasActCandidates =
    (taxonomyResult.rada_nreg_candidates?.length ?? 0) > 0 || stepsToRun.some((s) => s.kind === 'lldbi_acts');
  let usedFilteredChunks = false;
  const actNregsForSummary: string[] = [];

  if (hasActCandidates && stepsToRun.some((s) => s.kind === 'lldbi_acts')) {
    const actsStep = stepsToRun.find((s) => s.kind === 'lldbi_acts');
    if (actsStep) {
      try {
        const actStart = Date.now();
        const actHits = await qdrantSearch({
          collection: actsStep.collection,
          vector,
          limit: searchPlan.thresholds?.top_k_acts ?? 10,
          timeoutMs: config.qdrantTimeoutSec * 1000,
          callCounter,
        });
        stepsLatencyMs.push(Date.now() - actStart);
        const actNregs = actHits
          .map((h) => (h.payload?.rada_nreg as string)?.trim())
          .filter((n): n is string => !!n);
        actNregsForSummary.push(...actNregs);
        const taxonomyNregs = taxonomyResult.rada_nreg_candidates ?? [];
        const mergedNregs = [...new Set([...actNregs, ...taxonomyNregs])].slice(0, TWO_STAGE_ACTS_TOP);
        const topNregs = mergedNregs.length > 0 ? mergedNregs : actNregs.slice(0, TWO_STAGE_ACTS_TOP);
        if (topNregs.length > 0) {
          const chunkStart = Date.now();
          for (const nreg of topNregs) {
            const ch = await qdrantSearch({
              collection: collections.chunks,
              vector,
              limit: TWO_STAGE_CHUNKS_PER_ACT,
              filter: { must: [{ key: 'rada_nreg', match: { value: nreg } }] },
              timeoutMs: config.qdrantTimeoutSec * 1000,
              callCounter,
            });
            for (const h of ch) {
              const raw = payloadToRawHit(h, 'lldbi_chunks');
              if (raw.r2_key && raw.json_path) {
                raw.goal_id = goal.id;
                hits.push(raw);
              }
            }
          }
          stepsLatencyMs.push(Date.now() - chunkStart);
          collectionsUsed.push(`${collections.chunks}(filtered)`);
          usedFilteredChunks = true;
          const deduped = dedupeHits(hits).sort((a, b) => b.score - a.score);
          hits.length = 0;
          hits.push(...deduped);
          topScore = hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
        }
      } catch {
        // keep first-pass hits
      }
    }
  }
  if (actNregsForSummary.length === 0) actNregsForSummary.push(...(taxonomyResult.rada_nreg_candidates ?? []));

  if (hits.length > 0 && taxonomyResult.debug.source === 'supabase') {
    hits.sort(
      (a, b) =>
        hybridScore(b, goal.subquery, taxonomyResult, entities) -
        hybridScore(a, goal.subquery, taxonomyResult, entities)
    );
  }
  return { hits, actNregsForSummary, usedFilteredChunks, stepsLatencyMs, collectionsUsed, taxonomyResult };
}

const RUN_CONTEXT_TTL_SEC = 3600;

export async function runCacheRag(input: RunCacheRagInput): Promise<RunCacheRagResult> {
  const { query, searchPlan, steps, domainHint, entities, routing_flags, run_id } = input;
  const collections = getQdrantCollections();
  const qdrantCallCounter = { count: 0 };
  const allHits: RawHit[] = [];
  const stepsLatencyMs: number[] = [];
  const degraded: DegradedSources = {};
  const collectionsUsed: string[] = [];
  const stepsRequested: string[] = [];
  let usedFilteredChunksSearch = false;
  const queryVariantsUsed: string[] = [];
  let taxonomySnapshotVersion: number | null = null;

  let goalSplit = heuristicGoalSplit(query, domainHint, routing_flags ?? undefined);
  type PlannerMeta = { tier: 0 | 1 | 2; model_id?: string; duration_ms?: number; degraded?: boolean; reason_codes?: string[] };
  let plannerMeta: PlannerMeta = { tier: 0 };
  let plannerCalledThisRun = false;

  const plannerTrigger =
    run_id &&
    config.u4PlannerEnabled &&
    !isCircuitOpen() &&
    config.openRouterApiKey &&
    (goalSplit.goals.length > 1 || (!!routing_flags?.input_is_large && !!routing_flags?.input_looks_like_contract));

  if (plannerTrigger) {
    const plannerTier: 1 | 2 = goalSplit.goals.length > 1 ? 2 : 1;
    const maxTokens = plannerTier === 1 ? Math.min(256, config.u4PlannerMaxTokens) : config.u4PlannerMaxTokens;
    try {
      let plannerResult: LlmPlannerResult | null = null;
      const ctx = (await runContextGet<{ retrieval_planner_result?: LlmPlannerResult }>(run_id)) ?? null;
      if (ctx?.retrieval_planner_result) {
        plannerResult = ctx.retrieval_planner_result;
      } else {
        plannerCalledThisRun = true;
        plannerResult = await u4PlannerSemaphore.run(async () =>
          callLlmRetrievalPlanner({ query, domainHint, maxQueryChars: 3000, maxTokens })
        );
        const mergedCtx = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
        await runContextSet(run_id, { ...mergedCtx, retrieval_planner_result: plannerResult } as Record<string, unknown>, RUN_CONTEXT_TTL_SEC);
      }
      if (plannerResult?.goals?.length) {
        goalSplit = {
          goals: plannerResult.goals,
          used_heuristic: goalSplit.used_heuristic,
          used_llm_planner: true,
          reason_codes: [...goalSplit.reason_codes, ...(plannerResult.reason_codes ?? [])],
        };
        plannerMeta = {
          tier: plannerTier,
          model_id: plannerResult.model_id,
          duration_ms: plannerResult.duration_ms,
          degraded: plannerResult.degraded,
          reason_codes: plannerResult.reason_codes,
        };
      } else {
        plannerMeta = { tier: plannerTier, degraded: true, reason_codes: ['PLANNER_NO_GOALS'] };
      }
    } catch (err) {
      recordLlmFailure();
      const reason = err instanceof Error && /429|rate\s*limit/i.test(err.message) ? 'PLANNER_RATE_LIMIT' : 'PLANNER_FAILED';
      plannerMeta = { tier: plannerTier, degraded: true, reason_codes: [reason] };
      goalSplit = {
        ...goalSplit,
        reason_codes: [...goalSplit.reason_codes, reason],
      };
    }
  }

  const isMultiGoal = goalSplit.goals.length > 1;

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
        qdrant_calls_count_total: 0,
        hits_total_before_cap: 0,
        hits_total_after_cap: 0,
        hits_cap_applied: false,
      },
    };
    return { rawHits: [], retrievalTrace: trace };
  }

  // Multi-goal path: per-goal retrieval → merge → coverage fusion → diversity cap
  if (isMultiGoal) {
    const multiHits: RawHit[] = [];
    const goalsSummary: Array<{
      goal_id: string;
      goal_type?: string;
      subquery_preview?: string;
      used_llm_planner?: boolean;
      act_candidates_top3?: string[];
      hits_count?: number;
      top_score?: number | null;
    }> = [];
    const allCollectionsUsed: string[] = [];
    let totalLatencyMulti = 0;
    for (const goal of goalSplit.goals) {
      const one = await runOneGoal(goal, entities, searchPlan, steps, collections, qdrantCallCounter);
      for (const h of one.hits) multiHits.push(h);
      allCollectionsUsed.push(...one.collectionsUsed);
      totalLatencyMulti += one.stepsLatencyMs.reduce((a, b) => a + b, 0);
      const top3Nregs = [...new Set([...one.actNregsForSummary, ...(one.taxonomyResult.rada_nreg_candidates ?? [])])].slice(0, 3);
      goalsSummary.push({
        goal_id: goal.id,
        goal_type: goal.goal_type,
        subquery_preview: goal.subquery.slice(0, 200),
        used_llm_planner: goalSplit.used_llm_planner,
        act_candidates_top3: top3Nregs,
        hits_count: one.hits.length,
        top_score: one.hits.length > 0 ? Math.max(...one.hits.map((h) => h.score)) : null,
      });
    }
    const mergedMulti = dedupeHits(multiHits);
    const fused = applyCoverageFusion(
      mergedMulti,
      goalSplit.goals,
      config.u4FusionTopN,
      config.u4FusionMinHitsPerGoal
    );
    const topNForCounts = Math.min(config.u4FusionTopN, fused.length);
    const perGoalCountsInTopN: Record<string, number> = {};
    for (const g of goalSplit.goals) perGoalCountsInTopN[g.id] = 0;
    for (let i = 0; i < topNForCounts; i++) {
      const gid = fused[i].goal_id ?? '_single';
      perGoalCountsInTopN[gid] = (perGoalCountsInTopN[gid] ?? 0) + 1;
    }
    const noiseResultMulti = applyNoisePenalty(fused, config.u4FusionTopN);
    const cappedMulti = applyDiversityCap(noiseResultMulti.hits);
    const fusedAfterNoise = noiseResultMulti.hits;
    const hitsTotalBeforeCapMulti = cappedMulti.length;
    const finalMulti = config.u4HitsCap > 0 ? cappedMulti.slice(0, config.u4HitsCap) : cappedMulti;
    const hitsCapAppliedMulti = config.u4HitsCap > 0 && hitsTotalBeforeCapMulti > config.u4HitsCap;
    const topScoreMulti = finalMulti.length > 0 ? Math.max(...finalMulti.map((h) => h.score)) : null;
    const multiTrace: RetrievalTrace = {
      version: 1,
      hits: finalMulti,
      top_score: topScoreMulti,
      latency_ms: totalLatencyMulti,
      degraded_sources: Object.keys(degraded).length ? degraded : undefined,
      meta: {
        collections_used: [...new Set(allCollectionsUsed)],
        steps_latency_ms: [],
        steps_requested: ['multi_goal'],
        steps_executed: ['multi_goal'],
        query_used: query.slice(0, 200),
        hits_count: finalMulti.length,
        hits_total_before_cap: hitsTotalBeforeCapMulti,
        hits_total_after_cap: finalMulti.length,
        hits_cap_applied: hitsCapAppliedMulti,
        topN_used_for_distribution: config.u4FusionTopN,
        scores_computed_on: 'final_hits_after_cap_and_guards',
        avg_score_source: 'final_hits_after_cap_and_guards',
        goals_summary: goalsSummary,
        fusion: {
          coverage_enforced: true,
          per_goal_min_hits: config.u4FusionMinHitsPerGoal,
          topN: config.u4FusionTopN,
          per_goal_counts_in_topN: Object.keys(perGoalCountsInTopN).length > 0 ? perGoalCountsInTopN : undefined,
        },
        distribution:
          noiseResultMulti.penaltyCount > 0 ||
          noiseResultMulti.guardBlockedCount > 0
            ? {
                noise_penalty_applied_count: noiseResultMulti.penaltyCount,
                noise_penalty_policy_version: NOISE_PENALTY_POLICY_VERSION,
                noise_penalty_guard_blocked: noiseResultMulti.guardBlockedCount > 0,
                noise_penalty_guard_reason_codes:
                  noiseResultMulti.guardReasonCodes.length > 0 ? noiseResultMulti.guardReasonCodes : undefined,
              }
            : undefined,
        stage_decisions: {
          used_goal_splitter: true,
          used_llm_planner: goalSplit.used_llm_planner,
          per_goal_act_retrieval: true,
          used_global_fallback: false,
        },
        reason_codes: goalSplit.reason_codes.length ? goalSplit.reason_codes : undefined,
        qdrant_calls_count_total: qdrantCallCounter.count,
        planner: {
          tier_selected: plannerMeta.tier,
          called: plannerCalledThisRun,
          call_failed_reason: plannerMeta.reason_codes?.[0],
          tier: plannerMeta.tier,
          model_id: plannerMeta.model_id,
          duration_ms: plannerMeta.duration_ms,
          degraded: plannerMeta.degraded,
          reason_codes: plannerMeta.reason_codes,
        },
        retrieval_debug_bundle: {
          per_goal_act_candidates_top: goalsSummary.map((g) => ({
            goal_id: g.goal_id,
            act_candidates_top3: g.act_candidates_top3,
            hits_count: g.hits_count,
          })),
          stages: [{ stage: 'multi_goal', qdrant_calls_count: qdrantCallCounter.count, time_ms: totalLatencyMulti }],
          distribution_by_goal: goalsSummary.map((g) => ({ goal_id: g.goal_id, hits_count: g.hits_count ?? 0 })),
        },
      },
    };
    return { rawHits: finalMulti, retrievalTrace: multiTrace };
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
        qdrant_calls_count_total: 0,
        hits_total_before_cap: 0,
        hits_total_after_cap: 0,
        hits_cap_applied: false,
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
        qdrant_calls_count_total: 0,
        hits_total_before_cap: 0,
        hits_total_after_cap: 0,
        hits_cap_applied: false,
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
        callCounter: qdrantCallCounter,
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
          callCounter: qdrantCallCounter,
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
              callCounter: qdrantCallCounter,
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

  // Anti-noise: demote "Окрема думка" / "порядок торгівлі" etc. for ordering (with guard)
  const noiseResultSingle = applyNoisePenalty(allHits, config.u4FusionTopN);
  allHits.length = 0;
  allHits.push(...noiseResultSingle.hits);

  // Diversity cap: limit same-act dominance in top N
  const capped = applyDiversityCap(allHits);
  allHits.length = 0;
  allHits.push(...capped);

  const totalLatency = stepsLatencyMs.reduce((a, b) => a + b, 0);
  const hitsTotalBeforeCapSingle = allHits.length;
  const finalHits = config.u4HitsCap > 0 ? allHits.slice(0, config.u4HitsCap) : allHits;
  const hitsCapAppliedSingle = config.u4HitsCap > 0 && hitsTotalBeforeCapSingle > config.u4HitsCap;
  const avgScore =
    finalHits.length > 0 ? finalHits.reduce((s, h) => s + h.score, 0) / finalHits.length : undefined;

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

  // Distribution: hits by act in top 3 acts (by hit count in top 30 of returned list)
  const top30 = finalHits.slice(0, 30);
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
    const fromAct = finalHits.filter((h) => (h.rada_nreg ?? '_unknown') === nreg);
    hitsByActTop3[nreg] = fromAct.length;
    avgScoreByActTop3[nreg] =
      fromAct.length > 0
        ? fromAct.reduce((s, h) => s + h.score, 0) / fromAct.length
        : 0;
  }

  const reasonCodes: string[] = [];
  if (useLowConfidenceFallback) reasonCodes.push('low_confidence_fallback');

  const sampleHits = finalHits.slice(0, 5).map((h) => ({
    source: h.source,
    score: h.score,
    r2_key: h.r2_key,
    json_path: h.json_path,
    act_title: h.title,
    article_ref: h.article_number ?? null,
  }));

  const retrievalTrace: RetrievalTrace = {
    version: 1,
    hits: finalHits,
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
      hits_count: finalHits.length,
      hits_total_before_cap: hitsTotalBeforeCapSingle,
      hits_total_after_cap: finalHits.length,
      hits_cap_applied: hitsCapAppliedSingle,
      topN_used_for_distribution: config.u4FusionTopN,
      scores_computed_on: 'final_hits_after_cap_and_guards',
      avg_score_source: 'final_hits_after_cap_and_guards',
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
        used_goal_splitter: true,
        used_llm_planner: goalSplit.used_llm_planner,
        per_goal_act_retrieval: false,
        used_global_fallback: useLowConfidenceFallback,
      },
      goals_summary: [
        {
          goal_id: goalSplit.goals[0].id,
          goal_type: goalSplit.goals[0].goal_type,
          subquery_preview: goalSplit.goals[0].subquery.slice(0, 200),
          used_llm_planner: goalSplit.used_llm_planner,
          act_candidates_top3: top5Nregs.slice(0, 3),
          hits_count: finalHits.length,
          top_score: topScore,
        },
      ],
      distribution:
        Object.keys(hitsByActTop3).length > 0 ||
        noiseResultSingle.penaltyCount > 0 ||
        noiseResultSingle.guardBlockedCount > 0
          ? {
              hits_by_act_top3: Object.keys(hitsByActTop3).length > 0 ? hitsByActTop3 : undefined,
              avg_score_by_act_top3: Object.keys(avgScoreByActTop3).length > 0 ? avgScoreByActTop3 : undefined,
              noise_penalty_applied_count: noiseResultSingle.penaltyCount > 0 ? noiseResultSingle.penaltyCount : undefined,
              noise_penalty_policy_version: NOISE_PENALTY_POLICY_VERSION,
              noise_penalty_guard_blocked: noiseResultSingle.guardBlockedCount > 0,
              noise_penalty_guard_reason_codes:
                noiseResultSingle.guardReasonCodes.length > 0 ? noiseResultSingle.guardReasonCodes : undefined,
            }
          : undefined,
      reason_codes: reasonCodes.length ? reasonCodes : undefined,
      qdrant_calls_count_total: qdrantCallCounter.count,
      planner: {
        tier_selected: plannerMeta.tier,
        called: plannerCalledThisRun,
        call_failed_reason: plannerMeta.reason_codes?.[0],
        tier: plannerMeta.tier,
        model_id: plannerMeta.model_id,
        duration_ms: plannerMeta.duration_ms,
        degraded: plannerMeta.degraded,
        reason_codes: plannerMeta.reason_codes,
      },
      retrieval_debug_bundle: {
        per_goal_act_candidates_top: actCandidatesTop.map((a) => ({ rada_nreg: a.rada_nreg, title: a.title, score: a.score })),
        stages: (collectionsUsed.length ? collectionsUsed : ['lldbi_chunks', 'lldbi_acts']).map((stage, i) => ({
          stage: String(stage),
          qdrant_calls_count: 1,
          time_ms: stepsLatencyMs[i] ?? 0,
        })),
        distribution_by_act: Object.keys(hitsByActTop3).length > 0 ? hitsByActTop3 : undefined,
        distribution_by_goal: [{ goal_id: goalSplit.goals[0].id, hits_count: finalHits.length }],
      },
    },
  };

  return { rawHits: finalHits, retrievalTrace };
}
