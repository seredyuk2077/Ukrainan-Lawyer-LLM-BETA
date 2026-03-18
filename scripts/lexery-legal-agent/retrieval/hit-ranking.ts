import type { EvidenceGoal } from './goals.js';
import type { RawHit } from './types.js';
import type { TaxonomyCandidatesResult } from './act-taxonomy-store.js';
import { classifyActKind } from './selected-acts.js';
import {
  buildDiscriminativeQueryTokenWeights,
  compareHitsByOrderingScore,
  computeChunkStructuralScore,
  getHitOrderingScore,
} from './chunk-rerank.js';

const W_VEC = 0.44;
const W_ALIAS = 0.15;
const W_ARTICLE = 0.15;
const W_CATEGORY = 0.05;
const W_STRUCTURAL = 0.3;
const NOISE_PENALTY = 0.15;
export const NOISE_PENALTY_POLICY_VERSION = 2;
const DIVERSITY_TOP_N = 25;
const DIVERSITY_MAX_SAME_ACT = 8;
const ARTICLE_DIVERSITY_TOP_N = 12;
const ARTICLE_DIVERSITY_MAX_SAME_ARTICLE = 1;

/** Stable tie-breaker: score desc -> rada_nreg asc -> r2_key asc -> json_path asc. */
export function compareRawHitByScore(a: RawHit, b: RawHit): number {
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

/** Deduplicate by stable source pointer. */
export function dedupeHits(hits: RawHit[]): RawHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.r2_key}:${h.json_path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Hybrid score (no LLM): vector + taxonomy act alignment + explicit article ref + structural relevance.
 * `hit.score` stays the raw vector score for forensics; this score is only for ordering.
 */
export function hybridScore(
  hit: RawHit,
  query: string,
  taxonomy: TaxonomyCandidatesResult,
  entities: { act_abbrev?: string; article_ref?: string }[] | undefined,
  queryTokenWeights?: Map<string, number>
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
  const structuralScore = computeChunkStructuralScore(hit, query, queryTokenWeights);
  return (
    W_VEC * vec +
    W_ALIAS * aliasMatch +
    W_ARTICLE * articleMatch +
    W_CATEGORY * categoryHint +
    W_STRUCTURAL * structuralScore
  );
}

/** Mutates hits in place: computes `ordering_score` and sorts descending by it. */
export function applyHybridOrdering(
  hits: RawHit[],
  query: string,
  taxonomy: TaxonomyCandidatesResult,
  entities: { act_abbrev?: string; article_ref?: string }[] | undefined
): void {
  const queryTokenWeights = buildDiscriminativeQueryTokenWeights(hits, query);
  for (const hit of hits) {
    hit.ordering_score = hybridScore(hit, query, taxonomy, entities, queryTokenWeights);
  }
  hits.sort(compareHitsByOrderingScore);
}

/** Coverage fusion over per-goal hits, preserving reranked ordering instead of raw vector order. */
export function applyCoverageFusion(
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
  for (const [_, list] of byGoal) list.sort(compareHitsByOrderingScore);

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
  covered.sort(compareHitsByOrderingScore);
  const remaining = hits.filter((h) => !coveredKeys.has(`${h.r2_key}:${h.json_path}`));
  remaining.sort(compareHitsByOrderingScore);
  return [...covered, ...remaining].slice(0, topN);
}

export interface NoisePenaltyResult {
  hits: RawHit[];
  penaltyCount: number;
  guardBlockedCount: number;
  guardReasonCodes: string[];
}

function compareByEffectiveScore(
  a: { hit: RawHit; effectiveScore: number },
  b: { hit: RawHit; effectiveScore: number }
): number {
  if (b.effectiveScore !== a.effectiveScore) return b.effectiveScore - a.effectiveScore;
  return compareHitsByOrderingScore(a.hit, b.hit);
}

/** Noise demotion over reranked hits. Uses `ordering_score`, never raw vector score. */
export function applyNoisePenalty(
  hits: RawHit[],
  topNForGuard: number = 30
): NoisePenaltyResult {
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
    const kind = classifyActKind(h.title ?? '', h.document_type ?? undefined, h.category ?? undefined);
    const isNoise = kind === 'CASELAW_OPINION';
    const score = getHitOrderingScore(h);
    if (!isNoise) return { hit: h, effectiveScore: score };
    const gid = h.goal_id ?? '_single';
    const onlySourceForGoal = (goalCountInTopN.get(gid) ?? 0) <= 1;
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

/** Diversity cap after rerank/noise handling. */
export function applyDiversityCap(hits: RawHit[]): RawHit[] {
  const inTop: RawHit[] = [];
  const afterTop: RawHit[] = [];
  const countByAct = new Map<string, number>();
  const countByArticle = new Map<string, number>();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const nreg = h.rada_nreg ?? '_unknown';
    const count = countByAct.get(nreg) ?? 0;
    const article = typeof h.article_number === 'string' ? h.article_number.trim() : '';
    const articleKey = article ? `${nreg}:${article}` : '';
    const articleCount = articleKey ? countByArticle.get(articleKey) ?? 0 : 0;
    const articleCapReached =
      articleKey.length > 0 &&
      inTop.length < ARTICLE_DIVERSITY_TOP_N &&
      articleCount >= ARTICLE_DIVERSITY_MAX_SAME_ARTICLE;
    if (inTop.length < DIVERSITY_TOP_N && count < DIVERSITY_MAX_SAME_ACT && !articleCapReached) {
      inTop.push(h);
      countByAct.set(nreg, count + 1);
      if (articleKey) countByArticle.set(articleKey, articleCount + 1);
    } else {
      afterTop.push(h);
    }
  }
  return [...inTop, ...afterTop];
}
