import type { RawHit } from './types.js';
import type { ActPlannerOutput } from './act-planner.js';
import type { TaxonomyCandidatesResult } from './act-taxonomy-store.js';
import { config } from '../lib/config.js';
import { embedQuery } from './embedding.js';
import { getQdrantCollections, qdrantSearch } from './qdrant-client.js';
import {
  buildTaxonomyQuerySignals,
  extractActReferenceSignals,
  getActMeta,
  isAmendmentLikeActTitle,
  queryLooksAmendmentFocused,
  scoreActCandidate,
} from './act-taxonomy-store.js';
import { getHitOrderingScore } from './chunk-rerank.js';

const ACTS_1_POOL_SIZE = 12;
const ACTS_2_POOL_SIZE = 8;
const ACTS_2_SCORE_THRESHOLD = 0.55;
const ACTS_2_TOP_N_CHECK = 6;
const MAX_QDRANT_CALLS_BEFORE_ACTS2 = 18;
const MAX_ACT_CANDIDATES_OUT = 9;
const FAMILY_PRIOR_BOOST = 0.15;
const FAMILY_PRIOR_BOOST_WEAK = 0.05;
const LLDBI_SOFT_PRIOR_POLICY_VERSION = 1;
const ACT_EVIDENCE_TOP_N = 30;
const ACT_EVIDENCE_MAX_BOOST = 0.75;

export type FamilyHint = {
  family: string;
  confidence: number;
};

export type ScoredActItem = {
  rada_nreg: string;
  title: string | undefined;
  category: string | null;
  document_type: string | null;
  score: number;
  reasons: string[];
  priorApplied: boolean;
  priorBoost: number;
  antiPenalty: number;
  whyTag: string;
  source_tier: 'ACTS_1' | 'ACTS_2';
};

type ActHitEvidence = {
  count_in_top30: number;
  best_rank_in_top30: number;
  rank_mass_top30: number;
  max_ordering_score: number;
};

type NormalizedActHitEvidence = {
  count: number;
  bestRank: number;
  rankMass: number;
  ordering: number;
};

export type ActCandidateTopItem = {
  rada_nreg: string;
  title: string | undefined;
  score: number;
  reasons: string[];
  why_tag: string;
  source_tier: 'ACTS_1' | 'ACTS_2';
  category?: string;
  document_type?: string;
};

export type RankActCandidatesOutput = {
  actCandidatesTop: ActCandidateTopItem[];
  actSelectionLowConfidence: boolean;
  priorAppliedAny: boolean;
  priorBoostUsed: number;
  lldbiSoftPriorMeta:
    | {
        enabled: boolean;
        categories_top3?: string[];
        doc_types_top3?: string[];
        applied_acts_count: number;
        max_category_boost?: number;
        max_doc_type_boost?: number;
        taxonomy_first_reorder?: boolean;
        policy_version?: number;
      }
    | { enabled: boolean; applied_acts_count: number };
  acts2Used: boolean;
  acts2Trigger: string[];
  acts2Queries: string[];
  acts2QdrantCalls: number;
  acts2DebugTopTitles: { title: string; rada_nreg: string; id: string; score: number }[];
};

export type RankActCandidatesInput = {
  query: string;
  domainHint?: string;
  categoryHints: string[];
  documentTypeHints: string[];
  lldbiHintsPresent: boolean;
  actPlannerOutput: ActPlannerOutput | null;
  taxonomyResult: TaxonomyCandidatesResult;
  actNregsFromSearch: string[];
  finalHits: RawHit[];
  qdrantCallCounter: { count: number };
  stepsLatencyMs: number[];
};

export function compareScoredActByScore(
  a: { score: number; rada_nreg: string; title?: string },
  b: { score: number; rada_nreg: string; title?: string }
): number {
  if (b.score !== a.score) return b.score - a.score;
  const nc = (a.rada_nreg ?? '').localeCompare(b.rada_nreg ?? '');
  if (nc !== 0) return nc;
  return (a.title ?? '').localeCompare(b.title ?? '');
}

function normalizedCategoryKey(category: string | null | undefined): string | null {
  if (!category) return null;
  return (
    category
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\p{L}\p{N}_]/gu, '')
      .trim() || null
  );
}

function actCategoryMatchesFamily(category: string | null | undefined, familyId: string): boolean {
  if (!category) return false;
  if (familyId === 'general') return true;
  const normCat = normalizedCategoryKey(category);
  if (!normCat) return false;
  const normFam = familyId
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .trim();
  return normCat === normFam || normCat.includes(normFam) || normFam.includes(normCat);
}

function buildActs2Query(query: string, actPlannerOutput: ActPlannerOutput | null): string {
  const variant = actPlannerOutput?.goals?.[0]?.query_variants?.[0]?.trim();
  if (variant && variant.length > 0) return variant.slice(0, 300);
  return query.trim().slice(0, 300) || 'кодекс закон Україна';
}

function buildActHitEvidence(finalHits: RawHit[]): Map<string, ActHitEvidence> {
  const evidence = new Map<string, ActHitEvidence>();
  for (let index = 0; index < Math.min(finalHits.length, ACT_EVIDENCE_TOP_N); index += 1) {
    const hit = finalHits[index];
    const radaNreg = hit.rada_nreg?.trim();
    if (!radaNreg) continue;
    const rank = index + 1;
    const current = evidence.get(radaNreg) ?? {
      count_in_top30: 0,
      best_rank_in_top30: rank,
      rank_mass_top30: 0,
      max_ordering_score: 0,
    };
    current.count_in_top30 += 1;
    current.best_rank_in_top30 = Math.min(current.best_rank_in_top30, rank);
    current.rank_mass_top30 += 1 / rank;
    current.max_ordering_score = Math.max(current.max_ordering_score, getHitOrderingScore(hit));
    evidence.set(radaNreg, current);
  }
  return evidence;
}

function normalizeActHitEvidence(
  evidenceByNreg: Map<string, ActHitEvidence>
): Map<string, NormalizedActHitEvidence> {
  const entries = [...evidenceByNreg.entries()];
  const maxCount = Math.max(...entries.map(([, item]) => item.count_in_top30), 0);
  const maxRankMass = Math.max(...entries.map(([, item]) => item.rank_mass_top30), 0);
  const maxOrdering = Math.max(...entries.map(([, item]) => item.max_ordering_score), 0);
  const normalized = new Map<string, NormalizedActHitEvidence>();
  for (const [radaNreg, item] of entries) {
    normalized.set(radaNreg, {
      count: maxCount > 0 ? item.count_in_top30 / maxCount : 0,
      bestRank:
        item.best_rank_in_top30 > 0
          ? Math.max(0, (ACT_EVIDENCE_TOP_N + 1 - item.best_rank_in_top30) / ACT_EVIDENCE_TOP_N)
          : 0,
      rankMass: maxRankMass > 0 ? item.rank_mass_top30 / maxRankMass : 0,
      ordering: maxOrdering > 0 ? item.max_ordering_score / maxOrdering : 0,
    });
  }
  return normalized;
}

function computeActHitEvidenceBoost(
  normalized: NormalizedActHitEvidence | undefined
): { boost: number; applied: boolean } {
  if (!normalized) return { boost: 0, applied: false };
  const boost = Math.min(
    ACT_EVIDENCE_MAX_BOOST,
    normalized.ordering * 0.32 +
      normalized.rankMass * 0.23 +
      normalized.bestRank * 0.15 +
      normalized.count * 0.05
  );
  return { boost, applied: boost > 0.08 };
}

function buildFamilyHints(actPlannerOutput: ActPlannerOutput | null): FamilyHint[] {
  return (
    actPlannerOutput?.goals?.[0]?.act_families?.map((family) => ({
      family: family.family.trim().toLowerCase(),
      confidence: family.confidence,
    })) ?? []
  );
}

export async function rankActCandidates(
  input: RankActCandidatesInput
): Promise<RankActCandidatesOutput> {
  const {
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
  } = input;

  const basePool = [
    ...new Set([...taxonomyResult.rada_nreg_candidates, ...actNregsFromSearch]),
  ].slice(0, ACTS_1_POOL_SIZE);
  const querySignals = buildTaxonomyQuerySignals(query);
  const actScoringSignals = [
    ...new Set(
      [query.trim(), ...extractActReferenceSignals(query), ...querySignals.tokens, ...querySignals.phrases].filter(
        (signal) => typeof signal === 'string' && signal.trim().length > 0
      )
    ),
  ];
  const plannerPreferredNregs = new Set(
    (actPlannerOutput?.goals?.[0]?.act_candidates ?? [])
      .filter((candidate) => candidate.rada_nreg)
      .map((candidate) => candidate.rada_nreg as string)
  );
  const exactGroundedNregs = new Set([
    ...(taxonomyResult.exact_act_nregs ?? []),
    ...(taxonomyResult.grounded_act_nregs ?? []),
  ]);
  const amendmentIntent = queryLooksAmendmentFocused(query);

  const familyHints = buildFamilyHints(actPlannerOutput);
  const maxHintConfidence = familyHints.length
    ? Math.max(...familyHints.map((hint) => hint.confidence))
    : 0;
  const ambiguousGuard = familyHints.length > 2 || maxHintConfidence < 0.6;
  const familyPriorBoostMagnitude = ambiguousGuard
    ? FAMILY_PRIOR_BOOST_WEAK
    : FAMILY_PRIOR_BOOST;

  const actSelectionLowConfidence =
    (actPlannerOutput?.global?.overall_confidence != null &&
      actPlannerOutput.global.overall_confidence < 0.5) ||
    (actPlannerOutput?.global?.missing_info_flags?.length ?? 0) > 0;

  const evidenceByNreg = buildActHitEvidence(finalHits);
  const normalizedEvidenceByNreg = normalizeActHitEvidence(evidenceByNreg);

  const scoreOneCandidate = async (
    nreg: string,
    tier: 'ACTS_1' | 'ACTS_2'
  ): Promise<ScoredActItem> => {
    const meta = await getActMeta(nreg);
    const { score, reasons } = await scoreActCandidate(nreg, actScoringSignals, domainHint);
    const plannerBoost = plannerPreferredNregs.has(nreg) ? 0.05 : 0;
    const actCategory = meta?.category ?? null;
    let familyPriorBoost = 0;
    let priorApplied = false;
    for (const hint of familyHints) {
      if (actCategoryMatchesFamily(actCategory, hint.family)) {
        familyPriorBoost = Math.min(familyPriorBoostMagnitude, hint.confidence * 0.3);
        priorApplied = true;
        break;
      }
    }
    const antiPenalty =
      !amendmentIntent &&
      !exactGroundedNregs.has(nreg) &&
      isAmendmentLikeActTitle(meta?.title)
        ? 1.8
        : 0;
    const reasonsOut = antiPenalty > 0 ? [...reasons, 'amendment_act_penalty'] : reasons;

    let lldbiCategoryBoost = 0;
    let lldbiDocTypeBoost = 0;
    if (config.u4LldbiSoftPriorEnabled) {
      if (meta?.category && categoryHints.length > 0) {
        const catKey = meta.category.normalize('NFC').toLowerCase().replace(/\s+/g, '_').trim();
        for (let index = 0; index < Math.min(categoryHints.length, 3); index += 1) {
          const hintKey = categoryHints[index]
            .normalize('NFC')
            .toLowerCase()
            .replace(/\s+/g, '_')
            .trim();
          if (
            catKey &&
            hintKey &&
            (catKey === hintKey || catKey.startsWith(hintKey) || hintKey.startsWith(catKey))
          ) {
            lldbiCategoryBoost =
              index === 0
                ? config.u4LldbiSoftPriorCategoryBoost
                : config.u4LldbiSoftPriorCategoryBoost * 0.5;
            break;
          }
        }
      }
      if (meta?.document_type && documentTypeHints.length > 0) {
        const docTypeKey = meta.document_type
          .normalize('NFC')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        for (const hint of documentTypeHints) {
          const hintKey = hint.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
          if (
            docTypeKey &&
            hintKey &&
            (docTypeKey === hintKey ||
              docTypeKey.includes(hintKey) ||
              hintKey.includes(docTypeKey))
          ) {
            lldbiDocTypeBoost = config.u4LldbiSoftPriorDocTypeBoost;
            break;
          }
        }
      }
    }

    const { boost: actHitEvidenceBoost, applied: evidenceApplied } =
      computeActHitEvidenceBoost(normalizedEvidenceByNreg.get(nreg));
    const totalScore =
      score +
      plannerBoost +
      familyPriorBoost -
      antiPenalty +
      lldbiCategoryBoost +
      lldbiDocTypeBoost +
      actHitEvidenceBoost;
    const lldbiPriorApplied = lldbiCategoryBoost > 0 || lldbiDocTypeBoost > 0;
    const whyTag = lldbiPriorApplied
      ? 'LLDBI_SOFT_PRIOR'
      : evidenceApplied
        ? 'HITS_EVIDENCE'
        : priorApplied
          ? 'FAMILY_PRIOR'
          : reasonsOut?.includes('alias_match') || reasonsOut?.includes('exact_alias_match')
            ? 'ALIAS_MATCH'
            : 'TAXONOMY_TOP';
    return {
      rada_nreg: nreg,
      title: meta?.title ?? undefined,
      category: meta?.category ?? null,
      document_type: meta?.document_type ?? null,
      score: totalScore,
      reasons: evidenceApplied ? [...reasonsOut, 'hits_evidence'] : reasonsOut,
      priorApplied: priorApplied || lldbiPriorApplied || evidenceApplied,
      priorBoost: familyPriorBoost + lldbiCategoryBoost + lldbiDocTypeBoost + actHitEvidenceBoost,
      antiPenalty,
      whyTag,
      source_tier: tier,
    };
  };

  let scoredPool = await Promise.all(basePool.map((nreg) => scoreOneCandidate(nreg, 'ACTS_1')));
  scoredPool.sort(compareScoredActByScore);

  const acts2Triggers: string[] = [];
  if (actSelectionLowConfidence) acts2Triggers.push('LOW_CONFIDENCE');
  const top1Score = scoredPool[0]?.score ?? 0;
  if (top1Score < ACTS_2_SCORE_THRESHOLD) acts2Triggers.push('TOP1_LOW_SCORE');
  const familiesInTopN = new Set(
    scoredPool
      .slice(0, ACTS_2_TOP_N_CHECK)
      .map((item) => normalizedCategoryKey(item.category))
      .filter((family): family is string => !!family)
  );
  const hintedFamilyMissing = familyHints.some((hint) => {
    if (!hint.family) return false;
    const normalizedFamily = hint.family
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\p{L}\p{N}_]/gu, '')
      .trim();
    return (
      !!normalizedFamily &&
      ![...familiesInTopN].some(
        (category) =>
          category === normalizedFamily ||
          category.includes(normalizedFamily) ||
          normalizedFamily.includes(category)
      )
    );
  });
  if (hintedFamilyMissing) acts2Triggers.push('FAMILY_MISSING_IN_TOP');

  let acts2Used = false;
  let acts2Trigger: string[] = [];
  let acts2Queries: string[] = [];
  let acts2QdrantCalls = 0;
  let acts2DebugTopTitles: { title: string; rada_nreg: string; id: string; score: number }[] = [];
  const qdrantCountBeforeACTS2 = qdrantCallCounter.count;

  if (acts2Triggers.length > 0 && qdrantCallCounter.count < MAX_QDRANT_CALLS_BEFORE_ACTS2) {
    const acts2Query = buildActs2Query(query, actPlannerOutput);
    acts2Queries.push(acts2Query.slice(0, 150));
    try {
      const acts2EmbedStart = Date.now();
      const acts2Embedding = await embedQuery(acts2Query);
      stepsLatencyMs.push(Date.now() - acts2EmbedStart);
      const collections = getQdrantCollections();
      const acts2Hits = await qdrantSearch({
        collection: collections.acts,
        vector: acts2Embedding.embedding,
        limit: ACTS_2_POOL_SIZE,
        timeoutMs: config.qdrantTimeoutSec * 1000,
        callCounter: qdrantCallCounter,
      });
      acts2QdrantCalls = qdrantCallCounter.count - qdrantCountBeforeACTS2;
      acts2Used = true;
      acts2Trigger = [...acts2Triggers];
      acts2DebugTopTitles = acts2Hits.slice(0, 3).map((hit) => ({
        title: typeof hit.payload?.title === 'string' ? hit.payload.title : '',
        rada_nreg: typeof hit.payload?.rada_nreg === 'string' ? hit.payload.rada_nreg : '',
        id: String(hit.id ?? ''),
        score: hit.score ?? 0,
      }));
      const acts2Nregs = [
        ...new Set(
          acts2Hits
            .map((hit) => (hit.payload?.rada_nreg as string)?.trim())
            .filter((nreg): nreg is string => !!nreg)
        ),
      ];
      const existingNregs = new Set(scoredPool.map((item) => item.rada_nreg));
      const newNregs = acts2Nregs.filter((nreg) => !existingNregs.has(nreg));
      if (newNregs.length > 0) {
        const scoredNew = await Promise.all(newNregs.map((nreg) => scoreOneCandidate(nreg, 'ACTS_2')));
        const byNreg = new Map(scoredPool.map((item) => [item.rada_nreg, item]));
        for (const item of scoredNew) byNreg.set(item.rada_nreg, item);
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

  const byCategory = new Map<string, ScoredActItem[]>();
  for (const item of scoredPool) {
    const category = item.category ?? '_';
    if (!byCategory.has(category)) byCategory.set(category, []);
    const bucket = byCategory.get(category)!;
    if (bucket.length < 2) bucket.push(item);
  }
  const diversityOrdered: ScoredActItem[] = [];
  for (const bucket of byCategory.values()) diversityOrdered.push(...bucket);
  diversityOrdered.sort(compareScoredActByScore);

  const priorAppliedAny = scoredPool.some((item) => item.priorApplied);
  const priorBoostUsed = priorAppliedAny
    ? Math.max(...scoredPool.filter((item) => item.priorApplied).map((item) => item.priorBoost), 0)
    : 0;
  const lldbiSoftPriorAppliedActs = config.u4LldbiSoftPriorEnabled
    ? scoredPool.filter((item) => item.whyTag === 'LLDBI_SOFT_PRIOR').length
    : 0;
  const lldbiSoftPriorMeta =
    config.u4LldbiSoftPriorEnabled && lldbiHintsPresent
      ? {
          enabled: true,
          categories_top3: categoryHints.slice(0, 3),
          doc_types_top3: documentTypeHints.slice(0, 3),
          applied_acts_count: lldbiSoftPriorAppliedActs,
          max_category_boost: config.u4LldbiSoftPriorCategoryBoost,
          max_doc_type_boost: config.u4LldbiSoftPriorDocTypeBoost,
          taxonomy_first_reorder: categoryHints.length > 0,
          policy_version: LLDBI_SOFT_PRIOR_POLICY_VERSION,
        }
      : { enabled: config.u4LldbiSoftPriorEnabled, applied_acts_count: 0 };

  const actCandidatesTop = diversityOrdered.slice(0, MAX_ACT_CANDIDATES_OUT).map((item) => ({
    rada_nreg: item.rada_nreg,
    title: item.title,
    score: item.score,
    reasons: item.reasons,
    why_tag: item.whyTag,
    source_tier: item.source_tier,
    category: item.category ?? undefined,
    document_type: item.document_type ?? undefined,
  }));

  return {
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
  };
}
