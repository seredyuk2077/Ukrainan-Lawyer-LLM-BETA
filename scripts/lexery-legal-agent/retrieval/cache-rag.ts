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
import { heuristicGoalSplit, tryCategoryClusterSplitV2 } from './goal-splitter.js';
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
  scoreActCandidate,
  findActByTitleFragment,
  findActByAlias,
  type TaxonomyCandidatesResult,
} from './act-taxonomy-store.js';
import { getFragmentFromR2 } from './r2-fragment.js';
import { expandReferences, type ReferenceExpansionMeta } from './reference-expander.js';
import { buildSelectedActs, computeChunksEvidenceTopActs, classifyActKind, SELECTED_ACTS_MAX_OUT } from './selected-acts.js';
import { computeFamilyEvidence, toFamilyEvidenceSummary } from './family-evidence.js';
import {
  shouldCallRoutingHints,
  callRoutingHints,
  type RoutingHintsTriggers,
  type RoutingHintsInput,
} from './routing-hints-llm.js';
import {
  incrementU4RoutingHintsNotUsed,
  incrementU4RoutingHintsUsed,
  incrementU4DomainBootstrapAttempted,
  incrementU4DomainBootstrapUsed,
  incrementU4DomainBootstrapConflict,
} from '../gateway/observability.js';

const u4PlannerSemaphore = new Semaphore(config.u4PlannerConcurrency);

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
const W_VEC = 0.6;
const W_ALIAS = 0.15;
const W_ARTICLE = 0.15;
const W_CATEGORY = 0.05;
const W_TITLE = 0.05;
const MIN_HITS_FOR_TWO_STAGE = 3;
const GOOD_SCORE_THRESHOLD = 0.4;
const TWO_STAGE_ACTS_TOP = 5;
/** ACTS-1 pool size: broader candidate set before diversity + policy cap (Act selection 3.1). */
const ACTS_1_POOL_SIZE = 12;
/** ACTS-2 refinement (Phase 2): second-pass act retrieval when trigger fires. */
const ACTS_2_POOL_SIZE = 8;
const ACTS_2_SCORE_THRESHOLD = 0.55;
const ACTS_2_TOP_N_CHECK = 6;
/** Max qdrant calls before skipping ACTS-2 (budget guard). */
const MAX_QDRANT_CALLS_BEFORE_ACTS2 = 18;
/** selected_acts cap: single-goal high confidence. */
const SELECTED_ACTS_CAP_HIGH = 3;
/** selected_acts cap: single-goal low confidence (wider to reduce miss). */
const SELECTED_ACTS_CAP_LOW = 7;
/** Max selected_acts / act_candidates_top length (harness invariant ≤9). */
const SELECTED_ACTS_MAX = 9;
/** Chunks per act in within-act retrieval (so relevant article can appear within each act). */
const TWO_STAGE_CHUNKS_PER_ACT = 35;
/** Diversity cap: max hits from same act in top N (avoids one act dominating). */
const DIVERSITY_TOP_N = 25;
const DIVERSITY_MAX_SAME_ACT = 16;

/** Stable tie-breaker: score desc → rada_nreg asc → r2_key asc → json_path asc. Same input => same order. */
function compareRawHitByScore(a: RawHit, b: RawHit): number {
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (sb !== sa) return sb - sa;
  const na = (a.rada_nreg ?? '').trim();
  const nb = (b.rada_nreg ?? '').trim();
  if (na !== nb) return na.localeCompare(nb);
  const ra = (a.r2_key ?? '').trim();
  const rb = (b.r2_key ?? '').trim();
  if (ra !== rb) return ra.localeCompare(rb);
  const ja = (a.json_path ?? '').trim();
  const jb = (b.json_path ?? '').trim();
  return ja.localeCompare(jb);
}

/** Stable tie-breaker for effectiveScore (noise penalty): effectiveScore desc → hit keys. */
function compareByEffectiveScore(
  a: { hit: RawHit; effectiveScore: number },
  b: { hit: RawHit; effectiveScore: number }
): number {
  if (b.effectiveScore !== a.effectiveScore) return b.effectiveScore - a.effectiveScore;
  return compareRawHitByScore(a.hit, b.hit);
}

/** Stable sort for act candidates / ScoredActItem: score desc → rada_nreg asc → title asc. */
function compareScoredActByScore(
  a: { score: number; rada_nreg: string; title?: string },
  b: { score: number; rada_nreg: string; title?: string }
): number {
  if (b.score !== a.score) return b.score - a.score;
  const nc = (a.rada_nreg ?? '').localeCompare(b.rada_nreg ?? '');
  if (nc !== 0) return nc;
  return (a.title ?? '').localeCompare(b.title ?? '');
}

/** Family prior (Phase 1): soft boost when candidate family matches planner/query hints. */
const FAMILY_PRIOR_BOOST = 0.15;
const FAMILY_PRIOR_BOOST_WEAK = 0.05;
const ANTI_FAMILY_PENALTY = 0.05;

/** family_id -> regex to match act title (Ukrainian). Order: more specific first for actTitleToFamily. */
const FAMILY_TITLE_SIGNALS: Record<string, RegExp> = {
  administrative_offenses: /купап|адмін.*правопоруш|кодекс.*адмін/i,
  criminal_procedure: /кпк|кримінальн.*процес|кримінально.*процесуальн/i,
  civil_procedure: /ципк|цпк|цивільн.*процес/i,
  criminal: /кримін|кку|злочин|кримінальний\s+кодекс/i,
  civil: /цивіль|цк\s*у|цік|цивільний\s+кодекс/i,
  administrative: /адмін|адміністративн/i,
  tax_customs: /податк|пкку|податковий\s+кодекс/i,
  labor_social: /труд|кзпп|трудовий\s+кодекс/i,
  constitutional: /конституц/i,
  anti_corruption: /корупц|протидія.*корупц/i,
  finance_banking: /банк|фінмон|санкц/i,
};

function actTitleToFamily(title: string): string | null {
  if (!title?.trim()) return null;
  for (const [family, re] of Object.entries(FAMILY_TITLE_SIGNALS)) {
    if (re.test(title)) return family;
  }
  return null;
}

function actTitleMatchesFamily(title: string, familyId: string): boolean {
  if (familyId === 'general') return true;
  const re = FAMILY_TITLE_SIGNALS[familyId];
  if (!re) return title.toLowerCase().includes(familyId.toLowerCase());
  return re.test(title);
}

/** Query-based family signals for fallback prior / anti-signals (soft only). */
function queryFamilySignals(query: string): { criminal?: boolean; administrative?: boolean; tax?: boolean } {
  const q = query.normalize('NFC').toLowerCase();
  const criminal =
    /\b(умисн|злочин|кк\b|кримін|кримінальн|нетверез|сп'?янін|керуван.*сп'?янін|відповідальність.*кримін)/i.test(q);
  const administrative =
    /\b(штраф|купап|адмін|адміністративн|правопорушення|провадження.*адмін)/i.test(q);
  const tax = /\b(податк|пкку|податковий|податков)\b/i.test(q);
  return { criminal: criminal || false, administrative: administrative || false, tax: tax || false };
}

/** Lexical anchors per family for ACTS-2 query (rule-based when planner has no query_variants). */
const ACTS_2_LEXICAL_ANCHORS: Record<string, string> = {
  criminal: 'Кримінальний кодекс України',
  criminal_procedure: 'Кримінальний процесуальний кодекс України',
  administrative_offenses: 'Кодекс України про адміністративні правопорушення',
  administrative: 'Кодекс України про адміністративні правопорушення',
  civil: 'Цивільний кодекс України',
  civil_procedure: 'Цивільний процесуальний кодекс України',
  tax_customs: 'Податковий кодекс України',
  labor_social: 'Кодекс законів про працю України',
  constitutional: 'Конституція України',
  anti_corruption: 'протидія корупції',
  finance_banking: 'банківське регулювання',
};

/**
 * Build ACTS-2 search query: planner query_variants[0] or rule-based family lexical anchor.
 */
function buildActs2Query(
  familyHints: Array<{ family: string; confidence: number }>,
  _query: string,
  actPlannerOutput: { goals?: Array<{ query_variants?: string[] }> } | null
): string {
  const variant = actPlannerOutput?.goals?.[0]?.query_variants?.[0]?.trim();
  if (variant && variant.length > 0) return variant.slice(0, 300);
  const firstFamily = familyHints.length > 0 ? familyHints[0].family : null;
  const anchor = firstFamily ? ACTS_2_LEXICAL_ANCHORS[firstFamily] : null;
  return anchor ?? 'кодекс закон Україна';
}

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
  for (const [_, list] of byGoal) list.sort(compareRawHitByScore);

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
  covered.sort(compareRawHitByScore);
  const remaining = hits.filter((h) => !coveredKeys.has(`${h.r2_key}:${h.json_path}`));
  remaining.sort(compareRawHitByScore);
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
  withPenalty.sort(compareByEffectiveScore);
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

/** Single-goal retrieval: embed + taxonomy + optional domain bootstrap + steps + within-act + hybrid sort. Returns hits with goal_id set. */
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
  domainBootstrap?: DomainBootstrapResult;
}> {
  const stepsLatencyMs: number[] = [];
  const collectionsUsed: string[] = [];
  const hits: RawHit[] = [];
  const topK = searchPlan.thresholds?.top_k_chunks ?? config.lldbiTopK;
  const minScore = searchPlan.thresholds?.min_score ?? config.minScoreThreshold;

  let taxonomyResult = await getTaxonomyCandidates({
    query: goal.subquery,
    domainHint: goal.domain_hint,
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
          entities,
        });
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
  candidateHits.sort(compareRawHitByScore);
  hits.push(...dedupeHits(candidateHits));

  let topScore = hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null;
  const hasActCandidates =
    (taxonomyResult.rada_nreg_candidates?.length ?? 0) > 0 ||
    bootstrapActNregs.length > 0 ||
    stepsToRun.some((s) => s.kind === 'lldbi_acts');
  let usedFilteredChunks = false;
  const actNregsForSummary: string[] = [];

  const actNregsFromStep = rawPerStep
    .filter((h) => h.rada_nreg)
    .map((h) => (h.rada_nreg as string).trim())
    .filter(Boolean);
  const allActNregs = [...new Set([...bootstrapActNregs, ...actNregsFromStep, ...(taxonomyResult.rada_nreg_candidates ?? [])])];
  const topNregs = allActNregs.slice(0, TWO_STAGE_ACTS_TOP);

  if (hasActCandidates && topNregs.length > 0) {
    try {
      actNregsForSummary.push(...topNregs);
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
    hits.sort((a, b) => {
      const diff = hybridScore(b, goal.subquery, taxonomyResult, entities) - hybridScore(a, goal.subquery, taxonomyResult, entities);
      if (diff !== 0) return diff;
      return compareRawHitByScore(a, b);
    });
  }
  return { hits, actNregsForSummary, usedFilteredChunks, stepsLatencyMs, collectionsUsed, taxonomyResult, domainBootstrap };
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
  let taxonomyResultEarly: TaxonomyCandidatesResult | null = null;
  if (goalSplit.goals.length === 1) {
    taxonomyResultEarly = await getTaxonomyCandidates({ query, domainHint, entities });
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
    for (const goal of goalSplit.goals) {
      const one = await runOneGoal(goal, entities, searchPlan, steps, collections, qdrantCallCounter);
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

    const mergedNregs = [...new Set(goalsSummary.flatMap((g) => g.act_candidates_top3 ?? []))].filter(Boolean);
    const multiActCandidatesTop = await Promise.all(
      mergedNregs.slice(0, SELECTED_ACTS_MAX).map(async (nreg) => {
        const meta = await getActMeta(nreg);
        return {
          rada_nreg: nreg,
          title: meta?.title,
          score: 1,
          why_tag: 'TAXONOMY',
          source_tier: 'ACTS_2' as const,
          category: meta?.category ?? undefined,
        };
      })
    );
    const chunksEvidenceMulti = computeChunksEvidenceTopActs(finalMulti);
    const familyEvidenceMulti = await computeFamilyEvidence({
      chunks_evidence_top_acts: chunksEvidenceMulti,
      getActMeta,
    });
    const selectedActsMulti = buildSelectedActs({
      finalHits: finalMulti,
      actCandidatesTop: multiActCandidatesTop,
      goals_summary: goalsSummary.map((g) => ({ goal_id: g.goal_id })),
      taxonomyNregs: new Set(mergedNregs),
      actsSearchNregs: mergedNregs,
      chunks_evidence_top_acts: chunksEvidenceMulti,
      familyEvidence: toFamilyEvidenceSummary(familyEvidenceMulti),
    });
    const selected_acts_multi = selectedActsMulti.selected_acts.map((a) => ({
      rada_nreg: a.rada_nreg,
      act_title: a.act_title,
      score: a.score,
      why_selected: a.why_selected,
      reason_tag: a.reason_tag,
    }));

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
        selected_acts: selected_acts_multi,
        act_candidates_top: multiActCandidatesTop.map((a) => ({
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
        reason_codes: multiReasonCodes.length ? multiReasonCodes : undefined,
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
          stages: [{ stage: 'multi_goal', qdrant_calls_count: qdrantCallCounter.count, time_ms: totalLatencyMulti }],
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
    return { rawHits: finalMulti, retrievalTrace: multiTrace };
  }

  const taxonomyResult =
    taxonomyResultEarly ??
    (await getTaxonomyCandidates({
      query,
      domainHint,
      entities,
    }));
  taxonomySnapshotVersion = taxonomyResult.debug.taxonomy_snapshot_version ?? null;

  let actPlannerOutput: ActPlannerOutput | null = null;
  let actPlannerCalledThisRun = false;
  const actPlannerTier = selectActPlannerTier(
    1,
    taxonomyResult.rada_nreg_candidates?.length ?? 0,
    query.length,
    !!routing_flags?.input_looks_like_contract
  );
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
  candidateHits.sort(compareRawHitByScore);
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
        let mergedNregs = [...new Set([...actNregs, ...taxonomyNregs])].slice(0, TWO_STAGE_ACTS_TOP);
        if (actPlannerOutput?.goals?.[0]?.act_candidates?.length) {
          const preferred = actPlannerOutput.goals[0].act_candidates
            .filter((c) => c.rada_nreg)
            .map((c) => c.rada_nreg as string);
          const validPreferred = preferred.filter((n) => mergedNregs.includes(n));
          mergedNregs = [...validPreferred, ...mergedNregs.filter((n) => !validPreferred.includes(n))].slice(
            0,
            TWO_STAGE_ACTS_TOP
          );
        }
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
          const deduped = dedupeHits(allHits).sort(compareRawHitByScore);
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
    allHits.sort((a, b) => {
      const diff = hybridScore(b, query, taxonomyResult, entities) - hybridScore(a, query, taxonomyResult, entities);
      if (diff !== 0) return diff;
      return compareRawHitByScore(a, b);
    });
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
        const deduped = dedupeHits(allHits).sort(compareRawHitByScore);
        allHits.length = 0;
        allHits.push(...deduped);
      }
    } catch {
      referenceExpansionMeta.skipped_reason_codes.push('EXPANSION_ERROR');
    }
  }

  const totalLatency = stepsLatencyMs.reduce((a, b) => a + b, 0);
  const hitsTotalBeforeCapSingle = allHits.length;
  const finalHits = config.u4HitsCap > 0 ? allHits.slice(0, config.u4HitsCap) : allHits;
  const hitsCapAppliedSingle = config.u4HitsCap > 0 && hitsTotalBeforeCapSingle > config.u4HitsCap;
  const avgScore =
    finalHits.length > 0 ? finalHits.reduce((s, h) => s + h.score, 0) / finalHits.length : undefined;

  // Act candidates (ACTS-1 pool + score + diversity): taxonomy + act search, then policy cap (Act selection 3.1)
  const actNregsFromSearch = [
    ...new Set(
      rawPerStep
        .filter((h) => h.source === 'lldbi_acts')
        .map((h) => h.rada_nreg)
        .filter((n): n is string => !!n)
    ),
  ];
  const basePool = [...new Set([...taxonomyResult.rada_nreg_candidates, ...actNregsFromSearch])].slice(
    0,
    ACTS_1_POOL_SIZE
  );
  const queryTokens = query
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  const plannerPreferredNregs = new Set(
    (actPlannerOutput?.goals?.[0]?.act_candidates ?? [])
      .filter((c) => c.rada_nreg)
      .map((c) => c.rada_nreg as string)
  );

  // Family hints: from planner act_families or fallback from query signals (soft prior only)
  type FamilyHint = { family: string; confidence: number };
  let familyHints: FamilyHint[] =
    actPlannerOutput?.goals?.[0]?.act_families?.map((f) => ({ family: f.family.trim().toLowerCase(), confidence: f.confidence })) ?? [];
  if (familyHints.length === 0) {
    const qSignals = queryFamilySignals(query);
    if (qSignals.criminal) familyHints.push({ family: 'criminal', confidence: 0.6 });
    if (qSignals.administrative) familyHints.push({ family: 'administrative_offenses', confidence: 0.6 });
    if (qSignals.tax) familyHints.push({ family: 'tax_customs', confidence: 0.6 });
    // Normalize "admin" -> administrative_offenses for matching
    familyHints = familyHints.map((h) =>
      h.family === 'admin' ? { ...h, family: 'administrative_offenses' } : h
    );
  }
  const maxHintConfidence = familyHints.length ? Math.max(...familyHints.map((h) => h.confidence)) : 0;
  const ambiguousGuard = familyHints.length > 2 || maxHintConfidence < 0.6;
  const familyPriorBoostMagnitude = ambiguousGuard ? FAMILY_PRIOR_BOOST_WEAK : FAMILY_PRIOR_BOOST;
  const querySignals = queryFamilySignals(query);

  const actSelectionLowConfidence =
    (actPlannerOutput?.global?.overall_confidence != null && actPlannerOutput.global.overall_confidence < 0.5) ||
    (actPlannerOutput?.global?.missing_info_flags?.length ?? 0) > 0;

  type ScoredActItem = {
    rada_nreg: string;
    title: string | undefined;
    category: string | null;
    score: number;
    reasons: string[];
    priorApplied: boolean;
    priorBoost: number;
    antiPenalty: number;
    whyTag: string;
    source_tier: 'ACTS_1' | 'ACTS_2';
  };

  const scoreOneCandidate = async (nreg: string, tier: 'ACTS_1' | 'ACTS_2'): Promise<ScoredActItem> => {
    const meta = await getActMeta(nreg);
    const { score, reasons } = await scoreActCandidate(nreg, queryTokens, domainHint);
    const plannerBoost = plannerPreferredNregs.has(nreg) ? 0.05 : 0;
    const title = meta?.title ?? '';
    const actFamily = actTitleToFamily(title);
    let familyPriorBoost = 0;
    let priorApplied = false;
    for (const h of familyHints) {
      if (actFamily && (h.family === actFamily || actTitleMatchesFamily(title, h.family))) {
        familyPriorBoost = Math.min(familyPriorBoostMagnitude, h.confidence * 0.3);
        priorApplied = true;
        break;
      }
    }
    let antiPenalty = 0;
    if (querySignals.criminal && (actFamily === 'administrative' || actFamily === 'administrative_offenses')) {
      antiPenalty = ANTI_FAMILY_PENALTY;
    }
    if (querySignals.administrative && actFamily === 'criminal') {
      antiPenalty = ANTI_FAMILY_PENALTY;
    }
    const totalScore = score + plannerBoost + familyPriorBoost - antiPenalty;
    const whyTag = priorApplied ? 'FAMILY_PRIOR' : reasons?.includes('alias_match') || reasons?.includes('keyword_match') ? 'LEXICAL_MATCH' : 'TAXONOMY_TOP';
    return {
      rada_nreg: nreg,
      title: meta?.title ?? undefined,
      category: meta?.category ?? null,
      score: totalScore,
      reasons,
      priorApplied,
      priorBoost: familyPriorBoost,
      antiPenalty,
      whyTag,
      source_tier: tier,
    };
  };

  let scoredPool: ScoredActItem[] = await Promise.all(
    basePool.map((nreg) => scoreOneCandidate(nreg, 'ACTS_1'))
  );
  scoredPool.sort(compareScoredActByScore);

  // ACTS-2 trigger: low_confidence, or top-1 score low, or hinted family missing from top N
  const acts2Triggers: string[] = [];
  if (actSelectionLowConfidence) acts2Triggers.push('LOW_CONFIDENCE');
  const top1Score = scoredPool[0]?.score ?? 0;
  if (top1Score < ACTS_2_SCORE_THRESHOLD) acts2Triggers.push('TOP1_LOW_SCORE');
  const familiesInTopN = new Set(
    scoredPool
      .slice(0, ACTS_2_TOP_N_CHECK)
      .map((a) => actTitleToFamily(a.title ?? ''))
      .filter((f): f is string => !!f)
  );
  const hintedFamilyMissing = familyHints.some((h) => h.family && !familiesInTopN.has(h.family));
  if (hintedFamilyMissing) acts2Triggers.push('FAMILY_MISSING_IN_TOP');

  let acts2Used = false;
  let acts2Trigger: string[] = [];
  let acts2Queries: string[] = [];
  let acts2QdrantCalls = 0;
  let acts2DebugTopTitles: { title: string; rada_nreg: string; id: string; score: number }[] = [];
  const qdrantCountBeforeACTS2 = qdrantCallCounter.count;

  if (acts2Triggers.length > 0 && qdrantCallCounter.count < MAX_QDRANT_CALLS_BEFORE_ACTS2) {
    const acts2Query = buildActs2Query(familyHints, query, actPlannerOutput);
    acts2Queries.push(acts2Query.slice(0, 150));
    try {
      const acts2EmbedStart = Date.now();
      const acts2Emb = await embedQuery(acts2Query);
      stepsLatencyMs.push(Date.now() - acts2EmbedStart);
      const collections = getQdrantCollections();
      const acts2Hits = await qdrantSearch({
        collection: collections.acts,
        vector: acts2Emb.embedding,
        limit: ACTS_2_POOL_SIZE,
        timeoutMs: config.qdrantTimeoutSec * 1000,
        callCounter: qdrantCallCounter,
      });
      acts2QdrantCalls = qdrantCallCounter.count - qdrantCountBeforeACTS2;
      acts2Used = true;
      acts2Trigger = [...acts2Triggers];
      acts2DebugTopTitles = acts2Hits.slice(0, 3).map((h) => ({
        title: typeof h.payload?.title === 'string' ? h.payload.title : '',
        rada_nreg: typeof h.payload?.rada_nreg === 'string' ? h.payload.rada_nreg : '',
        id: String(h.id ?? ''),
        score: h.score ?? 0,
      }));
      const acts2Nregs = [
        ...new Set(
          acts2Hits
            .map((h) => (h.payload?.rada_nreg as string)?.trim())
            .filter((n): n is string => !!n)
        ),
      ];
      const existingNregs = new Set(scoredPool.map((a) => a.rada_nreg));
      const newNregs = acts2Nregs.filter((n) => !existingNregs.has(n));
      if (newNregs.length > 0) {
        const scoredNew = await Promise.all(newNregs.map((nreg) => scoreOneCandidate(nreg, 'ACTS_2')));
        const byNreg = new Map(scoredPool.map((a) => [a.rada_nreg, a]));
        for (const a of scoredNew) byNreg.set(a.rada_nreg, a);
        scoredPool = Array.from(byNreg.values());
        scoredPool.sort(compareScoredActByScore);
      }
    } catch {
      acts2Used = false;
      acts2Trigger = [];
      acts2Queries = [];
      acts2QdrantCalls = 0;
    }
  }

  // Diversity: up to 2 per category so we don't drop the right family (class A)
  const byCategory = new Map<string, ScoredActItem[]>();
  for (const a of scoredPool) {
    const cat = a.category ?? '_';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    const arr = byCategory.get(cat)!;
    if (arr.length < 2) arr.push(a);
  }
  const diversityOrdered: ScoredActItem[] = [];
  for (const arr of byCategory.values()) {
    diversityOrdered.push(...arr);
  }
  diversityOrdered.sort(compareScoredActByScore);
  const priorAppliedAny = scoredPool.some((a) => a.priorApplied);
  const priorBoostUsed = priorAppliedAny
    ? Math.max(...scoredPool.filter((a) => a.priorApplied).map((a) => a.priorBoost), 0)
    : 0;
  const actCandidatesTop = diversityOrdered.slice(0, SELECTED_ACTS_MAX).map((a) => ({
    rada_nreg: a.rada_nreg,
    title: a.title,
    score: a.score,
    reasons: a.reasons,
    why_tag: a.whyTag,
    source_tier: a.source_tier,
    category: a.category ?? undefined,
  }));

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
    actCandidatesTop,
    goals_summary: [{ goal_id: goalSplit.goals[0].id }],
    hits_by_act_top3: Object.keys(hitsByActTop3).length > 0 ? hitsByActTop3 : undefined,
    avg_score_by_act_top3: Object.keys(avgScoreByActTop3).length > 0 ? avgScoreByActTop3 : undefined,
    taxonomyNregs: taxonomyNregSet,
    actsSearchNregs: actNregsFromSearch,
    domainHint,
    actSelectionLowConfidence: actSelectionLowConfidence || familyWeakOrNoPrimary,
    chunks_evidence_top_acts: chunks_evidence_top_acts_pre,
    familyEvidence: toFamilyEvidenceSummary(familyEvidence),
  });
  const selected_acts = selectedActsResult.selected_acts.map((a) => ({
    rada_nreg: a.rada_nreg,
    act_title: a.act_title,
    score: a.score,
    why_selected: plannerRationaleByNreg.get(a.rada_nreg) ?? a.why_selected,
    reason_tag: a.reason_tag,
  }));
  const selected_acts_sources_breakdown = selectedActsResult.selected_acts_sources_breakdown;
  const chunks_evidence_top_acts = selectedActsResult.chunks_evidence_top_acts;
  const selected_acts_decision = selectedActsResult.selected_acts_decision;
  if (selectedActsResult.selected_acts_reason_codes.length) {
    reasonCodes.push(...selectedActsResult.selected_acts_reason_codes);
  }
  if (familyEvidence.reason_codes.length) {
    reasonCodes.push(...familyEvidence.reason_codes);
  }
  if (selectedActsResult.selected_acts_reason_codes.includes('COVERAGE_GUARD_FAILED')) {
    // low_confidence already set via actSelectionLowConfidence when family weak; also set when guard failed
  }

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
  let low_confidence_final =
    useLowConfidenceFallback ||
    actSelectionLowConfidence ||
    familyWeakOrNoPrimary ||
    selectedActsResult.selected_acts_reason_codes.includes('COVERAGE_GUARD_FAILED');

  const allowedFamilyKeysSet = new Set<string>(['unknown']);
  for (const f of familyEvidence.debug.top_families) allowedFamilyKeysSet.add(f.family_key);
  for (const a of actCandidatesTop) {
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

  const routingTriggers: RoutingHintsTriggers = {
    family_weak_evidence: familyWeakOrNoPrimary,
    family_conflict: familyEvidence.family_conflict,
    selected_acts_confidence_below_055: (selectedActsResult.selected_acts_confidence ?? 0) < 0.55,
    selected_acts_confidence_below_06: (selectedActsResult.selected_acts_confidence ?? 0) < 0.6,
    reason_codes_include_coverage_guard_failed: selectedActsResult.selected_acts_reason_codes.includes(
      'COVERAGE_GUARD_FAILED'
    ),
    reason_codes_include_no_strong_act_evidence: reasonCodes.includes('NO_STRONG_ACT_EVIDENCE'),
    confident_family_mismatch: confidentFamilyMismatch,
    goals_count: goalSplit.goals?.length ?? 1,
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
    const hasTaxonomyPrimaryForEvidence = [...evidenceFamilyKeys].some((fam) =>
      actCandidatesTop.some(
        (c) => toFamilyKeyPrecheck(c.category) === fam && classifyActKind(c.title ?? '') === 'PRIMARY_LAW'
      )
    );
    if (!strongTrigger && !hasTaxonomyPrimaryForEvidence) {
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
          const cand = actCandidatesTop.find((a) => a.rada_nreg === s.rada_nreg);
          if (!cand) continue;
          const meta = await getActMeta(s.rada_nreg);
          if (classifyActKind(cand.title ?? '') === 'PRIMARY_LAW' && toFamilyKey(meta?.category) === fam) return true;
        }
        return false;
      };
      const hasTaxonomyPrimaryForFamily = (fam: string): boolean =>
        actCandidatesTop.some(
          (c) =>
            toFamilyKey(c.category) === fam &&
            classifyActKind(c.title ?? '') === 'PRIMARY_LAW' &&
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
          const taxonomyCandidates = actCandidatesTop.filter((cand) => {
            if (existingNregs.has(cand.rada_nreg)) return false;
            const famKey = toFamilyKey(cand.category);
            if (famKey !== family_key_target) return false;
            if (classifyActKind(cand.title ?? '') !== 'PRIMARY_LAW') return false;
            return true;
          });
          const hadCandidatesForFamily = actCandidatesTop.some((cand) => {
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
                  if (classifyActKind(title) !== 'PRIMARY_LAW') continue;
                  selected_acts_final = [
                    ...selected_acts_final,
                    {
                      rada_nreg: nreg,
                      act_title: title,
                      score: (h.score as number) ?? 0,
                      why_selected: 'routing_hints_family_boost',
                      reason_tag: 'from_routing_hints' as const,
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
      low_confidence: low_confidence_final,
      why_low_confidence:
        useLowConfidenceFallback && rawPerStep.length > 0
          ? 'all_hits_below_min_score_fallback_to_top_k'
          : reasonCodes.includes('ROUTING_HINTS_LOW_CONF')
            ? 'ROUTING_HINTS_LOW_CONF'
            : actSelectionLowConfidence
              ? 'ACT_SELECTION_LOW_CONFIDENCE'
              : undefined,
      selected_acts: selected_acts_final,
      family_hints: familyHints.length ? familyHints.slice(0, 5).map((h) => h.family) : undefined,
      prior_applied:
        familyHints.length > 0
          ? { applied: priorAppliedAny, boost_used: priorBoostUsed }
          : undefined,
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
          act_candidates_top3: actCandidatesTop.slice(0, 3).map((a) => a.rada_nreg),
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
      selected_acts_decision,
      selected_acts_confidence: selectedActsResult.selected_acts_confidence,
      selected_acts_kinds_count: selectedActsResult.selected_acts_kinds_count,
      family_evidence_summary: toFamilyEvidenceSummary(familyEvidence),
      family_evidence_reason_codes: familyEvidence.reason_codes.length ? familyEvidence.reason_codes : undefined,
      routing_hints: routingHintsMeta,
      reference_expansion: referenceExpansionMeta,
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
        selected_acts_sources_breakdown: selected_acts_sources_breakdown_final,
        chunks_evidence_top_acts,
        selected_acts_decision,
        family_evidence_top2: familyEvidence.debug.top_families,
      },
    },
  };

  return { rawHits: finalHits, retrievalTrace };
}
