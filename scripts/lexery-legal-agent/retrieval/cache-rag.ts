/**
 * U4 CacheRAG runner (LEX-114, LEX-117) — run retrieval from SearchPlan/steps, produce RawHits + RetrievalTrace.
 * Data-driven: ActTaxonomyStore for anchors/candidates; no score-filter-to-zero; two-stage merges taxonomy + acts.
 * Multi-goal: heuristic goal split → per-goal retrieval → coverage fusion + diversity cap.
 */
import type { SearchPlan, SearchStep } from '../plan/types.js';
import type { RawHit, RetrievalTrace, DegradedSources } from './types.js';
import type { RoutingFlags } from '../classify/types.js';
import type { EvidenceGoal } from './goals.js';
import { embedMany, embedQuery } from './embedding.js';
import { qdrantSearch, getQdrantCollections } from './qdrant-client.js';
import { config } from '../lib/config.js';
import { shapeQueryForRetrieval } from './query-shaping.js';
import {
  heuristicGoalSplit,
  tryCategoryClusterSplitV2,
  getProcedureCategoryEnvelope,
  isProcedureCategory,
} from './goal-splitter.js';
import { callLlmRetrievalPlanner, type LlmPlannerResult } from './llm-planner.js';
import {
  selectActPlannerTier,
  callActPlanner,
  type ActPlannerOutput,
  type TaxonomySnapshotSummary,
} from './act-planner.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import { Semaphore } from '../lib/semaphore.js';
import { isCircuitOpen, recordLlmFailure } from '../classify/circuit-breaker.js';
import {
  getTaxonomyCandidates,
  getActMeta,
  findActByTitleFragment,
  findActByAlias,
  type TaxonomyCandidatesResult,
  type TaxonomyHintsUsed,
} from './act-taxonomy-store.js';
import { rankActCandidates } from './act-candidate-ranking.js';
import { getFragmentFromR2 } from './r2-fragment.js';
import { expandReferences, type ReferenceExpansionMeta } from './reference-expander.js';
import {
  buildSelectedActs,
  computeChunksEvidenceTopActs,
  classifyActKind,
  SELECTED_ACTS_MAX_OUT,
  type SelectedActOutput,
} from './selected-acts.js';
import { computeFamilyEvidence, toFamilyEvidenceSummary } from './family-evidence.js';
import {
  shouldCallRoutingHints,
  callRoutingHints,
  type RoutingHintsTriggers,
  type RoutingHintsInput,
} from './routing-hints-llm.js';
import { runQueryRewritePhase } from './query-rewrite-phase.js';
import { runArticleBackfill } from './article-backfill.js';
import { fetchRecentMemory } from './memory-store.js';
import { rrfMerge } from './rrf-merge.js';
import { buildGroundedRetrievalQuery } from './grounded-query-builder.js';
import {
  incrementU4RoutingHintsNotUsed,
  incrementU4RoutingHintsUsed,
  incrementU4DomainBootstrapAttempted,
  incrementU4DomainBootstrapUsed,
  incrementU4DomainBootstrapConflict,
} from '../gateway/observability.js';
import {
  applyCoverageFusion,
  applyDiversityCap,
  applyHybridOrdering,
  applyNoisePenalty,
  compareRawHitByScore,
  dedupeHits,
  NOISE_PENALTY_POLICY_VERSION,
} from './hit-ranking.js';
import { buildWithinActPool, extractActSearchNregsFromHits } from './within-act-pool.js';
import { decideWithinActExpansion } from './within-act-expansion-policy.js';
import { buildSampleHits, payloadToRawHit } from './raw-hit-helpers.js';
import { finalizeSelectedActsAfterRouting } from './selected-acts-finalizer.js';
import { extractQueryCitationSelectors } from './structural-citation.js';

const u4PlannerSemaphore = new Semaphore(config.u4PlannerConcurrency);

/** Compact lldbi hints usage for trace meta (audit). */
function toLldbiHintsUsed(
  hu: TaxonomyHintsUsed | undefined
): { categories_used_count: number; doc_types_used_count: number; injected_acts_count: number } | undefined {
  if (!hu) return undefined;
  const categories_used_count = hu.categories_used?.length ?? 0;
  const doc_types_used_count = hu.document_types_used?.length ?? 0;
  const injected_acts_count =
    (hu.injected_counts?.by_category_hints ?? 0) + (hu.injected_counts?.by_doc_type_hints ?? 0);
  if (categories_used_count === 0 && doc_types_used_count === 0 && injected_acts_count === 0) return undefined;
  return { categories_used_count, doc_types_used_count, injected_acts_count };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

async function prioritizeProcedureActs(nregs: string[]): Promise<string[]> {
  if (nregs.length <= 1) return nregs;
  const metas = await Promise.all(nregs.map((nreg) => getActMeta(nreg)));
  const aligned: string[] = [];
  const other: string[] = [];
  for (let index = 0; index < nregs.length; index += 1) {
    if (isProcedureCategory(metas[index]?.category)) aligned.push(nregs[index]);
    else other.push(nregs[index]);
  }
  return [...aligned, ...other];
}

/**
 * Hydrate selected_acts with complete LLDBI metadata (document_type, category, storage_category, act_kind).
 * O(1) per act via ActTaxonomyStore.getActMeta cache; NEVER hardcodes enums beyond UNKNOWN.
 */
async function hydrateSelectedActsMeta(
  acts: SelectedActOutput[],
  confidence: number | undefined
): Promise<
  Array<{
    rada_nreg: string;
    act_title?: string;
    score?: number;
    why_selected?: string;
    reason_tag?: string;
    source_tags?: string[];
    document_type?: string | null;
    category?: string | null;
    storage_category?: string | null;
    act_kind?: string;
    flags?: SelectedActOutput['flags'];
    confidence?: number;
  }>
> {
  const out: Array<{
    rada_nreg: string;
    act_title?: string;
    score?: number;
    why_selected?: string;
    reason_tag?: string;
    source_tags?: string[];
    document_type?: string | null;
    category?: string | null;
    storage_category?: string | null;
    act_kind?: string;
    flags?: SelectedActOutput['flags'];
    confidence?: number;
  }> = [];

  for (const a of acts) {
    let document_type: string | null | undefined = a.document_type;
    let category: string | null | undefined = a.category;
    let storage_category: string | null | undefined = a.storage_category;
    let act_kind = a.act_kind;

    if (!document_type || !category || storage_category == null || !act_kind || act_kind === 'UNKNOWN') {
      const meta = await getActMeta(a.rada_nreg);
      if (meta) {
        const m = meta as { document_type?: string | null; category?: string | null; storage_category?: string | null; title?: string };
        if (!document_type) document_type = m.document_type ?? null;
        if (!category) category = m.category ?? null;
        if (storage_category == null) storage_category = m.storage_category ?? null;
        if (!act_kind || act_kind === 'UNKNOWN') {
          act_kind = classifyActKind(m.title ?? a.act_title ?? '', m.document_type, m.category);
        }
      } else {
        if (storage_category == null) storage_category = null;
        if (!act_kind) act_kind = 'UNKNOWN';
      }
    }

    out.push({
      rada_nreg: a.rada_nreg,
      act_title: a.act_title,
      score: a.score,
      why_selected: a.why_selected,
      reason_tag: a.reason_tag,
      source_tags: a.source_tags,
      document_type,
      category,
      storage_category,
      act_kind,
      flags: a.flags,
      confidence,
    });
  }

  return out;
}

type CandidateMetaHydratable = {
  rada_nreg: string;
  title?: string;
  category?: string;
  document_type?: string;
};

async function hydrateActCandidatesMeta<T extends CandidateMetaHydratable>(candidates: T[]): Promise<T[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.title && candidate.category && candidate.document_type) return candidate;
      const meta = await getActMeta(candidate.rada_nreg);
      if (!meta) return candidate;
      return {
        ...candidate,
        title: candidate.title ?? meta.title ?? undefined,
        category: candidate.category ?? meta.category ?? undefined,
        document_type: candidate.document_type ?? meta.document_type ?? undefined,
      } satisfies T;
    })
  );
}

type EvidenceActLike = { rada_nreg: string };

async function backfillChunkEvidenceCandidates<
  T extends CandidateMetaHydratable & {
    score?: number;
    reasons?: string[];
    why_tag?: string;
    source_tier?: 'ACTS_1' | 'ACTS_2';
  },
>(candidates: T[], evidenceActs: EvidenceActLike[]): Promise<T[]> {
  const existing = new Set(candidates.map((candidate) => candidate.rada_nreg));
  const missingNregs = [...new Set(evidenceActs.map((act) => act.rada_nreg).filter((nreg) => !existing.has(nreg)))];
  if (missingNregs.length === 0) return hydrateActCandidatesMeta(candidates);

  const additions = await Promise.all(
    missingNregs.map(async (rada_nreg) => {
      const meta = await getActMeta(rada_nreg);
      return {
        rada_nreg,
        title: meta?.title ?? undefined,
        category: meta?.category ?? undefined,
        document_type: meta?.document_type ?? undefined,
        score: 0,
        reasons: ['chunks_evidence_meta'],
        why_tag: 'CHUNKS_EVIDENCE_META',
        source_tier: 'ACTS_1' as const,
      } satisfies T;
    })
  );

  return hydrateActCandidatesMeta([...candidates, ...additions]);
}

/** Domain hint is weak when absent or generic/unknown (no strong signal for category injection). */
function isDomainWeak(domainHint: string | undefined): boolean {
  if (!domainHint || !domainHint.trim()) return true;
  const k = domainHint.normalize('NFC').toLowerCase().replace(/\s+/g, '_').trim();
  return k === 'general' || k === 'unknown' || k === '';
}

/** Domain bootstrap: from top act hits build category histogram; if clear leader, return effective_domain_hint (evidence-based, no wordlists). */
const DOMAIN_BOOTSTRAP_ACT_LIMIT = 20;
const DOMAIN_BOOTSTRAP_MIN_SUPPORT = 2;
const DOMAIN_BOOTSTRAP_MIN_GAP = 1;

export type DomainBootstrapResult = {
  attempted: boolean;
  used: boolean;
  chosen_family_key?: string;
  top_categories?: string[];
  reason_codes: string[];
};

async function domainBootstrapFromActHits(
  actHits: { payload?: Record<string, unknown> }[]
): Promise<DomainBootstrapResult> {
  const reasonCodes: string[] = [];
  const radaNregs = actHits
    .map((h) => (h.payload?.rada_nreg as string)?.trim())
    .filter((n): n is string => !!n);
  if (radaNregs.length === 0) {
    reasonCodes.push('NO_ACT_HITS');
    return { attempted: true, used: false, reason_codes: reasonCodes };
  }
  const categoryCount = new Map<string, number>();
  for (const nreg of radaNregs) {
    const meta = await getActMeta(nreg);
    const cat = meta?.category?.trim();
    if (cat) {
      const key = cat.normalize('NFC').toLowerCase().replace(/\s+/g, '_').trim();
      categoryCount.set(key, (categoryCount.get(key) ?? 0) + 1);
    }
  }
  const sorted = [...categoryCount.entries()].sort((a, b) => b[1] - a[1]);
  const top1 = sorted[0];
  const top2 = sorted[1];
  if (!top1 || top1[1] < DOMAIN_BOOTSTRAP_MIN_SUPPORT) {
    reasonCodes.push('LOW_SUPPORT');
    return { attempted: true, used: false, top_categories: sorted.map(([c]) => c), reason_codes: reasonCodes };
  }
  const gap = top2 ? top1[1] - top2[1] : top1[1];
  if (gap < DOMAIN_BOOTSTRAP_MIN_GAP) {
    reasonCodes.push('CONFLICT');
    incrementU4DomainBootstrapConflict();
    return { attempted: true, used: false, top_categories: sorted.map(([c]) => c), reason_codes: reasonCodes };
  }
  return {
    attempted: true,
    used: true,
    chosen_family_key: top1[0],
    top_categories: sorted.map(([c]) => c),
    reason_codes: reasonCodes.length ? reasonCodes : ['CLEAR_LEADER'],
  };
}

const QUERY_MAX_CHARS = 12000;
/** Hybrid re-score weights (no extra LLM). Vector remains primary. */
const W_VEC = 0.44;
const W_ALIAS = 0.15;
const W_ARTICLE = 0.15;
const W_CATEGORY = 0.05;
const W_STRUCTURAL = 0.3;
const MIN_HITS_FOR_TWO_STAGE = 3;
const GOOD_SCORE_THRESHOLD = 0.4;
const TWO_STAGE_ACTS_TOP = 5;
/** selected_acts cap: single-goal high confidence. */
const SELECTED_ACTS_CAP_HIGH = 3;
/** selected_acts cap: single-goal low confidence (wider to reduce miss). */
const SELECTED_ACTS_CAP_LOW = 7;
/** Max selected_acts / act_candidates_top length (harness invariant ≤9). */
const SELECTED_ACTS_MAX = 9;
/** Chunks per act in within-act retrieval (so relevant article can appear within each act). */
const TWO_STAGE_CHUNKS_PER_ACT = 35;
/** Multi-goal retrieval gets a slightly wider per-act chunk budget because each goal is narrower. */
const TWO_STAGE_CHUNKS_PER_ACT_MULTI_GOAL = 50;

function effectiveQuery(query: string): string {
  const t = query.trim();
  if (t.length <= QUERY_MAX_CHARS) return t;
  const head = t.slice(0, 6000);
  const tail = t.slice(-6000);
  return head + '\n...[truncated]...\n' + tail;
}

async function fetchFilteredChunkHitsByActs(params: {
  radaNregs: string[];
  vector: number[];
  collection: string;
  limit: number;
  timeoutMs: number;
  callCounter?: { count: number };
  goalId?: string;
}): Promise<RawHit[]> {
  const settled = await Promise.allSettled(
    params.radaNregs.map(async (radaNreg) => {
      const hits = await qdrantSearch({
        collection: params.collection,
        vector: params.vector,
        limit: params.limit,
        filter: { must: [{ key: 'rada_nreg', match: { value: radaNreg } }] },
        timeoutMs: params.timeoutMs,
        callCounter: params.callCounter,
      });
      return hits
        .map((hit) => payloadToRawHit(hit, 'lldbi_chunks'))
        .filter((raw) => raw.r2_key && raw.json_path)
        .map((raw) => ({
          ...raw,
          ...(params.goalId ? { goal_id: params.goalId } : {}),
        }));
    })
  );
  const rawHits: RawHit[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') rawHits.push(...result.value);
  }
  return rawHits;
}

export interface RunCacheRagInput {
  query: string;
  searchPlan: SearchPlan;
  steps?: SearchStep[];
  /** Optional domain from query_profile (hint only; no hardcoded mapping). */
  domainHint?: string;
  /** Optional U2 lldbi routing: categories_ranked_top3, document_types_ranked_top3 → taxonomy hints. */
  lldbi?: { categories_ranked_top3?: string[]; document_types_ranked_top3?: string[] } | null;
  /** Optional U2 entities for taxonomy scoring (act_abbrev, article_ref). */
  entities?: { act_abbrev?: string; article_ref?: string }[];
  /** Optional routing flags for multi-goal (contract/table/large input). */
  routing_flags?: RoutingFlags | null;
  /** Optional run_id for caching LLM planner result in RunContext. */
  run_id?: string;
  /** Multi-tenant memory isolation: required for mm_memory_items fetch. */
  tenant_id?: string | null;
  /** User-scoped memory: required for mm_memory_items fetch. */
  user_id?: string;
  /** Conversation for conversation-scoped memory (primary path). */
  conversation_id?: string | null;
}

export interface RunCacheRagResult {
  rawHits: RawHit[];
  retrievalTrace: RetrievalTrace;
  /** Memory refs fetched from mm_memory_items for downstream (U9 Assemble). Empty if memory disabled/unavailable. */
  memoryRefs?: import('../assemble/types.js').MemoryRef[];
  /** Memory summaries for RunContext.memory_summaries (from mm_summaries / fetchRecentMemory). */
  memorySummaries?: Array<{ scope?: string; summary_text: string }>;
  /** Compact memory trace for RunContext (degraded, counts, latency, sources, scope). */
  memoryTrace?: {
    degraded?: boolean;
    recent_count?: number;
    semantic_count?: number;
    latency_ms?: number;
    sources_used?: string[];
    reason_codes?: string[];
    scope_primary?: 'conversation' | 'user_global';
    scope_fallback_used?: boolean;
    conversation_recent_count?: number;
    conversation_semantic_count?: number;
    global_recent_count?: number;
    global_semantic_count?: number;
    fallback_conversation_ids?: string[];
  };
}

/** Single-goal retrieval: embed + taxonomy + optional domain bootstrap + steps + within-act + hybrid sort. Returns hits with goal_id set. */
async function runOneGoal(
  goal: EvidenceGoal,
  entities: { act_abbrev?: string; article_ref?: string }[] | undefined,
  searchPlan: SearchPlan,
  steps: SearchStep[] | undefined,
  collections: { chunks: string; acts: string },
  callCounter?: { count: number },
  lldbiHints?: { categoryHints: string[]; documentTypeHints: string[] }
): Promise<{
  hits: RawHit[];
  actNregsForSummary: string[];
  usedFilteredChunks: boolean;
  stepsLatencyMs: number[];
  collectionsUsed: string[];
  taxonomyResult: TaxonomyCandidatesResult;
  domainBootstrap?: DomainBootstrapResult;
}> {
  const stepsLatencyMs: number[] = [];
  const collectionsUsed: string[] = [];
  const hits: RawHit[] = [];
  const topK = searchPlan.thresholds?.top_k_chunks ?? config.lldbiTopK;
  const minScore = searchPlan.thresholds?.min_score ?? config.minScoreThreshold;
  const goalCategoryHints = uniqueStrings([
    ...(lldbiHints?.categoryHints ?? []),
    ...(goal.required_categories ?? []),
    ...(goal.goal_type === 'procedure'
      ? getProcedureCategoryEnvelope([...(lldbiHints?.categoryHints ?? []), ...(goal.required_categories ?? [])])
      : []),
  ]);

  let taxonomyResult = await getTaxonomyCandidates({
    query: goal.subquery,
    domainHint: goal.domain_hint,
    categoryHints: goalCategoryHints,
    documentTypeHints: lldbiHints?.documentTypeHints,
    entities,
  });
  if (goal.required_categories?.length && taxonomyResult.alias_hits?.length) {
    const allowedNregs = new Set(
      taxonomyResult.alias_hits
        .filter((h) => h.category && goal.required_categories!.includes(h.category))
        .map((h) => h.rada_nreg)
    );
    if (allowedNregs.size > 0) {
      taxonomyResult = {
        ...taxonomyResult,
        rada_nreg_candidates: taxonomyResult.rada_nreg_candidates.filter((n) => allowedNregs.has(n)),
      };
    }
  }
  if (goal.goal_type === 'procedure' && taxonomyResult.rada_nreg_candidates.length > 1) {
    taxonomyResult = {
      ...taxonomyResult,
      rada_nreg_candidates: await prioritizeProcedureActs(taxonomyResult.rada_nreg_candidates),
    };
  }
  const groundedGoalQuery = buildGroundedRetrievalQuery({
    subquery: goal.subquery,
    mustHaveSignals: goal.must_have_signals,
  });
  const { shapedQuery, anchorsUsed } = shapeQueryForRetrieval(
    groundedGoalQuery.queryForRetrieval,
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

  let domainBootstrap: DomainBootstrapResult | undefined;
  let bootstrapActNregs: string[] = [];
  const domainWeak = isDomainWeak(goal.domain_hint);
  const taxonomyCandidatesWeak = (taxonomyResult.rada_nreg_candidates?.length ?? 0) < 2;
  if (domainWeak && taxonomyCandidatesWeak && callCounter && callCounter.count < 25) {
    incrementU4DomainBootstrapAttempted();
    try {
      const actStart = Date.now();
      const actHits = await qdrantSearch({
        collection: collections.acts,
        vector,
        limit: DOMAIN_BOOTSTRAP_ACT_LIMIT,
        timeoutMs: config.qdrantTimeoutSec * 1000,
        callCounter,
      });
      stepsLatencyMs.push(Date.now() - actStart);
      collectionsUsed.push(collections.acts);
      domainBootstrap = await domainBootstrapFromActHits(actHits);
      bootstrapActNregs = actHits
        .map((h) => (h.payload?.rada_nreg as string)?.trim())
        .filter((n): n is string => !!n);
      if (domainBootstrap.used && domainBootstrap.chosen_family_key) {
        incrementU4DomainBootstrapUsed();
        taxonomyResult = await getTaxonomyCandidates({
          query: goal.subquery,
          domainHint: domainBootstrap.chosen_family_key,
          categoryHints: goalCategoryHints,
          documentTypeHints: lldbiHints?.documentTypeHints,
          entities,
        });
        if (goal.goal_type === 'procedure' && taxonomyResult.rada_nreg_candidates.length > 1) {
          taxonomyResult = {
            ...taxonomyResult,
            rada_nreg_candidates: await prioritizeProcedureActs(taxonomyResult.rada_nreg_candidates),
          };
        }
      }
    } catch {
      domainBootstrap = { attempted: true, used: false, reason_codes: ['ACTS_SEARCH_FAILED'] };
    }
  }

  const stepsToRun: Array<{ kind: 'lldbi_chunks' | 'lldbi_acts'; collection: string }> = [];
  if (steps?.length) {
    for (const s of steps) {
      if (s.kind === 'lldbi_chunks') stepsToRun.push({ kind: 'lldbi_chunks', collection: collections.chunks });
      else if (s.kind === 'lldbi_acts' && bootstrapActNregs.length === 0)
        stepsToRun.push({ kind: 'lldbi_acts', collection: collections.acts });
    }
  }
  if (stepsToRun.length === 0) {
    stepsToRun.push({ kind: 'lldbi_chunks', collection: collections.chunks });
    if (bootstrapActNregs.length === 0) stepsToRun.push({ kind: 'lldbi_acts', collection: collections.acts });
  }
  const rawPerStep: RawHit[] = [];
  const stepResults = await Promise.allSettled(
    stepsToRun.map(async ({ kind, collection }) => {
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
        const rawHits = res
          .map((hit) => payloadToRawHit(hit, kind))
          .filter((raw) => raw.r2_key && raw.json_path)
          .map((raw) => ({
            ...raw,
            goal_id: goal.id,
          }));
        return {
          collection,
          latencyMs: Date.now() - stepStart,
          rawHits,
        };
      } catch {
        return {
          collection,
          latencyMs: Date.now() - stepStart,
          rawHits: [] as RawHit[],
        };
      }
    })
  );
  for (const result of stepResults) {
    if (result.status !== 'fulfilled') continue;
    stepsLatencyMs.push(result.value.latencyMs);
    collectionsUsed.push(result.value.collection);
    rawPerStep.push(...result.value.rawHits);
  }
  const aboveThreshold = rawPerStep.filter((h) => h.score >= minScore);
  const candidateHits = aboveThreshold.length === 0 && rawPerStep.length > 0 ? rawPerStep : aboveThreshold;
  candidateHits.sort(compareRawHitByScore);
  hits.push(...dedupeHits(candidateHits));

  let topScore = hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
  const hasActCandidates =
    (taxonomyResult.rada_nreg_candidates?.length ?? 0) > 0 ||
    bootstrapActNregs.length > 0 ||
    stepsToRun.some((s) => s.kind === 'lldbi_acts');
  let usedFilteredChunks = false;
  const actNregsForSummary: string[] = [];

  const taxonomyCandidatesNregs = taxonomyResult.rada_nreg_candidates ?? [];
  const actNregsFromStep = extractActSearchNregsFromHits(rawPerStep);
  const topNregs = buildWithinActPool({
    taxonomyNregs: taxonomyCandidatesNregs,
    actSearchNregs: actNregsFromStep,
    bootstrapActNregs,
    categoryHintCount: lldbiHints?.categoryHints.length ?? 0,
    limit: TWO_STAGE_ACTS_TOP,
  });

  if (hasActCandidates && topNregs.length > 0) {
    try {
      actNregsForSummary.push(...topNregs);
      const chunkStart = Date.now();
      const filteredHits = await fetchFilteredChunkHitsByActs({
        radaNregs: topNregs,
        vector,
        collection: collections.chunks,
        limit: TWO_STAGE_CHUNKS_PER_ACT_MULTI_GOAL,
        timeoutMs: config.qdrantTimeoutSec * 1000,
        callCounter,
        goalId: goal.id,
      });
      hits.push(...filteredHits);
      stepsLatencyMs.push(Date.now() - chunkStart);
      collectionsUsed.push(`${collections.chunks}(filtered)`);
      usedFilteredChunks = true;
      const deduped = dedupeHits(hits).sort(compareRawHitByScore);
      hits.length = 0;
      hits.push(...deduped);
      topScore = hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
    } catch {
      // keep first-pass hits
    }
  }
  if (actNregsForSummary.length === 0) actNregsForSummary.push(...(taxonomyResult.rada_nreg_candidates ?? []));

  if (hits.length > 0 && taxonomyResult.debug.source === 'supabase') {
    applyHybridOrdering(hits, effective, taxonomyResult, entities);
  }
  return { hits, actNregsForSummary, usedFilteredChunks, stepsLatencyMs, collectionsUsed, taxonomyResult, domainBootstrap };
}

const RUN_CONTEXT_TTL_SEC = 3600;

/** Single finalization: fetch memory and build meta. Ensures retrieval_trace.meta.memory always exists when memory enabled. */
async function fetchMemoryForRun(params: {
  query: string;
  user_id: string | undefined;
  tenant_id: string | null;
  run_id: string | undefined;
  conversation_id?: string | null;
}): Promise<{
  memoryRefs: import('../assemble/types.js').MemoryRef[];
  memorySummaries: Array<{ scope?: string; summary_text: string }>;
  memoryTraceCompact: RunCacheRagResult['memoryTrace'];
  memoryMeta: { enabled: boolean; semantic_enabled: boolean; recent_count: number; semantic_count: number; degraded?: boolean; degraded_reason_codes?: string[]; latency_ms?: { recent: number }; sources_used?: string[] };
  memoryDegraded: boolean;
  memoryDegradedReasonCodes: string[] | undefined;
}> {
  const { query, user_id, tenant_id, run_id, conversation_id } = params;
  const memoryEnabled = config.memoryRecentEnabled && !!user_id;
  const memorySemanticEnabled = config.memorySemanticEnabled && memoryEnabled;
  const stubMeta = {
    enabled: memoryEnabled,
    semantic_enabled: memorySemanticEnabled,
    recent_count: 0,
    semantic_count: 0,
  };
  if (!memoryEnabled) {
    return {
      memoryRefs: [],
      memorySummaries: [],
      memoryTraceCompact: undefined,
      memoryMeta: stubMeta,
      memoryDegraded: false,
      memoryDegradedReasonCodes: undefined,
    };
  }
  const memResult = await fetchRecentMemory({
    tenantId: tenant_id ?? null,
    userId: user_id!,
    conversationId: conversation_id ?? undefined,
    scopeMode: conversation_id ? 'conversation_only' : 'user_global_fallback',
    runId: run_id,
    queryText: query,
  });
  const memoryRecentCount = memResult.recent_count ?? 0;
  const memorySemanticCount = memResult.semantic_count ?? 0;
  const memorySources: string[] = [];
  if (memResult.refs.length > 0) {
    if (memorySemanticCount > 0) memorySources.push('qdrant_semantic');
    else memorySources.push('supabase_recent');
  }
  const memorySummaries = memResult.summaryText
    ? [{ summary_text: memResult.summaryText }]
    : [];
  const memoryTraceCompact: RunCacheRagResult['memoryTrace'] = {
    degraded: memResult.degraded || undefined,
    recent_count: memoryRecentCount,
    semantic_count: memorySemanticCount,
    latency_ms: memResult.latency_ms,
    sources_used: memorySources.length ? memorySources : undefined,
    reason_codes: memResult.degraded_reason_codes,
    scope_primary: memResult.scope_primary,
    scope_fallback_used: memResult.scope_fallback_used,
    conversation_recent_count: memResult.conversation_recent_count,
    conversation_semantic_count: memResult.conversation_semantic_count,
    global_recent_count: memResult.global_recent_count,
    global_semantic_count: memResult.global_semantic_count,
    fallback_conversation_ids: memResult.fallback_conversation_ids,
  };
  const memoryMeta = {
    enabled: memoryEnabled,
    semantic_enabled: memorySemanticEnabled,
    recent_count: memoryRecentCount,
    semantic_count: memorySemanticCount,
    degraded: memResult.degraded || undefined,
    degraded_reason_codes: memResult.degraded_reason_codes,
    latency_ms: memResult.latency_ms !== undefined ? { recent: memResult.latency_ms } : undefined,
    sources_used: memorySources.length ? memorySources : undefined,
  };
  return {
    memoryRefs: memResult.refs,
    memorySummaries,
    memoryTraceCompact,
    memoryMeta,
    memoryDegraded: memResult.degraded ?? false,
    memoryDegradedReasonCodes: memResult.degraded_reason_codes,
  };
}

export async function runCacheRag(input: RunCacheRagInput): Promise<RunCacheRagResult> {
  const { query: rawQuery, searchPlan, steps, domainHint, lldbi, entities, routing_flags, run_id, tenant_id, user_id, conversation_id } = input;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (query.length === 0) {
    const emptyTrace: RetrievalTrace = {
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
        query_used: '',
        hits_count: 0,
        qdrant_calls_count_total: 0,
        hits_total_before_cap: 0,
        hits_total_after_cap: 0,
        hits_cap_applied: false,
        low_confidence: true,
        reason_codes: ['EMPTY_QUERY'],
      },
    };
    return { rawHits: [], retrievalTrace: emptyTrace };
  }
  const runStartMs = Date.now();
  const categoryHints = lldbi?.categories_ranked_top3 ?? [];
  const documentTypeHints = lldbi?.document_types_ranked_top3 ?? [];
  const lldbiHints = { categoryHints, documentTypeHints };
  const lldbiHintsPresent = categoryHints.length > 0 || documentTypeHints.length > 0;

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
  let taxonomyResultEarly: TaxonomyCandidatesResult | null = null;
  if (goalSplit.goals.length === 1) {
    taxonomyResultEarly = await getTaxonomyCandidates({
      query,
      domainHint,
      categoryHints: categoryHints.length ? categoryHints : undefined,
      documentTypeHints: documentTypeHints.length ? documentTypeHints : undefined,
      entities,
    });
    if (
      goalSplit.goals[0]?.goal_type === 'procedure' &&
      taxonomyResultEarly.rada_nreg_candidates.length > 1
    ) {
      taxonomyResultEarly = {
        ...taxonomyResultEarly,
        rada_nreg_candidates: await prioritizeProcedureActs(
          taxonomyResultEarly.rada_nreg_candidates
        ),
      };
    }
    const clusterSplit = tryCategoryClusterSplitV2(
      taxonomyResultEarly,
      query,
      domainHint,
      routing_flags ?? undefined
    );
    if (clusterSplit && clusterSplit.goals.length >= 2) {
      goalSplit = clusterSplit;
    }
  }

  type PlannerMeta = { tier: 0 | 1 | 2; model_id?: string; duration_ms?: number; degraded?: boolean; reason_codes?: string[] };
  let plannerMeta: PlannerMeta = { tier: 0 };
  let plannerCalledThisRun = false;
  const explicitHeuristicMultiGoal =
    goalSplit.goals.length > 1 &&
    goalSplit.used_heuristic &&
    goalSplit.reason_codes.some((code) =>
      ['multi_question', 'contrastive_liability_split', 'multi_clause_structure'].includes(code)
    );
  const multiGoalNeedsPlanner = goalSplit.goals.length > 1 && !explicitHeuristicMultiGoal;

  const plannerTrigger =
    run_id &&
    config.u4PlannerEnabled &&
    !isCircuitOpen() &&
    config.openRouterApiKey &&
    (multiGoalNeedsPlanner ||
      (!!routing_flags?.input_is_large && !!routing_flags?.input_looks_like_contract));

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

  // No semantic route: either true degraded unresolved or an intentional docs-only/no-semantic plan.
  const noSemanticRoute = !searchPlan.sources.use_lldbi && !searchPlan.sources.use_memory;
  const degradedUnresolved = noSemanticRoute &&
    (searchPlan.reason_codes?.includes('CONTEXT_MODE_UNRESOLVED') ?? false);
  if (noSemanticRoute) {
    const reasonCodes = degradedUnresolved
      ? Array.from(
          new Set([
            ...(searchPlan.reason_codes ?? []),
            'CONTEXT_MODE_UNRESOLVED',
            'degraded_unresolved',
          ])
        )
      : [...(searchPlan.reason_codes ?? ['no_semantic_route'])];
    const trace: RetrievalTrace = {
      version: 1,
      hits: [],
      top_score: null,
      latency_ms: 0,
      degraded_sources: degradedUnresolved ? { lldbi: true, memory: true } : undefined,
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
        reason_codes: reasonCodes,
      },
    };
    return {
      rawHits: [],
      retrievalTrace: trace,
      memoryRefs: [],
      memorySummaries: undefined,
      memoryTrace: undefined,
    };
  }

  if (!searchPlan.sources.use_lldbi) {
    const reasonCodes: string[] = ['memory_only_mode'];
    let mem = await fetchMemoryForRun({ query, user_id, tenant_id, run_id, conversation_id });
    const trace: RetrievalTrace = {
      version: 1,
      hits: [],
      top_score: null,
      latency_ms: mem.memoryTraceCompact?.latency_ms ?? 0,
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
        reason_codes: reasonCodes,
        memory: mem.memoryMeta,
      },
    };
    return {
      rawHits: [],
      retrievalTrace: trace,
      memoryRefs: mem.memoryRefs,
      memorySummaries: mem.memorySummaries.length ? mem.memorySummaries : undefined,
      memoryTrace: mem.memoryTraceCompact,
    };
  }

  // U4 Query Rewriter: hoisted before multi-goal/single-goal branch so BOTH paths benefit from the
  // enriched query and variants. Multi-goal variant searches run after the per-goal loop (below).
  let queryForEmbed = query;
  const taxonomySnapshotSummary = taxonomyResultEarly
    ? `Categories: ${(taxonomyResultEarly.category_hints ?? []).slice(0, 10).join(', ')}. ` +
      `Aliases: ${[...new Set((taxonomyResultEarly.alias_hits ?? []).map((h) => h.alias))].slice(0, 15).join(', ')}.`
    : '(multi-goal query — taxonomy computed per-goal)';
  const queryRewritePhase = await runQueryRewritePhase({
    query,
    entities,
    routing_flags,
    goalSplit,
    domainHint,
    categoryHints,
    documentTypeHints,
    taxonomySnapshotSummary,
    run_id,
  });
  queryForEmbed = queryRewritePhase.queryForEmbed;
  const queryRewriteMeta = queryRewritePhase.meta;
  const queryRewriteDurationMs = queryRewritePhase.durationMs;
  const singleGoalSignals = !isMultiGoal ? goalSplit.goals[0]?.must_have_signals ?? [] : [];
  const singleGoalGroundedQuery = buildGroundedRetrievalQuery({
    subquery: queryForEmbed,
    mustHaveSignals: !isMultiGoal ? singleGoalSignals : undefined,
  });
  const singleGoalQueryForEmbed = !isMultiGoal
    ? singleGoalGroundedQuery.queryForRetrieval
    : queryForEmbed;

  // Multi-goal path: per-goal retrieval → merge → coverage fusion → diversity cap
  if (isMultiGoal) {
    const multiHits: RawHit[] = [];
    const goalSplitV2 = goalSplit.reason_codes?.includes('TAXONOMY_CLUSTER_SPLIT_V2') ?? false;
    const goalsSummary: Array<{
      goal_id: string;
      goal_type?: string;
      subquery_preview?: string;
      used_llm_planner?: boolean;
      act_candidates_top3?: string[];
      hits_count?: number;
      top_score?: number | null;
      split_source?: string;
      act_pool_size?: number;
    }> = [];
    const multiReasonCodes: string[] = [...goalSplit.reason_codes];
    const allCollectionsUsed: string[] = [];
    let totalLatencyMulti = 0;
    let domainBootstrapAgg: DomainBootstrapResult | undefined;
    const goalResults = await Promise.allSettled(
      goalSplit.goals.map((goal) =>
        runOneGoal(goal, entities, searchPlan, steps, collections, qdrantCallCounter, lldbiHints)
      )
    );
    for (let goalIndex = 0; goalIndex < goalResults.length; goalIndex += 1) {
      const settledGoal = goalResults[goalIndex];
      const goal = goalSplit.goals[goalIndex];
      if (settledGoal.status !== 'fulfilled') {
        goalsSummary.push({
          goal_id: goal.id,
          goal_type: goal.goal_type,
          subquery_preview: goal.subquery.slice(0, 200),
          used_llm_planner: goalSplit.used_llm_planner,
          split_source: goalSplitV2 ? 'TAXONOMY_CLUSTER_SPLIT_V2' : undefined,
          act_pool_size: 0,
        });
        multiReasonCodes.push('GOAL_RETRIEVAL_FAILED');
        continue;
      }
      const one = settledGoal.value;
      for (const h of one.hits) multiHits.push(h);
      allCollectionsUsed.push(...one.collectionsUsed);
      totalLatencyMulti += one.stepsLatencyMs.reduce((a, b) => a + b, 0);
      if (one.domainBootstrap?.attempted && !domainBootstrapAgg) domainBootstrapAgg = one.domainBootstrap;
      else if (one.domainBootstrap?.used) domainBootstrapAgg = one.domainBootstrap;
      const poolSize = one.taxonomyResult.rada_nreg_candidates?.length ?? 0;
      if (goal.required_categories?.length && poolSize < 2) {
        multiReasonCodes.push('GOAL_ACT_POOL_WEAK');
      }
      const top3Nregs = [...new Set([...one.actNregsForSummary, ...(one.taxonomyResult.rada_nreg_candidates ?? [])])].slice(0, 3);
      goalsSummary.push({
        goal_id: goal.id,
        goal_type: goal.goal_type,
        subquery_preview: goal.subquery.slice(0, 200),
        used_llm_planner: goalSplit.used_llm_planner,
        act_candidates_top3: top3Nregs,
        hits_count: one.hits.length,
        top_score: one.hits.length > 0 ? Math.max(...one.hits.map((h) => h.score)) : null,
        split_source: goalSplitV2 ? 'TAXONOMY_CLUSTER_SPLIT_V2' : undefined,
        act_pool_size: poolSize,
      });
    }
    // QR variants for multi-goal: additional chunk searches for substantive acts missed by per-goal
    // subquery embeddings. E.g. procedural query → КПК dominates; variant "ст.121 КК тяжке тілесне
    // ушкодження" surfaces ккУ chunks that goal.subquery embedding misses.
    if (queryRewriteMeta.called && queryRewriteMeta.used && queryRewriteMeta.variants?.length && qdrantCallCounter.count < 20) {
      const varTopK = searchPlan.thresholds?.top_k_chunks ?? config.lldbiTopK;
      const variantQueries = queryRewriteMeta.variants
        .slice(0, 2)
        .map((variant) => effectiveQuery(shapeQueryForRetrieval(variant, domainHint, []).shapedQuery));
      if (variantQueries.length > 0) {
        try {
          const variantEmbeddings =
            variantQueries.length > 1
              ? await embedMany(variantQueries.map((variant) => variant.slice(0, 12000)))
              : [await embedQuery(variantQueries[0])];
          const variantSearchResults = await Promise.allSettled(
            variantEmbeddings.map((embedding) =>
              qdrantSearch({
                collection: collections.chunks,
                vector: embedding.embedding,
                limit: varTopK,
                timeoutMs: config.qdrantTimeoutSec * 1000,
                callCounter: qdrantCallCounter,
              })
            )
          );
          for (const result of variantSearchResults) {
            if (result.status !== 'fulfilled') continue;
            for (const hit of result.value) {
              const raw = payloadToRawHit(hit, 'lldbi_chunks');
              if (raw.r2_key && raw.json_path) multiHits.push(raw);
            }
          }
        } catch {
          /* variant search failure is non-fatal */
        }
      }
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

    const chunksEvidenceMulti = computeChunksEvidenceTopActs(finalMulti);
    const chunkEvidenceByNreg = new Map(
      chunksEvidenceMulti.map((item) => [item.rada_nreg, item] as const)
    );
    const goalSupportByNreg = new Map<string, number>();
    for (const summary of goalsSummary) {
      for (const nreg of summary.act_candidates_top3 ?? []) {
        goalSupportByNreg.set(nreg, (goalSupportByNreg.get(nreg) ?? 0) + 1);
      }
    }
    const mergedNregs = [
      ...new Set([
        ...chunksEvidenceMulti.map((item) => item.rada_nreg),
        ...goalsSummary.flatMap((g) => g.act_candidates_top3 ?? []),
      ]),
    ].filter(Boolean);
    const multiActCandidatesTop = await Promise.all(
      mergedNregs.slice(0, SELECTED_ACTS_MAX).map(async (nreg) => {
        const meta = await getActMeta(nreg);
        const evidence = chunkEvidenceByNreg.get(nreg);
        const goalSupport = goalSupportByNreg.get(nreg) ?? 0;
        const score = Number(
          (
            (evidence?.max_score ?? 0) +
            Math.min(0.24, (evidence?.count_in_top30 ?? 0) * 0.04) +
            Math.min(0.12, goalSupport * 0.04)
          ).toFixed(6)
        );
        return {
          rada_nreg: nreg,
          title: meta?.title,
          score,
          why_tag:
            evidence != null ? 'CHUNKS_EVIDENCE' : goalSupport > 1 ? 'GOAL_SUPPORT' : 'TAXONOMY',
          source_tier: evidence != null ? ('ACTS_1' as const) : ('ACTS_2' as const),
          category: meta?.category ?? undefined,
          document_type: meta?.document_type ?? undefined,
        };
      })
    );
    multiActCandidatesTop.sort((a, b) => b.score - a.score);
    const multiActCandidatesTopHydrated = await backfillChunkEvidenceCandidates(
      multiActCandidatesTop,
      chunksEvidenceMulti
    );
    const familyEvidenceMulti = await computeFamilyEvidence({
      chunks_evidence_top_acts: chunksEvidenceMulti,
      getActMeta,
    });
    const selectedActsMulti = buildSelectedActs({
      finalHits: finalMulti,
      actCandidatesTop: multiActCandidatesTopHydrated,
      goals_summary: goalsSummary.map((g) => ({ goal_id: g.goal_id })),
      taxonomyNregs: new Set(mergedNregs),
      actsSearchNregs: mergedNregs,
      documentTypeHints: documentTypeHints.length > 0 ? documentTypeHints : undefined,
      actSelectionLowConfidence: multiReasonCodes.includes('GOAL_ACT_POOL_WEAK'),
      chunks_evidence_top_acts: chunksEvidenceMulti,
      familyEvidence: toFamilyEvidenceSummary(familyEvidenceMulti),
    });
    const selected_acts_multi = await hydrateSelectedActsMeta(
      selectedActsMulti.selected_acts,
      selectedActsMulti.selected_acts_confidence
    );
    const multiReasonCodesFinal = [
      ...new Set([
        ...multiReasonCodes,
        ...selectedActsMulti.selected_acts_reason_codes,
        ...familyEvidenceMulti.reason_codes,
        ...noiseResultMulti.guardReasonCodes,
      ]),
    ];
    const multiLowConfidence =
      selectedActsMulti.selected_acts_confidence < 0.6 ||
      familyEvidenceMulti.family_conflict ||
      multiReasonCodesFinal.some((code) =>
        [
          'GOAL_ACT_POOL_WEAK',
          'COVERAGE_MISS_SELECTED_ACTS',
          'COVERAGE_GUARD_FAILED',
          'EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE',
          'EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY',
          'NO_STRONG_ACT_EVIDENCE',
        ].includes(code)
      );
    if (
      multiLowConfidence &&
      !multiReasonCodesFinal.some((code) =>
        ['ACT_SELECTION_LOW_CONFIDENCE', 'NO_STRONG_ACT_EVIDENCE', 'LOW_EVIDENCE', 'OUT_OF_SCOPE'].includes(code)
      )
    ) {
      multiReasonCodesFinal.push('ACT_SELECTION_LOW_CONFIDENCE');
    }

    const multiTrace: RetrievalTrace = {
      version: 1,
      hits: finalMulti,
      top_score: topScoreMulti,
      latency_ms: Date.now() - runStartMs,
      degraded_sources: Object.keys(degraded).length ? degraded : undefined,
      meta: {
        collections_used: [...new Set(allCollectionsUsed)],
        steps_latency_ms: queryRewriteDurationMs > 0 ? [queryRewriteDurationMs] : [],
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
        low_confidence: multiLowConfidence,
        why_low_confidence: multiLowConfidence
          ? familyEvidenceMulti.family_conflict
            ? 'family_conflict'
            : multiReasonCodesFinal[0]
          : undefined,
        goals_summary: goalsSummary,
        selected_acts: selected_acts_multi,
        act_candidates_top: multiActCandidatesTopHydrated.map((a) => ({
          rada_nreg: a.rada_nreg,
          title: a.title,
          score: a.score,
          reasons: [],
          why_tag: a.why_tag,
          source_tier: a.source_tier,
        })),
        selected_acts_sources_breakdown: selectedActsMulti.selected_acts_sources_breakdown,
        chunks_evidence_top_acts: selectedActsMulti.chunks_evidence_top_acts,
        selected_acts_decision: selectedActsMulti.selected_acts_decision,
        selected_acts_confidence: selectedActsMulti.selected_acts_confidence,
        selected_acts_kinds_count: selectedActsMulti.selected_acts_kinds_count,
        selected_acts_document_types_top: selectedActsMulti.selected_acts_document_types_top,
        family_evidence_summary: toFamilyEvidenceSummary(familyEvidenceMulti),
        family_evidence_reason_codes:
          familyEvidenceMulti.reason_codes.length ? familyEvidenceMulti.reason_codes : undefined,
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
          goal_split_v2: goalSplitV2,
        },
        goal_split_inputs:
          goalSplitV2 && goalSplit.goals.length >= 2
            ? {
                top_categories: goalSplit.goals.map((g) => g.required_categories?.[0]).filter(Boolean) as string[],
                supports: '(from taxonomy alias_hits)',
              }
            : undefined,
        query_rewrite: queryRewriteMeta,
        reason_codes: multiReasonCodesFinal.length ? multiReasonCodesFinal : undefined,
        lldbi_hints_present: lldbiHintsPresent,
        lldbi_hints_used: toLldbiHintsUsed(taxonomyResultEarly?.taxonomy_hints_used),
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
          per_goal_act_pool_size: goalsSummary.map((g) => ({
            goal_id: g.goal_id,
            act_pool_size: g.act_pool_size ?? 0,
          })),
          stages: [
            ...(queryRewriteDurationMs > 0
              ? [{ stage: 'query_rewrite', qdrant_calls_count: 0, time_ms: queryRewriteDurationMs }]
              : []),
            { stage: 'multi_goal', qdrant_calls_count: qdrantCallCounter.count, time_ms: totalLatencyMulti },
          ],
          distribution_by_goal: goalsSummary.map((g) => ({ goal_id: g.goal_id, hits_count: g.hits_count ?? 0 })),
          family_evidence_top2: familyEvidenceMulti.debug.top_families,
        },
        ...(domainBootstrapAgg && {
          domain_bootstrap: {
            attempted: domainBootstrapAgg.attempted,
            used: domainBootstrapAgg.used,
            chosen_family_key: domainBootstrapAgg.chosen_family_key,
            top_categories: domainBootstrapAgg.top_categories,
            reason_codes: domainBootstrapAgg.reason_codes,
          },
        }),
      },
    };
    const mem = await fetchMemoryForRun({ query, user_id, tenant_id, run_id, conversation_id });
    multiTrace.meta.memory = mem.memoryMeta;
    if (mem.memoryDegraded) {
      multiTrace.degraded_sources = { ...(multiTrace.degraded_sources ?? {}), memory: true };
    }
    return {
      rawHits: finalMulti,
      retrievalTrace: multiTrace,
      memoryRefs: mem.memoryRefs,
      memorySummaries: mem.memorySummaries.length ? mem.memorySummaries : undefined,
      memoryTrace: mem.memoryTraceCompact,
    };
  }

  const taxonomyResult =
    taxonomyResultEarly ??
    (await getTaxonomyCandidates({
      query,
      domainHint,
      categoryHints: categoryHints.length ? categoryHints : undefined,
      documentTypeHints: documentTypeHints.length ? documentTypeHints : undefined,
      entities,
    }));
  taxonomySnapshotVersion = taxonomyResult.debug.taxonomy_snapshot_version ?? null;

  let actPlannerOutput: ActPlannerOutput | null = null;
  let actPlannerCalledThisRun = false;
  const actPlannerTier = selectActPlannerTier({
    goalsCount: goalSplit.goals?.length ?? 1,
    taxonomyActCount: taxonomyResult.rada_nreg_candidates?.length ?? 0,
    aliasHitCount: taxonomyResult.alias_hits?.length ?? 0,
    categoryHintCount: taxonomyResult.category_hints?.length ?? 0,
    documentTypeHintCount: documentTypeHints.length,
    queryLength: query.length,
    hasContractLikeFlag: !!routing_flags?.input_looks_like_contract,
  });
  if (
    actPlannerTier >= 1 &&
    run_id &&
    config.u4ActPlannerEnabled &&
    config.openRouterApiKey &&
    !isCircuitOpen()
  ) {
    const actsFromAliases = new Map<string, { rada_nreg: string; title: string; category?: string | null }>();
    for (const h of taxonomyResult.alias_hits ?? []) {
      if (!actsFromAliases.has(h.rada_nreg))
        actsFromAliases.set(h.rada_nreg, {
          rada_nreg: h.rada_nreg,
          title: h.title ?? '',
          category: h.category ?? null,
        });
    }
    for (const nreg of taxonomyResult.rada_nreg_candidates ?? []) {
      if (!actsFromAliases.has(nreg)) {
        const meta = await getActMeta(nreg);
        if (meta) actsFromAliases.set(nreg, { rada_nreg: meta.rada_nreg, title: meta.title, category: meta.category });
      }
    }
    const taxonomy_snapshot_summary: TaxonomySnapshotSummary = {
      top_aliases: [...new Set((taxonomyResult.alias_hits ?? []).map((h) => h.alias))].slice(0, 15),
      top_categories: taxonomyResult.category_hints ?? [],
      acts: [...actsFromAliases.values()].slice(0, 25),
    };
    try {
      const ctx = (await runContextGet<{ act_planner_result?: ActPlannerOutput }>(run_id)) ?? null;
      if (ctx?.act_planner_result) {
        actPlannerOutput = ctx.act_planner_result;
      } else {
        actPlannerCalledThisRun = true;
        actPlannerOutput = await callActPlanner({
          query,
          goals: goalSplit.goals,
          domainHint,
          taxonomy_snapshot_summary,
          max_acts_total: 10,
          max_acts_per_goal: 5,
          allow_multi_act: true,
          tier: actPlannerTier as 1 | 2,
        });
        const mergedCtx = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
        await runContextSet(
          run_id,
          { ...mergedCtx, act_planner_result: actPlannerOutput } as Record<string, unknown>,
          RUN_CONTEXT_TTL_SEC
        );
      }
    } catch {
      actPlannerOutput = null;
    }
  }

  const { shapedQuery, anchorsUsed } = shapeQueryForRetrieval(
    singleGoalQueryForEmbed,
    domainHint,
    taxonomyResult.anchor_tokens
  );
  const effective = effectiveQuery(shapedQuery);
  const rankingQuery = effective;
  queryVariantsUsed.push(effective.slice(0, 200));

  const topK = searchPlan.thresholds?.top_k_chunks ?? config.lldbiTopK;
  const minScore = searchPlan.thresholds?.min_score ?? config.minScoreThreshold;

  // Build query list for multi-query retrieval (RRF): main + distinct variants for semantic expansion
  const effectiveNorm = effective.trim().toLowerCase();
  const singleGoalQuerySelectors = extractQueryCitationSelectors(query);
  const skipMultiQueryVariants =
    goalSplit.reason_codes.includes('multi_clause_structure') ||
    goalSplit.reason_codes.includes('procedural_bundle_compaction') ||
    singleGoalSignals.length > 0 ||
    singleGoalQuerySelectors.explicitSelectorCount > 0 ||
    singleGoalQuerySelectors.noteMentioned;
  const variants =
    config.u4MultiQueryEnabled &&
    queryRewriteMeta.used === true &&
    !skipMultiQueryVariants &&
    queryRewriteMeta?.variants?.length
      ? queryRewriteMeta.variants
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter((v) => v.length > 0 && v.toLowerCase() !== effectiveNorm)
          .slice(0, config.u4MultiQueryMaxVariants)
      : [];
  const queriesToSearch = [effective, ...variants];
  const useMultiQuery = queriesToSearch.length > 1;

  let vector: number[] | null = null;
  const vectorsByQuery: number[][] = [];
  const embedStart = Date.now();
  try {
    const embeddings =
      queriesToSearch.length > 1
        ? await embedMany(queriesToSearch.map((q) => q.slice(0, 12000)))
        : [await embedQuery(queriesToSearch[0].slice(0, 12000))];
    vectorsByQuery.push(...embeddings.map((embedding) => embedding.embedding));
    vector = vectorsByQuery[0] ?? null;
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
  const hitKey = (r: RawHit) => `${r.r2_key ?? ''}:${r.json_path ?? ''}`;
  const initialStepResults = await Promise.allSettled(
    stepsToRun.map(async ({ kind, collection }) => {
      const stepStart = Date.now();
      const limit = kind === 'lldbi_chunks' ? topK : (searchPlan.thresholds?.top_k_acts ?? 10);
      try {
        let rawHits: RawHit[];
        if (useMultiQuery && vectorsByQuery.length > 1) {
          const perVectorResults = await Promise.allSettled(
            vectorsByQuery.map((currentVector) =>
              qdrantSearch({
                collection,
                vector: currentVector,
                limit,
                timeoutMs: config.qdrantTimeoutSec * 1000,
                callCounter: qdrantCallCounter,
              })
            )
          );
          const lists = perVectorResults
            .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof qdrantSearch>>> => result.status === 'fulfilled')
            .map((result) =>
              result.value
                .map((hit) => payloadToRawHit(hit, kind))
                .filter((raw) => raw.r2_key && raw.json_path)
            );
          rawHits = rrfMerge(lists, hitKey, (raw) => raw.score ?? 0);
        } else {
          const hits = await qdrantSearch({
            collection,
            vector: vector!,
            limit,
            timeoutMs: config.qdrantTimeoutSec * 1000,
            callCounter: qdrantCallCounter,
          });
          rawHits = hits
            .map((hit) => payloadToRawHit(hit, kind))
            .filter((raw) => raw.r2_key && raw.json_path);
        }
        return {
          collection,
          latencyMs: Date.now() - stepStart,
          rawHits,
        };
      } catch {
        return {
          collection,
          latencyMs: Date.now() - stepStart,
          rawHits: [] as RawHit[],
          degraded: true,
        };
      }
    })
  );
  for (const result of initialStepResults) {
    if (result.status !== 'fulfilled') continue;
    if (result.value.degraded) degraded.lldbi = true;
    stepsLatencyMs.push(result.value.latencyMs);
    collectionsUsed.push(result.value.collection);
    rawPerStep.push(...result.value.rawHits);
  }

  const aboveThreshold = rawPerStep.filter((h) => h.score >= minScore);
  const useLowConfidenceFallback = aboveThreshold.length === 0 && rawPerStep.length > 0;
  const candidateHits = useLowConfidenceFallback ? rawPerStep : aboveThreshold;
  candidateHits.sort(compareRawHitByScore);
  const merged = dedupeHits(candidateHits);
  allHits.push(...merged);

  let topScore = allHits.length > 0 ? Math.max(...allHits.map((h) => h.score)) : null;
  const needTwoStage =
    allHits.length < MIN_HITS_FOR_TWO_STAGE ||
    (topScore != null && topScore < GOOD_SCORE_THRESHOLD);
  const hasActCandidates =
    (taxonomyResult.rada_nreg_candidates?.length ?? 0) > 0 || stepsToRun.some((s) => s.kind === 'lldbi_acts');
  const querySelectors = singleGoalQuerySelectors;
  const withinActDecision = decideWithinActExpansion({
    hasActCandidates,
    needTwoStage,
    querySelectors,
    entities,
    goalType: goalSplit.goals[0]?.goal_type,
    goalReasonCodes: goalSplit.reason_codes,
    mustHaveSignalsCount: singleGoalGroundedQuery.appliedSignals.length,
    weakLimit: TWO_STAGE_ACTS_TOP,
  });
  const withinActLimit = withinActDecision.limit;

  // Within-act retrieval is expensive. Keep it on weak first-pass runs and explicit structural/act-anchored queries,
  // but skip it on already-strong generic single-goal runs to trim Qdrant fanout.
  if (hasActCandidates && !degraded.lldbi && withinActLimit > 0) {
    const topNregs = buildWithinActPool({
      taxonomyNregs: taxonomyResult.rada_nreg_candidates ?? [],
      actSearchNregs: extractActSearchNregsFromHits(rawPerStep),
      plannerPreferredNregs:
        actPlannerOutput?.goals?.[0]?.act_candidates
          ?.filter((candidate) => candidate.rada_nreg)
          .map((candidate) => candidate.rada_nreg as string) ?? [],
      categoryHintCount: categoryHints.length,
      limit: withinActLimit,
    });
    if (topNregs.length > 0) {
      try {
        const chunkStart = Date.now();
        // Per-act retrieval: top N chunks per act so relevant article (e.g. ст.130) can appear within act.
        const filteredChunkHits = await fetchFilteredChunkHitsByActs({
          radaNregs: topNregs,
          vector,
          collection: collections.chunks,
          limit: TWO_STAGE_CHUNKS_PER_ACT,
          timeoutMs: config.qdrantTimeoutSec * 1000,
          callCounter: qdrantCallCounter,
        });
        stepsLatencyMs.push(Date.now() - chunkStart);
        collectionsUsed.push(`${collections.chunks}(filtered)`);
        usedFilteredChunksSearch = true;
        allHits.push(...filteredChunkHits);
        const deduped = dedupeHits(allHits).sort(compareRawHitByScore);
        allHits.length = 0;
        allHits.push(...deduped);
        topScore = allHits.length > 0 ? Math.max(...allHits.map((h) => h.score)) : null;
      } catch {
        // two-stage best-effort; keep first-pass hits
      }
    }
  }

  // Hybrid re-score for ordering (no extra LLM); hit.score unchanged for audit
  if (allHits.length > 0 && taxonomyResult.debug.source === 'supabase') {
    applyHybridOrdering(allHits, rankingQuery, taxonomyResult, entities);
  }

  // Anti-noise: demote "Окрема думка" / "порядок торгівлі" etc. for ordering (with guard)
  const noiseResultSingle = applyNoisePenalty(allHits, config.u4FusionTopN);
  allHits.length = 0;
  allHits.push(...noiseResultSingle.hits);

  // Diversity cap: limit same-act dominance in top N
  const capped = applyDiversityCap(allHits);
  allHits.length = 0;
  allHits.push(...capped);

  // Reference expansion (U4): extract refs from top chunks, resolve via taxonomy, add hits (before cap)
  let referenceExpansionMeta: ReferenceExpansionMeta = {
    enabled: config.u4ReferenceExpansionEnabled,
    attempted: false,
    added_count: 0,
    referenced_acts: [],
    parse_hits_used: 0,
    skipped_reason_codes: [],
  };
  if (
    config.u4ReferenceExpansionEnabled &&
    vector &&
    allHits.length > 0
  ) {
    const initialQdrantCount = qdrantCallCounter.count;
    const maxExtraCalls = config.u4ReferenceExpansionMaxQdrantCalls ?? 4;
    const existingKeys = new Set(allHits.map((h) => `${h.r2_key}:${h.json_path}`));
    const retrieveChunksForAct = async (params: {
      rada_nreg: string;
      articleRef?: string;
      queryVariant?: string;
      limit: number;
    }): Promise<RawHit[]> => {
      if (qdrantCallCounter.count >= initialQdrantCount + maxExtraCalls) return [];
      const searchQuery = params.queryVariant ?? params.articleRef ?? query;
      let searchVector = vector!;
      if (searchQuery !== query) {
        try {
          const emb = await embedQuery(searchQuery);
          searchVector = emb.embedding;
        } catch {
          // fallback to main query vector
        }
      }
      const hits = await qdrantSearch({
        collection: collections.chunks,
        vector: searchVector,
        limit: params.limit,
        filter: { must: [{ key: 'rada_nreg', match: { value: params.rada_nreg } }] },
        timeoutMs: config.qdrantTimeoutSec * 1000,
        callCounter: qdrantCallCounter,
      });
      return hits.map((h) => payloadToRawHit(h, 'lldbi_chunks'));
    };
    try {
      const { addedHits, meta } = await expandReferences({
        finalHitsBeforeCap: allHits.slice(0, 12),
        fetchChunkText: getFragmentFromR2,
        resolveActByTitleFragment: findActByTitleFragment,
        resolveActByAlias: findActByAlias,
        retrieveChunksForAct,
        getActMeta,
        config: {
          maxParseHits: 10,
          maxReferencedActs: config.u4ReferenceExpansionMaxReferencedActs ?? 2,
          maxAddedHits: config.u4ReferenceExpansionMaxAddedHits ?? 10,
        },
        lowConfidence: false,
        existingKeys,
      });
      referenceExpansionMeta = meta;
      if (addedHits.length > 0) {
        allHits.push(...addedHits);
        const deduped = dedupeHits(allHits);
        if (taxonomyResult.debug.source === 'supabase') {
          applyHybridOrdering(deduped, rankingQuery, taxonomyResult, entities);
        } else {
          deduped.sort(compareRawHitByScore);
        }
        allHits.length = 0;
        allHits.push(...deduped);
      }
    } catch {
      referenceExpansionMeta.skipped_reason_codes.push('EXPANSION_ERROR');
    }
  }

  // Re-apply noise penalty + diversity cap after reference expansion so that
  // ref-expanded hits from known noise acts (e.g. 2790-12) are also penalized and capped.
  if (referenceExpansionMeta.added_count > 0) {
    const noiseAfterExp = applyNoisePenalty(allHits, config.u4FusionTopN);
    allHits.length = 0;
    allHits.push(...noiseAfterExp.hits);
    const cappedAfterExp = applyDiversityCap(allHits);
    allHits.length = 0;
    allHits.push(...cappedAfterExp);
  }

  // U4 Article-reference backfill: strong refs only; now structural-aware for ч./п./пп./абз.
  const articleBackfill = await runArticleBackfill({
    enabled: config.u4ArticleBackfillEnabled,
    query,
    vector,
    collection: collections.chunks,
    timeoutMs: config.qdrantTimeoutSec * 1000,
    maxCalls: config.u4ArticleBackfillMaxCalls,
    maxAddedHits: config.u4ArticleBackfillMaxAddedHits,
    existingHits: allHits,
    taxonomyResult,
    callCounter: qdrantCallCounter,
  });
  const articleBackfillMeta = articleBackfill.meta;
  if (articleBackfill.addedHits.length > 0) {
    allHits.push(...articleBackfill.addedHits);
    const deduped = dedupeHits(allHits);
    if (taxonomyResult.debug.source === 'supabase') {
      applyHybridOrdering(deduped, rankingQuery, taxonomyResult, entities);
    } else {
      deduped.sort(compareRawHitByScore);
    }
    const noiseAfterBackfill = applyNoisePenalty(deduped, config.u4FusionTopN);
    const cappedAfterBackfill = applyDiversityCap(noiseAfterBackfill.hits);
    allHits.length = 0;
    allHits.push(...cappedAfterBackfill);
  }

  const hitsTotalBeforeCapSingle = allHits.length;
  const finalHits = config.u4HitsCap > 0 ? allHits.slice(0, config.u4HitsCap) : allHits;
  const hitsCapAppliedSingle = config.u4HitsCap > 0 && hitsTotalBeforeCapSingle > config.u4HitsCap;
  const avgScore =
    finalHits.length > 0 ? finalHits.reduce((s, h) => s + h.score, 0) / finalHits.length : undefined;

  // Act candidates (ACTS-1 pool + score + diversity): taxonomy + act search, then policy cap (Act selection 3.1)
  const actNregsFromSearch = extractActSearchNregsFromHits(rawPerStep);
  const plannerFamilyHints =
    actPlannerOutput?.goals?.[0]?.act_families?.map((family) => ({
      family: family.family.trim().toLowerCase(),
      confidence: family.confidence,
    })) ?? [];
  const {
    actCandidatesTop,
    actSelectionLowConfidence,
    priorAppliedAny,
    priorBoostUsed,
    lldbiSoftPriorMeta,
    acts2Used,
    acts2Trigger,
    acts2Queries,
    acts2QdrantCalls,
    acts2DebugTopTitles,
  } = await rankActCandidates({
    query,
    domainHint,
    categoryHints,
    documentTypeHints,
    lldbiHintsPresent,
    actPlannerOutput,
    taxonomyResult,
    actNregsFromSearch,
    finalHits,
    qdrantCallCounter,
    stepsLatencyMs,
  });

  // Distribution: hits by act in top 3 acts (by hit count in top 30 of returned list)
  const top30 = finalHits.slice(0, 30);
  const countByAct = new Map<string, number>();
  for (const h of top30) {
    const nreg = h.rada_nreg ?? '_unknown';
    countByAct.set(nreg, (countByAct.get(nreg) ?? 0) + 1);
  }
  const top3Acts = [...countByAct.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0].localeCompare(b[0])))
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
  if (actPlannerOutput?.global?.overall_confidence != null && actPlannerOutput.global.overall_confidence < 0.5) {
    reasonCodes.push('ACT_SELECTION_LOW_CONFIDENCE');
  }

  const plannerRationaleByNreg = new Map<string, string>();
  if (actPlannerOutput?.goals?.[0]?.act_candidates?.length) {
    for (const c of actPlannerOutput.goals[0].act_candidates) {
      if (c.rada_nreg && c.rationale_short) plannerRationaleByNreg.set(c.rada_nreg, c.rationale_short);
    }
  }
  const taxonomyNregSet = new Set(taxonomyResult.rada_nreg_candidates ?? []);
  const chunks_evidence_top_acts_pre = computeChunksEvidenceTopActs(finalHits);
  const actCandidatesTopHydrated = await backfillChunkEvidenceCandidates(
    actCandidatesTop,
    chunks_evidence_top_acts_pre
  );
  const familyEvidence = await computeFamilyEvidence({
    chunks_evidence_top_acts: chunks_evidence_top_acts_pre,
    getActMeta,
  });

  const familyWeakOrNoPrimary =
    familyEvidence.reason_codes.includes('FAMILY_WEAK_EVIDENCE') ||
    familyEvidence.reason_codes.includes('NO_PRIMARY_LAW_EVIDENCE');

  // Phase 2: evidence-driven selected_acts (buildSelectedActs 2.0 + v3 family guard)
  const selectedActsResult = buildSelectedActs({
    finalHits,
    actCandidatesTop: actCandidatesTopHydrated,
    goals_summary: [{ goal_id: goalSplit.goals[0].id }],
    hits_by_act_top3: Object.keys(hitsByActTop3).length > 0 ? hitsByActTop3 : undefined,
    avg_score_by_act_top3: Object.keys(avgScoreByActTop3).length > 0 ? avgScoreByActTop3 : undefined,
    taxonomyNregs: taxonomyNregSet,
    actsSearchNregs: actNregsFromSearch,
    domainHint,
    documentTypeHints: documentTypeHints.length > 0 ? documentTypeHints : undefined,
    actSelectionLowConfidence: actSelectionLowConfidence || familyWeakOrNoPrimary,
    chunks_evidence_top_acts: chunks_evidence_top_acts_pre,
    familyEvidence: toFamilyEvidenceSummary(familyEvidence),
  });
  const selected_acts_raw = selectedActsResult.selected_acts.map((a) => ({
    ...a,
    why_selected: plannerRationaleByNreg.get(a.rada_nreg) ?? a.why_selected,
  }));
  const selected_acts = await hydrateSelectedActsMeta(selected_acts_raw, selectedActsResult.selected_acts_confidence);
  const selected_acts_sources_breakdown = selectedActsResult.selected_acts_sources_breakdown;
  const chunks_evidence_top_acts = selectedActsResult.chunks_evidence_top_acts;
  const selected_acts_decision = selectedActsResult.selected_acts_decision;
  if (selectedActsResult.selected_acts_reason_codes.length) {
    reasonCodes.push(...selectedActsResult.selected_acts_reason_codes);
  }
  if (familyEvidence.reason_codes.length) {
    reasonCodes.push(...familyEvidence.reason_codes);
  }
  // Fix A: Specialized-domain suppression of NO_PRIMARY_LAW_EVIDENCE from triggering low_confidence.
  // In domains like healthcare, border_migration, procurement, international_eu — SECONDARY_ORDER /
  // INTERNATIONAL_TREATY / KSU_DECISION ARE the authoritative source, not PRIMARY_LAW (Закон/Кодекс).
  // Detection: data-driven via act_kind of hydrated selected_acts (no hardcoded domain names).
  // Condition: NO_PRIMARY_LAW_EVIDENCE fires BUT at least 1 selected act is a non-primary authoritative
  // kind with strong chunks evidence (count >= 5). If so, suppress low_confidence for this signal only.
  const NON_PRIMARY_AUTHORITATIVE_KINDS = new Set(['SECONDARY_ORDER', 'INTERNATIONAL_TREATY', 'KSU_DECISION']);
  const specializedDomainNoPrimary =
    familyEvidence.reason_codes.includes('NO_PRIMARY_LAW_EVIDENCE') &&
    chunks_evidence_top_acts_pre.some((e) => {
      if (e.count_in_top30 < 5) return false;
      const hydratedAct = selected_acts.find((sa) => sa.rada_nreg === e.rada_nreg);
      return hydratedAct && NON_PRIMARY_AUTHORITATIVE_KINDS.has(hydratedAct.act_kind ?? '');
    });

  // Fix B: COVERAGE_GUARD_FAILED + FAMILY_DOMINANT_OK coexistence — guard fires due to missing
  // candidateByNreg metadata for acts added via chunks evidence that are not in actCandidatesTop.
  // FAMILY_DOMINANT_OK already guarantees that PRIMARY_LAW evidence IS present and strong.
  // The guard's purpose (ensure PRIMARY_LAW in selected) is effectively already met: the act IS in
  // selected (via CHUNKS_EVIDENCE section A), just not re-detected due to metadata lookup gap.
  //
  // OOD safety: do NOT suppress if the query rewriter signals OOD (called but not used due to low
  // overall_confidence). In that case, COVERAGE_GUARD_FAILED is a genuine uncertainty signal for a
  // borderline OOD query that accidentally matched legal vocabulary.
  // Detection: data-driven via QR overall_confidence (LLM signal) — no hardcoded topics.
  // Low confidence means the LLM rewriter itself deems the query non-legal/out-of-scope.
  // Note: U2 rules path may give a plausible-looking domain for OOD queries (false classification);
  // QR confidence is more reliable as it's specifically prompted to score legal domain relevance.
  const qrSignaledOod =
    queryRewriteMeta.called &&
    queryRewriteMeta.used === false &&
    queryRewriteMeta.not_used_reason_codes?.includes('LOW_CONFIDENCE');
  const coverageGuardFiredButFamilyOk =
    selectedActsResult.selected_acts_reason_codes.includes('COVERAGE_GUARD_FAILED') &&
    familyEvidence.reason_codes.includes('FAMILY_DOMINANT_OK') &&
    !qrSignaledOod;

  // Phase 6.1: Routing-hints LLM (budgeted, rare) — only when triggers fire
  type RoutingHintsUsedEffect = {
    added_act?: { rada_nreg: string; title: string; family_key: string; source: string };
    added_count: number;
  };
  let routingHintsMeta: {
    enabled: boolean;
    called: boolean;
    call_failed_reason?: string;
    model_id?: string;
    tokens_approx?: number;
    families_ranked_top2?: Array<{ family_key: string; confidence?: number }>;
    goals_count: number;
    used_reason_codes: string[];
    not_used_reason_codes: string[];
    used_effect: RoutingHintsUsedEffect;
    attempts?: number;
    parse_mode?: 'strict' | 'extract';
    routing_path?: 'TAXONOMY_FIRST' | 'ACTS_SEARCH' | 'NONE';
  } = {
    enabled: config.u4RoutingHintsEnabled,
    called: false,
    goals_count: 0,
    used_reason_codes: [],
    not_used_reason_codes: [],
    used_effect: { added_count: 0 },
  };
  let selected_acts_final = selected_acts;
  let selected_acts_sources_breakdown_final = selected_acts_sources_breakdown;
  const recoveredEmptySelected =
    selectedActsResult.selected_acts_reason_codes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE') ||
    selectedActsResult.selected_acts_reason_codes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY');
  let low_confidence_final =
    useLowConfidenceFallback ||
    actSelectionLowConfidence ||
    // familyWeakOrNoPrimary is suppressed in specialized domains where non-primary acts are authoritative
    (familyWeakOrNoPrimary && !specializedDomainNoPrimary) ||
    // COVERAGE_GUARD_FAILED is suppressed when FAMILY_DOMINANT_OK already confirms strong PRIMARY_LAW evidence
    (selectedActsResult.selected_acts_reason_codes.includes('COVERAGE_GUARD_FAILED') && !coverageGuardFiredButFamilyOk) ||
    recoveredEmptySelected;

  // OOD Confidence Guard: force low_confidence when evidence is globally weak + domain unknown + no U2 hints.
  // Detects out-of-domain queries without hardcoded "banned topics" lists.
  // Conditions (all must hold):
  //   1. top_score below threshold (weak vector match overall)
  //   2. domainHint absent/general (no clear domain signal from U2)
  //   3. no U2 LLDBI category hints (no vocabulary-based signal)
  //   4. avg_score of all hits below threshold (confirming weak global relevance)
  type OodGuardResult = { fired: boolean; why: string[]; thresholds: { top_score: number; avg_score: number } };
  let oodGuardResult: OodGuardResult = {
    fired: false,
    why: [],
    thresholds: {
      top_score: config.u4OodGuardTopScoreThreshold,
      avg_score: config.u4OodGuardAvgScoreThreshold,
    },
  };
  if (config.u4OodGuardEnabled && !low_confidence_final) {
    const oodWhy: string[] = [];
    const topScoreWeak = topScore == null || topScore < config.u4OodGuardTopScoreThreshold;
    const domainWeak = isDomainWeak(domainHint);
    const noCategoryHints = categoryHints.length === 0;
    const avgScoreWeak = avgScore == null || avgScore < config.u4OodGuardAvgScoreThreshold;
    if (topScoreWeak) oodWhy.push('TOP_SCORE_WEAK');
    if (domainWeak) oodWhy.push('DOMAIN_WEAK');
    if (noCategoryHints) oodWhy.push('NO_CATEGORY_HINTS');
    if (avgScoreWeak) oodWhy.push('AVG_SCORE_WEAK');
    // All 4 conditions must hold to avoid false positives on legitimate weak-score queries
    if (oodWhy.length === 4) {
      low_confidence_final = true;
      oodGuardResult = { fired: true, why: oodWhy, thresholds: oodGuardResult.thresholds };
      if (!reasonCodes.includes('OUT_OF_SCOPE')) reasonCodes.push('OUT_OF_SCOPE');
      if (!reasonCodes.includes('LOW_EVIDENCE')) reasonCodes.push('LOW_EVIDENCE');
    }
  }

  // E.3: ensure low_confidence has an explicit reason (OUT_OF_SCOPE / NO_STRONG_ACT_EVIDENCE / LOW_EVIDENCE / ACT_SELECTION_LOW_CONFIDENCE)
  const lowConfReasonCodes = ['OUT_OF_SCOPE', 'NO_STRONG_ACT_EVIDENCE', 'LOW_EVIDENCE', 'ACT_SELECTION_LOW_CONFIDENCE'];
  if (low_confidence_final && !reasonCodes.some((r) => lowConfReasonCodes.includes(r))) {
    reasonCodes.push('ACT_SELECTION_LOW_CONFIDENCE');
  }

  const allowedFamilyKeysSet = new Set<string>(['unknown']);
  for (const f of familyEvidence.debug.top_families) allowedFamilyKeysSet.add(f.family_key);
  for (const a of actCandidatesTopHydrated) {
    const meta = await getActMeta(a.rada_nreg);
    if (meta?.category) {
      const key = (meta.category ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, '_').trim() || 'unknown';
      allowedFamilyKeysSet.add(key);
    }
  }
  const allowed_family_keys = Array.from(allowedFamilyKeysSet);

  const CONFIDENT_FAMILY_SUPPORT_THRESHOLD = 0.62;
  let confidentFamilyMismatch = false;
  if (
    familyEvidence.dominant_family_key &&
    familyEvidence.family_confidence >= CONFIDENT_FAMILY_SUPPORT_THRESHOLD &&
    !familyEvidence.family_conflict
  ) {
    const toKey = (c: string | null | undefined) =>
      (c ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, '_').trim() || 'unknown';
    let hasSelectedActFromDominantFamily = false;
    for (const s of selected_acts) {
      const meta = await getActMeta(s.rada_nreg);
      if (toKey(meta?.category) === familyEvidence.dominant_family_key) {
        hasSelectedActFromDominantFamily = true;
        break;
      }
    }
    confidentFamilyMismatch = !hasSelectedActFromDominantFamily;
  }

  const goalsCount = goalSplit.goals?.length ?? 1;
  const routingTriggers: RoutingHintsTriggers = {
    family_weak_evidence: familyWeakOrNoPrimary,
    family_conflict: familyEvidence.family_conflict,
    selected_acts_confidence_below_055: (selectedActsResult.selected_acts_confidence ?? 0) <= 0.55,
    selected_acts_confidence_below_06: (selectedActsResult.selected_acts_confidence ?? 0) < 0.6,
    selected_acts_confidence_below_065: (selectedActsResult.selected_acts_confidence ?? 0) < 0.65,
    selected_acts_confidence_below_075: (selectedActsResult.selected_acts_confidence ?? 0) < 0.75,
    reason_codes_include_coverage_guard_failed: selectedActsResult.selected_acts_reason_codes.includes(
      'COVERAGE_GUARD_FAILED'
    ),
    reason_codes_include_no_strong_act_evidence: reasonCodes.includes('NO_STRONG_ACT_EVIDENCE'),
    confident_family_mismatch: confidentFamilyMismatch,
    goals_count: goalsCount,
    selected_acts_empty_or_very_low: selected_acts.length === 0,
  };

  if (!shouldCallRoutingHints(routingTriggers)) {
    routingHintsMeta = { ...routingHintsMeta, not_used_reason_codes: ['NOT_CALLED'] };
    incrementU4RoutingHintsNotUsed('NOT_CALLED');
  } else {
    const strongTrigger =
      confidentFamilyMismatch ||
      (familyEvidence.family_conflict && (selectedActsResult.selected_acts_confidence ?? 0) < 0.6);
    const evidenceFamilyKeys = new Set<string>();
    if (familyEvidence.dominant_family_key) evidenceFamilyKeys.add(familyEvidence.dominant_family_key);
    for (const f of familyEvidence.debug.top_families) evidenceFamilyKeys.add(f.family_key);
    const toFamilyKeyPrecheck = (c: string | undefined | null) =>
      (c ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, '_').trim() || 'unknown';
    // Pass document_type so classifyActKind uses structural metadata, not title fallback
    const hasTaxonomyPrimaryForEvidence = [...evidenceFamilyKeys].some((fam) =>
      actCandidatesTopHydrated.some(
        (c) => toFamilyKeyPrecheck(c.category) === fam && classifyActKind(c.title ?? '', c.document_type) === 'PRIMARY_LAW'
      )
    );
    const zeroRecallCall = routingTriggers.selected_acts_empty_or_very_low === true;
    // Allow routing hints to fire even when taxonomy has a primary law candidate, if:
    // - single-goal AND confidence < 0.9 (low-confidence single-goal trigger fired).
    // Rationale: taxonomy may know the law exists (index hit) but Qdrant has at most one
    // strongly-evidenced act. Routing hints can suggest alternative search angles or confirm.
    const mediumLowConfTrigger =
      (routingTriggers.goals_count ?? 1) === 1 &&
      routingTriggers.selected_acts_confidence_below_075 === true;
    if (!strongTrigger && !hasTaxonomyPrimaryForEvidence && !zeroRecallCall && !mediumLowConfTrigger) {
      routingHintsMeta = { ...routingHintsMeta, not_used_reason_codes: ['NOT_CALLED_NO_TAXONOMY_PRIMARY'] };
      incrementU4RoutingHintsNotUsed('NOT_CALLED_NO_TAXONOMY_PRIMARY');
    } else {
    const taxonomySnapshotSummary = `Categories: ${allowed_family_keys.slice(0, 20).join(', ')}`;
    const routingInput: RoutingHintsInput = {
      original_query: query,
      goals_summary: [{ goal_id: goalSplit.goals[0].id }],
      taxonomy_snapshot_summary: taxonomySnapshotSummary,
      family_evidence_summary: toFamilyEvidenceSummary(familyEvidence),
      selected_acts_decision_summary: {
        confidence: selectedActsResult.selected_acts_confidence,
        reason_codes: selected_acts_decision.reason_codes,
      },
      allowed_family_keys,
      max_goals: 3,
    };
    const routingResult = await callRoutingHints(routingInput);
    const used_reason_codes: string[] = [];
    const not_used_reason_codes: string[] = [];
    const used_effect: RoutingHintsUsedEffect = { added_count: 0 };

    if (routingResult.call_failed_reason) {
      if (
        routingResult.call_failed_reason === 'INVALID_JSON' ||
        routingResult.call_failed_reason === 'INVALID_JSON_PARSE'
      )
        not_used_reason_codes.push('INVALID_JSON');
      else if (
        routingResult.call_failed_reason === 'VALIDATION_FAILED' ||
        routingResult.call_failed_reason === 'INVALID_JSON_SCHEMA'
      )
        not_used_reason_codes.push('SCHEMA_MISMATCH');
      else not_used_reason_codes.push(routingResult.call_failed_reason.slice(0, 32));
    }
    if (routingResult.output && !routingResult.output.routing?.families_ranked?.length) {
      not_used_reason_codes.push('NO_FAMILIES');
    }
    if (
      routingResult.output?.overall_confidence != null &&
      routingResult.output.overall_confidence < 0.55
    ) {
      not_used_reason_codes.push('CONF_TOO_LOW');
    }
    const conf = routingResult.output?.overall_confidence ?? 0;
    const expandAllowed =
      confidentFamilyMismatch ||
      familyWeakOrNoPrimary ||
      selectedActsResult.selected_acts_reason_codes.includes('COVERAGE_GUARD_FAILED') ||
      reasonCodes.includes('NO_STRONG_ACT_EVIDENCE');
    if (conf < 0.55 && !expandAllowed && routingResult.output?.routing?.families_ranked?.length) {
      not_used_reason_codes.push('EXPAND_NOT_ALLOWED');
    }

    routingHintsMeta = {
      enabled: config.u4RoutingHintsEnabled,
      called: routingResult.called,
      call_failed_reason: routingResult.call_failed_reason,
      model_id: routingResult.model_id,
      tokens_approx: routingResult.tokens_approx,
      families_ranked_top2: routingResult.output?.routing?.families_ranked?.slice(0, 2),
      goals_count: routingResult.output?.suggested_goals?.length ?? 0,
      used_reason_codes,
      not_used_reason_codes,
      used_effect,
      attempts: routingResult.attempts,
      parse_mode: routingResult.parse_mode,
    };
    if (routingResult.output?.overall_confidence != null && routingResult.output.overall_confidence < 0.55) {
      low_confidence_final = true;
      reasonCodes.push('ROUTING_HINTS_LOW_CONF');
    }
    const steerMode = conf >= 0.55;
    const expandOnlyMode = conf < 0.55 && expandAllowed;
    const mayApplyRouting =
      (routingResult.output?.routing?.families_ranked?.length ?? 0) > 0 && (steerMode || expandOnlyMode);
    if (mayApplyRouting) {
      const toFamilyKey = (c: string | undefined | null) =>
        (c ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, '_').trim() || 'unknown';
      const familiesRanked = (routingResult.output?.routing?.families_ranked ?? []).slice(0, 5).map((f) => f.family_key);
      const existingNregs = new Set(selected_acts_final.map((s) => s.rada_nreg));
      const breakdown: {
        from_taxonomy: string[];
        from_acts_search: string[];
        from_chunks_evidence: string[];
        from_routing_hints?: string[];
      } = {
        ...selected_acts_sources_breakdown_final,
        from_routing_hints: [],
      };
      const hasPrimaryFromFamilyFor = async (fam: string): Promise<boolean> => {
        for (const s of selected_acts_final) {
          const cand = actCandidatesTopHydrated.find((a) => a.rada_nreg === s.rada_nreg);
          if (!cand) continue;
          const meta = await getActMeta(s.rada_nreg);
          if (classifyActKind(cand.title ?? '', cand.document_type, cand.category) === 'PRIMARY_LAW' && toFamilyKey(meta?.category) === fam) return true;
        }
        return false;
      };
      const hasTaxonomyPrimaryForFamily = (fam: string): boolean =>
        actCandidatesTopHydrated.some(
          (c) =>
            toFamilyKey(c.category) === fam &&
            classifyActKind(c.title ?? '', c.document_type, c.category) === 'PRIMARY_LAW' &&
            !existingNregs.has(c.rada_nreg)
        );
      let allRankedCovered = true;
      for (const fam of familiesRanked) {
        if (!(await hasPrimaryFromFamilyFor(fam))) {
          allRankedCovered = false;
          break;
        }
      }
      if (allRankedCovered) not_used_reason_codes.push('ALREADY_COVERED');
      let family_key_target: string | null = null;
      if (confidentFamilyMismatch && familyEvidence.dominant_family_key) {
        if (!(await hasPrimaryFromFamilyFor(familyEvidence.dominant_family_key))) {
          family_key_target = familyEvidence.dominant_family_key;
        }
      }
      if (family_key_target == null) {
        for (const fam of familiesRanked) {
          if (await hasPrimaryFromFamilyFor(fam)) continue;
          if (hasTaxonomyPrimaryForFamily(fam)) {
            family_key_target = fam;
            break;
          }
        }
      }
      if (family_key_target == null && familiesRanked.length > 0) {
        let firstUncovered: string | null = null;
        for (const fam of familiesRanked) {
          if (!(await hasPrimaryFromFamilyFor(fam))) {
            firstUncovered = fam;
            break;
          }
        }
        if (firstUncovered != null) {
          family_key_target = firstUncovered;
          not_used_reason_codes.push('NO_TAXONOMY_PRIMARY_ACT_PRECHECK');
        }
      }
      let capBlockedPushed = false;
      let onlyOrdersFoundPushed = false;
      if (family_key_target != null && used_effect.added_count < 1) {
        if (selected_acts_final.length >= SELECTED_ACTS_MAX_OUT) {
          not_used_reason_codes.push('CAP_BLOCKED');
          capBlockedPushed = true;
        } else {
          // 4.1 USEFULNESS v3: taxonomy-first — PRIMARY_LAW from actCandidatesTop by category, no Qdrant
          const taxonomyCandidates = actCandidatesTopHydrated.filter((cand) => {
            if (existingNregs.has(cand.rada_nreg)) return false;
            const famKey = toFamilyKey(cand.category);
            if (famKey !== family_key_target) return false;
            if (classifyActKind(cand.title ?? '', cand.document_type, cand.category) !== 'PRIMARY_LAW') return false;
            return true;
          });
          const hadCandidatesForFamily = actCandidatesTopHydrated.some((cand) => {
            const famKey = toFamilyKey(cand.category);
            return famKey === family_key_target;
          });
          const hadPrimaryInTaxonomy = taxonomyCandidates.length > 0;
          if (!hadPrimaryInTaxonomy && hadCandidatesForFamily && !onlyOrdersFoundPushed) {
            not_used_reason_codes.push('ONLY_ORDERS_FOUND');
            onlyOrdersFoundPushed = true;
          }
          if (taxonomyCandidates.length > 0) {
            taxonomyCandidates.sort((a, b) => {
              const diff = (b.score ?? 0) - (a.score ?? 0);
              if (diff !== 0) return diff;
              return (a.rada_nreg ?? '').localeCompare(b.rada_nreg ?? '');
            });
            const best = taxonomyCandidates[0];
            selected_acts_final = [
              ...selected_acts_final,
              {
                rada_nreg: best.rada_nreg,
                act_title: best.title ?? '',
                score: best.score ?? 0,
                why_selected: expandOnlyMode ? 'routing_hints_family_boost' : 'routing_hints',
                reason_tag: 'from_routing_hints' as const,
                source_tags: ['ROUTING_HINTS'],
                document_type: (best as { document_type?: string }).document_type ?? undefined,
                category: (best as { category?: string }).category ?? undefined,
                act_kind: classifyActKind(best.title ?? '', (best as { document_type?: string }).document_type, (best as { category?: string }).category),
                flags: {},
              },
            ];
            (breakdown.from_routing_hints ??= []).push(best.rada_nreg);
            existingNregs.add(best.rada_nreg);
            used_effect.added_count += 1;
            used_effect.added_act = {
              rada_nreg: best.rada_nreg,
              title: best.title ?? '',
              family_key: family_key_target,
              source: 'routing_hints_taxonomy',
            };
            used_reason_codes.push('ADDED_PRIMARY_LAW_FROM_TAXONOMY');
            if (expandOnlyMode) used_reason_codes.push('EXPAND_LOW_CONF');
          } else {
            not_used_reason_codes.push('NO_TAXONOMY_PRIMARY_ACT');
            const precheckFailed = not_used_reason_codes.includes('NO_TAXONOMY_PRIMARY_ACT_PRECHECK');
            const strongTrigger = confidentFamilyMismatch || (familyEvidence.family_conflict && (selectedActsResult.selected_acts_confidence ?? 0) < 0.6);
            const runExtraSearch =
              (precheckFailed ? conf >= 0.55 && strongTrigger : true) && (!expandOnlyMode || used_effect.added_count < 1);
            if (runExtraSearch) {
              try {
                const extraVector =
                  routingResult.output?.query_variants?.[0] != null
                    ? (await embedQuery(routingResult.output.query_variants[0].slice(0, 500))).embedding
                    : vector;
                const extraHits = await qdrantSearch({
                  collection: collections.acts,
                  vector: extraVector,
                  limit: 20,
                  timeoutMs: config.qdrantTimeoutSec * 1000,
                  callCounter: qdrantCallCounter,
                });
                for (const h of extraHits) {
                  const nreg = (h.payload?.rada_nreg as string)?.trim();
                  if (!nreg || existingNregs.has(nreg)) continue;
                  const meta = await getActMeta(nreg);
                  const title = meta?.title ?? (h.payload?.title as string) ?? '';
                  const famKey = toFamilyKey(meta?.category);
                  if (famKey !== family_key_target) continue;
                  if (classifyActKind(title, meta?.document_type, meta?.category) !== 'PRIMARY_LAW') continue;
                  selected_acts_final = [
                    ...selected_acts_final,
                    {
                      rada_nreg: nreg,
                      act_title: title,
                      score: (h.score as number) ?? 0,
                      why_selected: 'routing_hints_family_boost',
                      reason_tag: 'from_routing_hints' as const,
                      source_tags: ['ROUTING_HINTS'],
                      document_type: meta?.document_type ?? undefined,
                      category: meta?.category ?? undefined,
                      act_kind: classifyActKind(title, meta?.document_type, meta?.category),
                      flags: {},
                    },
                  ];
                  (breakdown.from_routing_hints ??= []).push(nreg);
                  existingNregs.add(nreg);
                  used_effect.added_count += 1;
                  used_effect.added_act = { rada_nreg: nreg, title, family_key: famKey, source: 'extra_acts_search' };
                  used_reason_codes.push('ADDED_PRIMARY_LAW_FROM_ACTS_SEARCH');
                  if (expandOnlyMode) used_reason_codes.push('EXPAND_LOW_CONF');
                  break;
                }
                if (used_effect.added_count === 0) not_used_reason_codes.push('NO_PRIMARY_ACT_FOUND');
              } catch {
                not_used_reason_codes.push('NO_PRIMARY_ACT_FOUND');
              }
            } else {
              not_used_reason_codes.push('NO_PRIMARY_ACT_FOUND');
            }
          }
        }
      }
      if (used_effect.added_count > 0) {
        used_reason_codes.push('ADDED_PRIMARY_LAW');
        incrementU4RoutingHintsUsed();
      } else {
        for (const r of not_used_reason_codes) incrementU4RoutingHintsNotUsed(r);
      }
      const routing_path: 'TAXONOMY_FIRST' | 'ACTS_SEARCH' | 'NONE' =
        used_effect.added_act?.source === 'routing_hints_taxonomy'
          ? 'TAXONOMY_FIRST'
          : used_effect.added_act?.source === 'extra_acts_search'
            ? 'ACTS_SEARCH'
            : 'NONE';
      routingHintsMeta = {
        ...routingHintsMeta,
        used_reason_codes,
        not_used_reason_codes,
        used_effect,
        routing_path,
      };
      selected_acts_sources_breakdown_final = breakdown as typeof selected_acts_sources_breakdown_final;
    } else {
      if (used_effect.added_count === 0) {
        for (const r of not_used_reason_codes) incrementU4RoutingHintsNotUsed(r);
      }
      routingHintsMeta = { ...routingHintsMeta, used_reason_codes, not_used_reason_codes, used_effect };
    }
  }
  }

  const routingHintsAddedPrimaryLaw = routingHintsMeta.used_reason_codes.includes('ADDED_PRIMARY_LAW');
  const selectedActsFinalMeta = finalizeSelectedActsAfterRouting({
    selected_acts_before_routing: selected_acts,
    selected_acts_final,
    base_confidence: selectedActsResult.selected_acts_confidence,
    base_decision: selected_acts_decision,
    routing_hints_added_count: routingHintsMeta.used_effect.added_count,
    routing_hints_added_primary_law: routingHintsAddedPrimaryLaw,
    routing_hints_added_nregs: selected_acts_sources_breakdown_final.from_routing_hints,
    retrieval_evidence_nregs: finalHits.slice(0, 30).map((hit) => hit.rada_nreg ?? '').filter(Boolean),
  });
  selected_acts_final = selectedActsFinalMeta.selected_acts_final;
  if (
    low_confidence_final &&
    routingHintsAddedPrimaryLaw &&
    selectedActsFinalMeta.routing_hints_recovered_with_retrieval_evidence &&
    selectedActsFinalMeta.selected_acts_confidence_final >= 0.6 &&
    !reasonCodes.includes('OUT_OF_SCOPE') &&
    !reasonCodes.includes('LOW_EVIDENCE') &&
    !reasonCodes.includes('ROUTING_HINTS_LOW_CONF')
  ) {
    low_confidence_final = false;
    const actSelectionLowConfidenceIndex = reasonCodes.indexOf('ACT_SELECTION_LOW_CONFIDENCE');
    if (actSelectionLowConfidenceIndex >= 0) {
      reasonCodes.splice(actSelectionLowConfidenceIndex, 1);
    }
  }

  const mem = await fetchMemoryForRun({ query, user_id, tenant_id, run_id, conversation_id });
  const sampleHits = buildSampleHits(finalHits);

  const retrievalTrace: RetrievalTrace = {
    version: 1,
    hits: finalHits,
    top_score: topScore,
    latency_ms: Date.now() - runStartMs,
    degraded_sources: (Object.keys(degraded).length || mem.memoryDegraded)
      ? { ...degraded, ...(mem.memoryDegraded ? { memory: true } : {}) }
      : undefined,
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
      low_confidence: low_confidence_final,
      why_low_confidence:
        useLowConfidenceFallback && rawPerStep.length > 0
          ? 'all_hits_below_min_score_fallback_to_top_k'
          : reasonCodes.includes('ROUTING_HINTS_LOW_CONF')
            ? 'ROUTING_HINTS_LOW_CONF'
            : recoveredEmptySelected
              ? 'EMPTY_SELECTED_ACTS_RECOVERED'
              : actSelectionLowConfidence
                ? 'ACT_SELECTION_LOW_CONFIDENCE'
                : undefined,
      selected_acts: selected_acts_final,
      family_hints: plannerFamilyHints.length
        ? plannerFamilyHints.slice(0, 5).map((h) => h.family)
        : undefined,
      prior_applied:
        plannerFamilyHints.length > 0
          ? { applied: priorAppliedAny, boost_used: priorBoostUsed }
          : undefined,
      lldbi_soft_prior: lldbiSoftPriorMeta,
      acts2_used: acts2Used,
      acts2_trigger: acts2Trigger.length ? acts2Trigger : undefined,
      acts2_queries: acts2Queries.length ? acts2Queries : undefined,
      acts2_qdrant_calls: acts2Used ? acts2QdrantCalls : undefined,
      acts2_debug_top_titles:
        process.env.DEBUG_ACTS_LOOKUP === '1' && acts2DebugTopTitles.length
          ? acts2DebugTopTitles
          : undefined,
      used_act_planner: actPlannerCalledThisRun,
      query_variants_used: queryVariantsUsed.length ? queryVariantsUsed : undefined,
      multi_query_variants_count: useMultiQuery ? variants.length : undefined,
      used_filtered_chunks_search: usedFilteredChunksSearch || undefined,
      within_act_policy: withinActDecision.reason_codes.length
        ? withinActDecision.reason_codes
        : undefined,
      anchors_used: anchorsUsed.length ? anchorsUsed : undefined,
      taxonomy_snapshot_version: taxonomySnapshotVersion ?? undefined,
      lldbi_hints_present: lldbiHintsPresent,
      lldbi_hints_used: toLldbiHintsUsed(taxonomyResult.taxonomy_hints_used),
      taxonomy_hints_used: taxonomyResult.taxonomy_hints_used,
      hybrid_rescore_used: taxonomyResult.debug.source === 'supabase' ? true : undefined,
      thesaurus_version: 1,
      act_candidates_top: actCandidatesTopHydrated,
      query_rewrite: queryRewriteMeta,
      stage_decisions: {
        used_taxonomy: taxonomyResult.debug.source === 'supabase',
        used_acts_search: usedActsSearch,
        used_filtered_chunks: usedFilteredChunksSearch,
        used_llm_rewrite: queryRewriteMeta.used === true,
        used_llm_rerank: false,
        used_multi_query: useMultiQuery,
        used_goal_splitter: true,
        used_llm_planner: goalSplit.used_llm_planner,
        used_act_planner: actPlannerCalledThisRun,
        per_goal_act_retrieval: false,
        used_global_fallback: useLowConfidenceFallback,
      },
      goals_summary: [
        {
          goal_id: goalSplit.goals[0].id,
          goal_type: goalSplit.goals[0].goal_type,
          subquery_preview: goalSplit.goals[0].subquery.slice(0, 200),
          used_llm_planner: goalSplit.used_llm_planner,
          act_candidates_top3: actCandidatesTopHydrated.slice(0, 3).map((a) => a.rada_nreg),
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
      selected_acts_sources_breakdown: selected_acts_sources_breakdown_final,
      chunks_evidence_top_acts,
      selected_acts_decision: selectedActsFinalMeta.selected_acts_decision_final,
      selected_acts_confidence: selectedActsFinalMeta.selected_acts_confidence_final,
      selected_acts_confidence_pre_routing: selectedActsFinalMeta.selected_acts_confidence_pre_routing,
      selected_acts_kinds_count: selectedActsFinalMeta.selected_acts_kinds_count_final,
      selected_acts_document_types_top: selectedActsFinalMeta.selected_acts_document_types_top_final,
      family_evidence_summary: toFamilyEvidenceSummary(familyEvidence),
      family_evidence_reason_codes: familyEvidence.reason_codes.length ? familyEvidence.reason_codes : undefined,
      routing_hints: routingHintsMeta,
      reference_expansion: referenceExpansionMeta,
      article_backfill: articleBackfillMeta,
      ood_guard: oodGuardResult,
      low_confidence_suppressed:
        specializedDomainNoPrimary ||
        coverageGuardFiredButFamilyOk ||
        (routingHintsAddedPrimaryLaw &&
          selectedActsFinalMeta.routing_hints_recovered_with_retrieval_evidence &&
          !low_confidence_final)
          ? {
              fired: true,
              suppressed_reasons: [
                ...(specializedDomainNoPrimary ? ['SPECIALIZED_DOMAIN_NO_PRIMARY_LAW'] : []),
                ...(coverageGuardFiredButFamilyOk ? ['COVERAGE_GUARD_FAMILY_OK'] : []),
                ...(
                  routingHintsAddedPrimaryLaw &&
                  selectedActsFinalMeta.routing_hints_recovered_with_retrieval_evidence &&
                  !low_confidence_final
                    ? ['ROUTING_HINTS_RECOVERED_WITH_RETRIEVAL_EVIDENCE']
                    : []
                ),
                ...(qrSignaledOod ? [] : []),
              ],
            }
          : undefined,
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
      memory: mem.memoryMeta,
      retrieval_debug_bundle: {
        per_goal_act_candidates_top: actCandidatesTopHydrated.map((a) => ({ rada_nreg: a.rada_nreg, title: a.title, score: a.score })),
        stages: [
          ...(queryRewriteDurationMs > 0
            ? [{ stage: 'query_rewrite', qdrant_calls_count: 0, time_ms: queryRewriteDurationMs }]
            : []),
          ...(collectionsUsed.length ? collectionsUsed : ['lldbi_chunks', 'lldbi_acts']).map((stage, i) => ({
            stage: String(stage),
            qdrant_calls_count: 1,
            time_ms: stepsLatencyMs[i] ?? 0,
          })),
        ],
        distribution_by_act: Object.keys(hitsByActTop3).length > 0 ? hitsByActTop3 : undefined,
        distribution_by_goal: [{ goal_id: goalSplit.goals[0].id, hits_count: finalHits.length }],
        selected_acts_sources_breakdown: selected_acts_sources_breakdown_final,
        chunks_evidence_top_acts,
        selected_acts_decision: selectedActsFinalMeta.selected_acts_decision_final,
        family_evidence_top2: familyEvidence.debug.top_families,
      },
    },
  };

  return {
    rawHits: finalHits,
    retrievalTrace,
    memoryRefs: mem.memoryRefs,
    memorySummaries: mem.memorySummaries.length ? mem.memorySummaries : undefined,
    memoryTrace: mem.memoryTraceCompact,
  };
}
