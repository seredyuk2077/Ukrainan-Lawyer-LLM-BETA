/**
 * U4 selected_acts 2.0 — evidence-driven fusion (LEX-114, LEX-117).
 * selected_acts = truth from chunks evidence + taxonomy/acts_search support + family diversity.
 * Policy v2: act_kind classifier, diversity guard, anti-order dominance.
 * No keyword heuristics; data-driven from final hits and act candidates.
 */
import type { RawHit } from './types.js';
import { getHitOrderingScore } from './chunk-rerank.js';

export const CHUNKS_EVIDENCE_COUNT_THRESHOLD = 3;
export const CHUNKS_EVIDENCE_SCORE_THRESHOLD = 0.55;
export const SELECTED_ACTS_MIN_SINGLE = 1;
export const SELECTED_ACTS_MIN_MULTI = 2;
export const SELECTED_ACTS_MAX_OUT = 8;

/** Act kind by structural metadata only (document_type/category). */
export type ActKind =
  | 'PRIMARY_LAW'
  | 'SECONDARY_ORDER'
  | 'CASELAW_OPINION'
  | 'KSU_DECISION'
  | 'INTERNATIONAL_TREATY'
  | 'BILL_DRAFT'
  | 'UNKNOWN';

/**
 * Lightweight classifier: document type from structured metadata only.
 * Best-effort: unknown document_type/category never break; fallback UNKNOWN.
 */
function normalizeMetaKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const ACT_KIND_BY_DOCUMENT_TYPE = new Map<string, ActKind>([
  ['закон', 'PRIMARY_LAW'],
  ['кодекс', 'PRIMARY_LAW'],
  ['конституція', 'PRIMARY_LAW'],

  ['наказ', 'SECONDARY_ORDER'],
  ['постанова кму', 'SECONDARY_ORDER'],
  ['розпорядження кму', 'SECONDARY_ORDER'],
  ['постанова вру', 'SECONDARY_ORDER'],
  ['указ президента', 'SECONDARY_ORDER'],
  ['указ президента україни', 'SECONDARY_ORDER'],
  ['розпорядження президента україни', 'SECONDARY_ORDER'],
  ['постанова нбу', 'SECONDARY_ORDER'],
  ['повідомлення нбу', 'SECONDARY_ORDER'],
  ['постанова цвк', 'SECONDARY_ORDER'],
  ['постанова пленуму верховного суду', 'SECONDARY_ORDER'],
  ['рішення рнбо', 'SECONDARY_ORDER'],
  ['постанова нкрекп', 'SECONDARY_ORDER'],
  ['розпорядження голови вру', 'SECONDARY_ORDER'],
  ['положення', 'SECONDARY_ORDER'],
  ["роз'яснення", 'SECONDARY_ORDER'],

  ['рішення ксу', 'KSU_DECISION'],
  ['рішення конституційного суду україни', 'KSU_DECISION'],
  ['ухвала ксу', 'KSU_DECISION'],

  ['конвенція', 'INTERNATIONAL_TREATY'],
  ['міжнародний договір', 'INTERNATIONAL_TREATY'],
  ['угода', 'INTERNATIONAL_TREATY'],
  ['протокол', 'INTERNATIONAL_TREATY'],
  ['декларація', 'INTERNATIONAL_TREATY'],
  ['регламент європейського парламенту', 'INTERNATIONAL_TREATY'],
  ['директива європейського парламенту', 'INTERNATIONAL_TREATY'],

  ['окрема думка судді', 'CASELAW_OPINION'],
  ['окрема думка судді ксу', 'CASELAW_OPINION'],

  ['проєкт закону', 'BILL_DRAFT'],
  ['проект закону', 'BILL_DRAFT'],
]);

export function classifyActKind(
  _title: string,
  document_type?: string | null,
  _category?: string | null
): ActKind {
  const dt = normalizeMetaKey(document_type);
  return ACT_KIND_BY_DOCUMENT_TYPE.get(dt) ?? 'UNKNOWN';
}

export type ActCandidateInput = {
  rada_nreg: string;
  title?: string;
  score?: number;
  reasons?: string[];
  why_tag?: string;
  source_tier?: 'ACTS_1' | 'ACTS_2';
  category?: string;
  document_type?: string;
};

export type ChunksEvidenceItem = {
  rada_nreg: string;
  count_in_top30: number;
  avg_score_in_top30: number;
  max_score: number;
  best_rank_in_top30?: number;
  rank_mass_top30?: number;
  max_ordering_score?: number;
};

/** Flags for Writer (recovered/keep-one/draft/opinion). */
export type SelectedActFlags = {
  recovered?: boolean;
  keep_one?: boolean;
  draft?: boolean;
  opinion?: boolean;
};

export type SelectedActOutput = {
  rada_nreg: string;
  act_title?: string;
  family?: string;
  score?: number;
  why_selected?: string;
  reason_tag?: string;
  source_tags?: string[];
  /** Для Writer: document_type, category, act_kind з LLDBI/taxonomy. */
  document_type?: string | null;
  category?: string | null;
  storage_category?: string | null;
  act_kind?: ActKind;
  flags?: SelectedActFlags;
};

/** Family evidence summary (from family-evidence module) for coverage guard v3. */
export type FamilyEvidenceSummaryInput = {
  dominant_family_key?: string;
  family_confidence: number;
  family_conflict: boolean;
  top2: Array<{ family_key: string; support_score: number }>;
};

export type BuildSelectedActsInput = {
  finalHits: RawHit[];
  actCandidatesTop: ActCandidateInput[];
  goals_summary: { goal_id: string }[];
  /** hits_by_act for top acts in top-30 (from distribution). */
  hits_by_act_top3?: Record<string, number>;
  avg_score_by_act_top3?: Record<string, number>;
  taxonomyNregs: Set<string>;
  actsSearchNregs: string[];
  domainHint?: string;
  /** U2 lldbi.document_types_ranked_top3 — allow BILL_DRAFT/CASELAW_OPINION from taxonomy when type matches. */
  documentTypeHints?: string[];
  actSelectionLowConfidence?: boolean;
  /** Precomputed chunks evidence (when provided, used instead of computing from finalHits). */
  chunks_evidence_top_acts?: ChunksEvidenceItem[];
  /** Family evidence for coverage guard v3 (per-goal family coverage). */
  familyEvidence?: FamilyEvidenceSummaryInput;
};

/** Count of selected acts by act_kind (for trace meta). */
export type SelectedActsKindsCount = Partial<Record<ActKind, number>>;

export type BuildSelectedActsOutput = {
  selected_acts: SelectedActOutput[];
  selected_acts_confidence: number;
  selected_acts_reason_codes: string[];
  selected_acts_sources_breakdown: {
    from_taxonomy: string[];
    from_acts_search: string[];
    from_chunks_evidence: string[];
  };
  chunks_evidence_top_acts: ChunksEvidenceItem[];
  selected_acts_decision: {
    policy_version: number;
    included_from_chunks_evidence: boolean;
    included_from_family_guard?: boolean;
    family_guard_actions?: Array<{ goal_id: string; family: string; added_rada_nreg?: string }>;
    reason_codes: string[];
  };
  selected_acts_kinds_count: SelectedActsKindsCount;
  /** Top 5 document_type values among selected acts (for trace). */
  selected_acts_document_types_top?: string[];
};

export function computeChunksEvidenceTopActs(finalHits: RawHit[]): ChunksEvidenceItem[] {
  const top30 = finalHits.slice(0, 30);
  const stats = new Map<
    string,
    {
      count: number;
      sumScore: number;
      maxScore: number;
      bestRank: number;
      rankMass: number;
      maxOrderingScore: number;
    }
  >();
  for (let index = 0; index < top30.length; index += 1) {
    const h = top30[index];
    const nreg = h.rada_nreg ?? '_unknown';
    if (nreg === '_unknown') continue;
    const rank = index + 1;
    const cur = stats.get(nreg) ?? {
      count: 0,
      sumScore: 0,
      maxScore: 0,
      bestRank: rank,
      rankMass: 0,
      maxOrderingScore: 0,
    };
    cur.count += 1;
    cur.sumScore += h.score;
    cur.maxScore = Math.max(cur.maxScore, h.score);
    cur.bestRank = Math.min(cur.bestRank, rank);
    cur.rankMass += 1 / rank;
    cur.maxOrderingScore = Math.max(cur.maxOrderingScore, getHitOrderingScore(h));
    stats.set(nreg, cur);
  }
  return [...stats.entries()]
    .map(([rada_nreg, v]) => ({
      rada_nreg,
      count_in_top30: v.count,
      avg_score_in_top30: v.sumScore / v.count,
      max_score: v.maxScore,
      best_rank_in_top30: v.bestRank,
      rank_mass_top30: v.rankMass,
      max_ordering_score: v.maxOrderingScore,
    }))
    .sort(compareChunksEvidenceStrength)
    .slice(0, 10);
}

function compareChunksEvidenceStrength(a: ChunksEvidenceItem, b: ChunksEvidenceItem): number {
  const rankMassDiff = (b.rank_mass_top30 ?? 0) - (a.rank_mass_top30 ?? 0);
  if (rankMassDiff !== 0) return rankMassDiff;
  const aBestRank = a.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const bBestRank = b.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const bestRankDiff = aBestRank === bBestRank ? 0 : aBestRank - bBestRank;
  if (bestRankDiff !== 0) return bestRankDiff;
  if (b.count_in_top30 !== a.count_in_top30) return b.count_in_top30 - a.count_in_top30;
  const orderingDiff = (b.max_ordering_score ?? 0) - (a.max_ordering_score ?? 0);
  if (orderingDiff !== 0) return orderingDiff;
  if (b.max_score !== a.max_score) return b.max_score - a.max_score;
  return (a.rada_nreg ?? '').localeCompare(b.rada_nreg ?? '');
}

function categoryToFamilyKey(category: string | undefined | null): string {
  return (category ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim() || 'unknown';
}

function pushReasonCode(reasonCodes: string[], code: string): void {
  if (!reasonCodes.includes(code)) reasonCodes.push(code);
}

function toKey(s: string): string {
  return (s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True if act's document_type matches any U2 document_type hint (contains or is contained). */
function documentTypeHintMatches(docType: string | undefined | null, hints: string[]): boolean {
  if (!docType || !hints.length) return false;
  const k = toKey(docType);
  return hints.some((h) => {
    const hk = toKey(h);
    return hk && (k.includes(hk) || hk.includes(k));
  });
}

/** True if U2 hints explicitly mention project/draft (allow BILL_DRAFT from taxonomy only then). */
function hintsAllowDraft(hints: string[]): boolean {
  return hints.some((h) => classifyActKind('', h, null) === 'BILL_DRAFT');
}

/** Min distinct act_kinds in chunks evidence to enforce diversity in selected_acts. */
const DIVERSITY_EVIDENCE_KINDS_MIN = 2;
/** Min support (count) for an act in chunks to count toward "evidence kind". */
const DIVERSITY_EVIDENCE_COUNT_MIN = 2;

/**
 * Build selected_acts from chunks evidence (priority) + taxonomy/acts_search (support) + diversity.
 * Policy v2: act_kind, diversity guard, anti-order (max 1 SECONDARY_ORDER, only with evidence).
 */
const FAMILY_GUARD_CONFIDENCE_THRESHOLD = 0.55;
const FAMILY_CONFLICT_TOP2_MIN = 0.45;

/**
 * Kinds that need evidence or doc_type hint when adding from taxonomy (noise control).
 * UNKNOWN is intentionally excluded: after removing title-word guessing from classifyActKind,
 * UNKNOWN means "document_type absent in metadata" not "this is noise". Acts from the taxonomy
 * DB are structurally vetted; they may legitimately lack document_type metadata.
 * BILL_DRAFT and CASELAW_OPINION are still controlled because they are structurally distinct
 * content types that require explicit evidence to be included.
 */
const NOISE_KINDS: ActKind[] = ['BILL_DRAFT', 'CASELAW_OPINION', 'KSU_DECISION'];

const CROSS_FAMILY_EVIDENCE_COUNT_OVERRIDE = 5;
const CROSS_FAMILY_EVIDENCE_SCORE_OVERRIDE = 0.68;
const NON_PRIMARY_STRONG_SUPPORT_COUNT_MIN = 5;
const NON_PRIMARY_STRONG_SUPPORT_BEST_RANK_MAX = 8;
const MULTI_GOAL_SINGLE_ACT_COUNT_RATIO = 3;
const MULTI_GOAL_SINGLE_ACT_RANK_MASS_RATIO = 2.5;
const SINGLE_GOAL_PRIMARY_FAMILY_DOMINANCE_RATIO = 2;

function hasMaterialChunkEvidence(item: ChunksEvidenceItem | undefined): boolean {
  if (!item) return false;
  return (
    item.count_in_top30 >= DIVERSITY_EVIDENCE_COUNT_MIN ||
    hasStrongTopRankEvidence(item) ||
    item.max_score >= CHUNKS_EVIDENCE_SCORE_THRESHOLD
  );
}

function hasStrongTopRankEvidence(item: ChunksEvidenceItem | undefined): boolean {
  if (!item) return false;
  const bestRank = item.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const orderingScore = item.max_ordering_score ?? item.max_score;
  return bestRank <= 5 && orderingScore >= CHUNKS_EVIDENCE_SCORE_THRESHOLD;
}

function isStrongChunksEvidence(item: ChunksEvidenceItem | undefined): boolean {
  if (!item) return false;
  return item.count_in_top30 >= CHUNKS_EVIDENCE_COUNT_THRESHOLD || hasStrongTopRankEvidence(item);
}

function hasStrongNonPrimarySupportEvidence(item: ChunksEvidenceItem | undefined): boolean {
  if (!item) return false;
  const bestRank = item.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  return (
    item.count_in_top30 >= NON_PRIMARY_STRONG_SUPPORT_COUNT_MIN ||
    (bestRank <= NON_PRIMARY_STRONG_SUPPORT_BEST_RANK_MAX &&
      (item.max_ordering_score ?? item.max_score) >= CHUNKS_EVIDENCE_SCORE_THRESHOLD)
  );
}

function hasRepeatedSecondaryOrderSupport(item: ChunksEvidenceItem | undefined): boolean {
  if (!item) return false;
  return item.count_in_top30 >= NON_PRIMARY_STRONG_SUPPORT_COUNT_MIN;
}

function candidateHasFamilyGuardEvidenceSupport(
  radaNreg: string,
  chunksEvidenceByNreg: Map<string, ChunksEvidenceItem>
): boolean {
  return hasMaterialChunkEvidence(chunksEvidenceByNreg.get(radaNreg));
}

function canOverrideNonPrimaryPrimaryLawBlock(
  kind: ActKind,
  evidence: ChunksEvidenceItem | undefined,
  familyAligned: boolean,
  allowedByHint: boolean
): boolean {
  if (kind !== 'SECONDARY_ORDER' && kind !== 'UNKNOWN') return false;
  if (kind === 'SECONDARY_ORDER' && !familyAligned && !allowedByHint && !hasRepeatedSecondaryOrderSupport(evidence)) {
    return false;
  }
  return hasStrongNonPrimarySupportEvidence(evidence);
}

function shouldBlockKsuUnderPrimaryLawDominance(
  isMultiGoal: boolean,
  hasStrongPrimaryLawEvidence: boolean,
  evidence: ChunksEvidenceItem | undefined
): boolean {
  return !isMultiGoal && hasStrongPrimaryLawEvidence && !hasStrongNonPrimarySupportEvidence(evidence);
}

function isFamilyAlignedSupportAct(
  category: string | undefined,
  familyEvidence: FamilyEvidenceSummaryInput | undefined
): boolean {
  if (!familyEvidence) return true;
  const familyKey = categoryToFamilyKey(category);
  if (!familyKey || familyKey === 'unknown') return true;
  if (
    familyEvidence.dominant_family_key &&
    familyEvidence.family_confidence >= FAMILY_GUARD_CONFIDENCE_THRESHOLD &&
    !familyEvidence.family_conflict
  ) {
    return familyKey === familyEvidence.dominant_family_key;
  }
  if (
    familyEvidence.family_conflict &&
    familyEvidence.top2.length >= 2 &&
    familyEvidence.top2[0].support_score >= FAMILY_CONFLICT_TOP2_MIN &&
    familyEvidence.top2[1].support_score >= FAMILY_CONFLICT_TOP2_MIN
  ) {
    return familyEvidence.top2.some((item) => item.family_key === familyKey);
  }
  return true;
}

function dominantFamilyLooksProcedural(familyEvidence: FamilyEvidenceSummaryInput | undefined): boolean {
  const dominant = familyEvidence?.dominant_family_key?.normalize('NFC').toLowerCase().trim();
  return Boolean(dominant && dominant.includes('procedure'));
}

function canFallbackSelectAct(input: {
  candidate: ActCandidateInput;
  evidence: ChunksEvidenceItem | undefined;
  documentTypeHints?: string[];
  familyEvidence?: FamilyEvidenceSummaryInput;
  isMultiGoal: boolean;
  hasStrongPrimaryLawEvidence: boolean;
  actCandidatesTop: ActCandidateInput[];
}): boolean {
  const { candidate, evidence } = input;
  const kind = classifyActKind(candidate.title ?? '', candidate.document_type, candidate.category);
  const hasEvidence = Boolean(evidence);
  const strongTopRankEvidence = hasStrongTopRankEvidence(evidence);
  const allowedByHint = documentTypeHintMatches(candidate.document_type, input.documentTypeHints ?? []);
  const familyAligned = isFamilyAlignedSupportAct(candidate.category, input.familyEvidence);
  const crossFamilyEvidenceOverride =
    (evidence?.count_in_top30 ?? 0) >= CROSS_FAMILY_EVIDENCE_COUNT_OVERRIDE ||
    (evidence?.max_score ?? 0) >= CROSS_FAMILY_EVIDENCE_SCORE_OVERRIDE;

  if (NOISE_KINDS.includes(kind) && !hasEvidence && !allowedByHint) return false;
  if (kind === 'BILL_DRAFT' && !hasEvidence && (!allowedByHint || !hintsAllowDraft(input.documentTypeHints ?? []))) {
    return false;
  }
  if (kind === 'CASELAW_OPINION') {
    const strongEvidence = evidence && evidence.count_in_top30 >= 3;
    const hasPrimaryInCandidates = input.actCandidatesTop.some(
      (candidateItem) =>
        classifyActKind(candidateItem.title ?? '', candidateItem.document_type, candidateItem.category) === 'PRIMARY_LAW'
    );
    if (!strongEvidence && hasPrimaryInCandidates) return false;
  }
  if (kind === 'KSU_DECISION') {
    const hasPrimaryInCandidates = input.actCandidatesTop.some(
      (candidateItem) =>
        classifyActKind(candidateItem.title ?? '', candidateItem.document_type, candidateItem.category) === 'PRIMARY_LAW'
    );
    if (
      (hasPrimaryInCandidates && !hasStrongNonPrimarySupportEvidence(evidence)) ||
      shouldBlockKsuUnderPrimaryLawDominance(input.isMultiGoal, input.hasStrongPrimaryLawEvidence, evidence)
    ) {
      return false;
    }
  }
  if (
    !input.isMultiGoal &&
    kind !== 'PRIMARY_LAW' &&
    input.hasStrongPrimaryLawEvidence &&
    !strongTopRankEvidence &&
    !canOverrideNonPrimaryPrimaryLawBlock(kind, evidence, familyAligned, allowedByHint)
  ) {
    return false;
  }
  const dominantFamilyProcedural = dominantFamilyLooksProcedural(input.familyEvidence);
  if (
    kind === 'SECONDARY_ORDER' &&
    !familyAligned &&
    !allowedByHint &&
    (!hasRepeatedSecondaryOrderSupport(evidence) || dominantFamilyProcedural)
  ) {
    return false;
  }
  if (!familyAligned && !allowedByHint && !crossFamilyEvidenceOverride && !strongTopRankEvidence) {
    return false;
  }

  return (
    hasMaterialChunkEvidence(evidence) ||
    allowedByHint
  );
}

function shouldAllowSingleActCoverageForMultiGoal(
  isMultiGoal: boolean,
  chunksEvidenceTopActs: ChunksEvidenceItem[],
  candidateByNreg: Map<string, ActCandidateInput>,
  familyEvidence: FamilyEvidenceSummaryInput | undefined
): boolean {
  if (!isMultiGoal) return false;
  if (familyEvidence?.family_conflict) return false;
  const strongEvidence = chunksEvidenceTopActs.filter((item) => isStrongChunksEvidence(item));
  const top = strongEvidence[0];
  if (!top) return false;
  const topCandidate = candidateByNreg.get(top.rada_nreg);
  if (
    classifyActKind(
      topCandidate?.title ?? '',
      topCandidate?.document_type,
      topCandidate?.category
    ) !== 'PRIMARY_LAW'
  ) {
    return false;
  }
  const second = strongEvidence[1];
  if (!second) return true;
  const topStrongEvidenceNregs = new Set(strongEvidence.slice(0, 3).map((item) => item.rada_nreg));
  if (topStrongEvidenceNregs.size === 1) return true;
  const secondCandidate = candidateByNreg.get(second.rada_nreg);
  const topFamilyKey = categoryToFamilyKey(topCandidate?.category);
  const secondFamilyKey = categoryToFamilyKey(secondCandidate?.category);
  const secondKind = classifyActKind(
    secondCandidate?.title ?? '',
    secondCandidate?.document_type,
    secondCandidate?.category
  );
  const secondBestRank = second.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  if (
    secondKind === 'PRIMARY_LAW' &&
    topFamilyKey &&
    secondFamilyKey &&
    topFamilyKey !== 'unknown' &&
    secondFamilyKey !== 'unknown' &&
    topFamilyKey !== secondFamilyKey &&
    secondBestRank <= 3 &&
    isStrongChunksEvidence(second)
  ) {
    return false;
  }
  const topRankMass = top.rank_mass_top30 ?? 0;
  const secondRankMass = second.rank_mass_top30 ?? 0;
  return (
    top.count_in_top30 >= Math.max(6, second.count_in_top30 * MULTI_GOAL_SINGLE_ACT_COUNT_RATIO) &&
    topRankMass >= secondRankMass * MULTI_GOAL_SINGLE_ACT_RANK_MASS_RATIO
  );
}

export function buildSelectedActs(input: BuildSelectedActsInput): BuildSelectedActsOutput {
  const {
    finalHits,
    actCandidatesTop,
    taxonomyNregs,
    actsSearchNregs,
    documentTypeHints,
    actSelectionLowConfidence,
    chunks_evidence_top_acts: inputChunksEvidence,
    familyEvidence,
  } = input;

  const chunks_evidence_top_acts = inputChunksEvidence ?? computeChunksEvidenceTopActs(finalHits);
  // Hysteresis: only strong repeated evidence or strong early-ranked evidence are must-include.
  const chunksEvidenceNregs = new Set(
    chunks_evidence_top_acts
      .filter((a) => isStrongChunksEvidence(a))
      .map((a) => a.rada_nreg)
  );
  const chunksEvidenceByNreg = new Map(
    chunks_evidence_top_acts.map((item) => [item.rada_nreg, item] as const)
  );
  const isMultiGoal = (input.goals_summary?.length ?? 0) >= 2;
  const candidateByNreg = new Map(actCandidatesTop.map((a) => [a.rada_nreg, a]));
  const allowSingleActCoverageForMultiGoal = shouldAllowSingleActCoverageForMultiGoal(
    isMultiGoal,
    chunks_evidence_top_acts,
    candidateByNreg,
    familyEvidence
  );
  const selectedActsMin =
    allowSingleActCoverageForMultiGoal
      ? SELECTED_ACTS_MIN_SINGLE
      : isMultiGoal
        ? Math.max(SELECTED_ACTS_MIN_MULTI, input.goals_summary.length)
        : SELECTED_ACTS_MIN_SINGLE;
  const reasonCodes: string[] = [];
  const selected: SelectedActOutput[] = [];
  const fromTaxonomy: string[] = [];
  const fromActsSearch: string[] = [];
  const fromChunksEvidence: string[] = [];
  const hasStrongPrimaryLawEvidence = chunks_evidence_top_acts.some((item) => {
    const candidate = candidateByNreg.get(item.rada_nreg);
    return (
      classifyActKind(candidate?.title ?? '', candidate?.document_type, candidate?.category) ===
        'PRIMARY_LAW' && isStrongChunksEvidence(item)
    );
  });

  // A) Chunks evidence MUST be included first (reason CHUNKS_EVIDENCE), up to cap
  for (const e of chunks_evidence_top_acts) {
    if (selected.length >= SELECTED_ACTS_MAX_OUT) break;
    if (!chunksEvidenceNregs.has(e.rada_nreg)) continue;
    if (selected.some((s) => s.rada_nreg === e.rada_nreg)) continue;
    const cand = candidateByNreg.get(e.rada_nreg);
    const kind = classifyActKind(cand?.title ?? '', cand?.document_type, cand?.category);
    if (
      !isMultiGoal &&
      kind !== 'PRIMARY_LAW' &&
      hasStrongPrimaryLawEvidence &&
      !hasStrongTopRankEvidence(e) &&
      !canOverrideNonPrimaryPrimaryLawBlock(kind, e)
    ) {
      pushReasonCode(reasonCodes, 'NON_PRIMARY_EVIDENCE_BLOCKED_PRIMARY_PRESENT');
      continue;
    }
    if (NOISE_KINDS.includes(kind) && hasStrongPrimaryLawEvidence && !hasStrongTopRankEvidence(e)) {
      if (kind === 'CASELAW_OPINION') pushReasonCode(reasonCodes, 'OPINION_BLOCKED_PRIMARY_PRESENT');
      if (kind === 'BILL_DRAFT') pushReasonCode(reasonCodes, 'DRAFT_BLOCKED_PRIMARY_PRESENT');
      if (kind === 'KSU_DECISION') pushReasonCode(reasonCodes, 'KSU_BLOCKED_PRIMARY_PRESENT');
      continue;
    }
    if (kind === 'KSU_DECISION' && shouldBlockKsuUnderPrimaryLawDominance(isMultiGoal, hasStrongPrimaryLawEvidence, e)) {
      pushReasonCode(reasonCodes, 'KSU_BLOCKED_PRIMARY_PRESENT');
      continue;
    }
    const familyAligned = isFamilyAlignedSupportAct(cand?.category, familyEvidence);
    const orderRepeatedSupport = hasRepeatedSecondaryOrderSupport(e);
    const dominantFamilyProcedural = dominantFamilyLooksProcedural(familyEvidence);
    const orderAllowedByHint = documentTypeHintMatches(cand?.document_type, documentTypeHints ?? []);
    const allowCrossFamilyEvidence =
      familyAligned ||
      (kind === 'SECONDARY_ORDER'
        ? orderAllowedByHint || (orderRepeatedSupport && !dominantFamilyProcedural)
        : e.count_in_top30 >= CROSS_FAMILY_EVIDENCE_COUNT_OVERRIDE || e.max_score >= CROSS_FAMILY_EVIDENCE_SCORE_OVERRIDE);
    if (!allowCrossFamilyEvidence) {
      pushReasonCode(reasonCodes, 'CHUNKS_FAMILY_MISMATCH_DEMOTED');
      continue;
    }
      selected.push({
        rada_nreg: e.rada_nreg,
        act_title: cand?.title,
        score: e.max_ordering_score ?? e.max_score,
        why_selected: `count_in_top30=${e.count_in_top30} best_rank=${e.best_rank_in_top30 ?? '-'} max_score=${e.max_score.toFixed(2)}`,
        reason_tag: 'CHUNKS_EVIDENCE',
        source_tags: ['CHUNKS_EVIDENCE'],
      });
      fromChunksEvidence.push(e.rada_nreg);
  }

  // B) Add 1–2 from taxonomy/acts_search not yet covered by chunks (support). Noise control: BILL_DRAFT/CASELAW_OPINION/UNKNOWN only with evidence or doc_type hint.
  const cap = actSelectionLowConfidence ? Math.min(7, SELECTED_ACTS_MAX_OUT) : Math.min(5, SELECTED_ACTS_MAX_OUT);
  let wantMore = allowSingleActCoverageForMultiGoal
    ? 0
    : Math.max(selectedActsMin, Math.min(cap, selected.length + (isMultiGoal ? 2 : 1))) -
      selected.length;
  let docTypeHintAllowedUsed = false;
  if (wantMore > 0) {
    for (const a of actCandidatesTop) {
      if (selected.length >= SELECTED_ACTS_MAX_OUT) break;
      if (selected.some((s) => s.rada_nreg === a.rada_nreg)) continue;
      const source: string[] = [];
      if (taxonomyNregs.has(a.rada_nreg)) source.push('TAXONOMY');
      if (actsSearchNregs.includes(a.rada_nreg)) source.push('ACTS_SEARCH');
      if (source.length === 0) continue;
      const kind = classifyActKind(a.title ?? '', a.document_type, a.category);
      const hasEvidence = chunksEvidenceNregs.has(a.rada_nreg);
      const evidence = chunksEvidenceByNreg.get(a.rada_nreg);
      const hasMaterialEvidence = hasMaterialChunkEvidence(evidence);
      const strongTopRankEvidence = hasStrongTopRankEvidence(evidence);
      const allowedByHint = documentTypeHintMatches(a.document_type, documentTypeHints ?? []);
      const familyAligned = isFamilyAlignedSupportAct(a.category, familyEvidence);
      const dominantFamilyProcedural = dominantFamilyLooksProcedural(familyEvidence);
      const crossFamilyEvidenceOverride =
        (evidence?.count_in_top30 ?? 0) >= CROSS_FAMILY_EVIDENCE_COUNT_OVERRIDE ||
        (evidence?.max_score ?? 0) >= CROSS_FAMILY_EVIDENCE_SCORE_OVERRIDE;
      if (NOISE_KINDS.includes(kind) && !hasEvidence && !allowedByHint) {
        if (kind === 'BILL_DRAFT') pushReasonCode(reasonCodes, 'DRAFT_BLOCKED_NO_EVIDENCE');
        else if (kind === 'CASELAW_OPINION') pushReasonCode(reasonCodes, 'OPINION_BLOCKED_NO_EVIDENCE');
        else if (kind === 'KSU_DECISION') pushReasonCode(reasonCodes, 'KSU_BLOCKED_NO_EVIDENCE');
        continue;
      }
      // BILL_DRAFT: allow only when query/hints are project-related (or has evidence).
      if (kind === 'BILL_DRAFT' && !hasEvidence && (!allowedByHint || !hintsAllowDraft(documentTypeHints ?? []))) {
        pushReasonCode(reasonCodes, 'DRAFT_BLOCKED_NO_EVIDENCE');
        continue;
      }
      // CASELAW_OPINION: allow only with strong evidence (count>=3) or when no PRIMARY_LAW in candidates.
      if (kind === 'CASELAW_OPINION') {
        const ev = chunks_evidence_top_acts.find((e) => e.rada_nreg === a.rada_nreg);
        const strongEvidence = ev && ev.count_in_top30 >= 3;
        const hasPrimaryInCandidates = actCandidatesTop.some(
          (x) => classifyActKind(x.title ?? '', x.document_type, x.category) === 'PRIMARY_LAW'
        );
        if (!strongEvidence && hasPrimaryInCandidates) {
          pushReasonCode(reasonCodes, 'OPINION_BLOCKED_NO_EVIDENCE');
          continue;
        }
      }
      if (kind === 'KSU_DECISION') {
        const ev = chunks_evidence_top_acts.find((e) => e.rada_nreg === a.rada_nreg);
        const hasPrimaryInCandidates = actCandidatesTop.some(
          (x) => classifyActKind(x.title ?? '', x.document_type, x.category) === 'PRIMARY_LAW'
        );
        if ((hasPrimaryInCandidates && !hasStrongNonPrimarySupportEvidence(ev)) || shouldBlockKsuUnderPrimaryLawDominance(isMultiGoal, hasStrongPrimaryLawEvidence, ev)) {
          pushReasonCode(reasonCodes, 'KSU_BLOCKED_NO_EVIDENCE');
          continue;
        }
      }
      if (
        !isMultiGoal &&
        kind !== 'PRIMARY_LAW' &&
        hasStrongPrimaryLawEvidence &&
        !strongTopRankEvidence &&
        !canOverrideNonPrimaryPrimaryLawBlock(kind, evidence)
      ) {
        pushReasonCode(reasonCodes, 'NON_PRIMARY_SUPPORT_BLOCKED_PRIMARY_PRESENT');
        continue;
      }
      if (
        kind === 'SECONDARY_ORDER' &&
        !familyAligned &&
        !allowedByHint &&
        (!hasRepeatedSecondaryOrderSupport(evidence) || dominantFamilyProcedural)
      ) {
        pushReasonCode(reasonCodes, 'ORDER_UNRELATED_BLOCKED');
        continue;
      }
      if (!familyAligned && !allowedByHint && !crossFamilyEvidenceOverride && !strongTopRankEvidence) {
        pushReasonCode(reasonCodes, 'SUPPORT_FAMILY_MISMATCH_BLOCKED');
        continue;
      }
      const supportEligible = hasMaterialEvidence;
      if (!supportEligible) continue;
      if (allowedByHint && hasMaterialEvidence) docTypeHintAllowedUsed = true;
      selected.push({
        rada_nreg: a.rada_nreg,
        act_title: a.title,
        score: a.score,
        why_selected: a.why_tag ?? source.join('+'),
        reason_tag: source[0] ?? 'TAXONOMY',
        source_tags: source,
      });
      if (taxonomyNregs.has(a.rada_nreg)) fromTaxonomy.push(a.rada_nreg);
      if (actsSearchNregs.includes(a.rada_nreg)) fromActsSearch.push(a.rada_nreg);
      wantMore -= 1;
      if (wantMore <= 0) break;
    }
    if (docTypeHintAllowedUsed) pushReasonCode(reasonCodes, 'DOC_TYPE_HINT_ALLOWED');
  }

  // Enforce minimum: if we have fewer than SELECTED_ACTS_MIN, fill from actCandidatesTop
  while (selected.length < selectedActsMin && selected.length < actCandidatesTop.length) {
    const next = actCandidatesTop.find((a) => {
      if (selected.some((s) => s.rada_nreg === a.rada_nreg)) return false;
      return canFallbackSelectAct({
        candidate: a,
        evidence: chunksEvidenceByNreg.get(a.rada_nreg),
        documentTypeHints,
        familyEvidence,
        isMultiGoal,
        hasStrongPrimaryLawEvidence,
        actCandidatesTop,
      });
    });
    if (!next) break;
    const source: string[] = [];
    if (taxonomyNregs.has(next.rada_nreg)) source.push('TAXONOMY');
    if (actsSearchNregs.includes(next.rada_nreg)) source.push('ACTS_SEARCH');
    selected.push({
      rada_nreg: next.rada_nreg,
      act_title: next.title,
      score: next.score,
      why_selected: next.why_tag ?? (source.length ? source.join('+') : 'FALLBACK'),
      reason_tag: source[0] ?? 'FALLBACK',
      source_tags: source.length ? source : ['FALLBACK'],
    });
    if (taxonomyNregs.has(next.rada_nreg)) fromTaxonomy.push(next.rada_nreg);
    if (actsSearchNregs.includes(next.rada_nreg)) fromActsSearch.push(next.rada_nreg);
  }

  // --- Policy v2: anti-order dominance ---
  // At most 1 SECONDARY_ORDER in selected; only if it has chunks evidence. If PRIMARY_LAW dominates in chunks, drop orders that came only from taxonomy/acts_search.
  const primaryLawSupport = chunks_evidence_top_acts
    .filter((e) => {
      const cand = candidateByNreg.get(e.rada_nreg);
      return classifyActKind(cand?.title ?? '', cand?.document_type, cand?.category) === 'PRIMARY_LAW';
    })
    .reduce((s, e) => s + e.count_in_top30, 0);
  const orderSupport = chunks_evidence_top_acts
    .filter((e) => {
      const cand = candidateByNreg.get(e.rada_nreg);
      return classifyActKind(cand?.title ?? '', cand?.document_type, cand?.category) === 'SECONDARY_ORDER';
    })
    .reduce((s, e) => s + e.count_in_top30, 0);
  const primaryLawDominates = primaryLawSupport >= 2 && primaryLawSupport >= orderSupport * 1.5;

  const ordersInSelected = selected.filter((s) => {
    const cand = candidateByNreg.get(s.rada_nreg);
    return classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category) === 'SECONDARY_ORDER';
  });
  const ordersWithEvidence = ordersInSelected.filter((s) => chunksEvidenceNregs.has(s.rada_nreg));
  const toRemoveOrders = new Set<string>();
  if (ordersInSelected.length > 1 || (ordersInSelected.length === 1 && primaryLawDominates && !chunksEvidenceNregs.has(ordersInSelected[0].rada_nreg))) {
    if (ordersWithEvidence.length > 0 && !primaryLawDominates) {
      // Keep ALL orders with strong evidence (count ≥ threshold) — multiple relevant orders
      // can serve different regulatory purposes (e.g., energy rules + banking rules).
      // Only drop orders that are in chunksEvidenceNregs with weak count (< threshold).
      let keptCount = 0;
      for (const o of ordersInSelected) {
        const ev = chunks_evidence_top_acts.find((e) => e.rada_nreg === o.rada_nreg);
        const strongEvidence = ev && isStrongChunksEvidence(ev);
        const cand = candidateByNreg.get(o.rada_nreg);
        const orderFamilyAligned = isFamilyAlignedSupportAct(cand?.category, familyEvidence);
        const orderAllowedByHint = documentTypeHintMatches(cand?.document_type, documentTypeHints ?? []);
        const orderRepeatedSupport = hasRepeatedSecondaryOrderSupport(ev);
        if (chunksEvidenceNregs.has(o.rada_nreg) && strongEvidence && (orderFamilyAligned || orderAllowedByHint || orderRepeatedSupport)) {
          // Strong evidence: keep regardless of how many orders
          if (keptCount === 0) reasonCodes.push('ORDER_INCLUDED_BY_EVIDENCE');
          keptCount += 1;
        } else if (
          chunksEvidenceNregs.has(o.rada_nreg) &&
          keptCount === 0 &&
          (orderFamilyAligned || orderAllowedByHint || orderRepeatedSupport)
        ) {
          // Only keep the first order when it is still structurally supported.
          reasonCodes.push('ORDER_INCLUDED_BY_EVIDENCE');
          keptCount += 1;
        } else {
          toRemoveOrders.add(o.rada_nreg);
          if (orderFamilyAligned === false) reasonCodes.push('ORDER_UNRELATED_BLOCKED');
        }
      }
    } else {
      for (const o of ordersInSelected) toRemoveOrders.add(o.rada_nreg);
      if (ordersInSelected.length > 0) reasonCodes.push('ORDER_DOMINANCE_BLOCKED');
    }
  } else if (ordersInSelected.length === 1 && chunksEvidenceNregs.has(ordersInSelected[0].rada_nreg)) {
    const orderEvidence = chunksEvidenceByNreg.get(ordersInSelected[0].rada_nreg);
    const orderCandidate = candidateByNreg.get(ordersInSelected[0].rada_nreg);
    const orderFamilyAligned = isFamilyAlignedSupportAct(orderCandidate?.category, familyEvidence);
    const orderAllowedByHint = documentTypeHintMatches(orderCandidate?.document_type, documentTypeHints ?? []);
    const orderRepeatedSupport = hasRepeatedSecondaryOrderSupport(orderEvidence);
    const dominantFamilyProcedural = dominantFamilyLooksProcedural(familyEvidence);
    if (
      !primaryLawDominates ||
      (
        hasStrongNonPrimarySupportEvidence(orderEvidence) &&
        (orderFamilyAligned || orderAllowedByHint || (orderRepeatedSupport && !dominantFamilyProcedural))
      )
    ) {
      reasonCodes.push('ORDER_INCLUDED_BY_EVIDENCE');
    } else {
      toRemoveOrders.add(ordersInSelected[0].rada_nreg);
      if (!orderFamilyAligned) reasonCodes.push('ORDER_UNRELATED_BLOCKED');
      reasonCodes.push('ORDER_DOMINANCE_BLOCKED');
    }
  }
  if (toRemoveOrders.size > 0) {
    for (let i = selected.length - 1; i >= 0; i--) {
      if (toRemoveOrders.has(selected[i].rada_nreg)) selected.splice(i, 1);
    }
    fromChunksEvidence.splice(0, fromChunksEvidence.length, ...fromChunksEvidence.filter((n) => !toRemoveOrders.has(n)));
  }

  // --- Policy v2: KSU decisions need repeated evidence when primary law already dominates ---
  if (!isMultiGoal && hasStrongPrimaryLawEvidence) {
    const ksuToRemove = new Set<string>();
    for (const s of selected) {
      const cand = candidateByNreg.get(s.rada_nreg);
      const kind = classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category);
      if (kind !== 'KSU_DECISION') continue;
      if (!hasStrongNonPrimarySupportEvidence(chunksEvidenceByNreg.get(s.rada_nreg))) {
        ksuToRemove.add(s.rada_nreg);
      }
    }
    if (ksuToRemove.size > 0) {
      for (let i = selected.length - 1; i >= 0; i -= 1) {
        if (ksuToRemove.has(selected[i].rada_nreg)) selected.splice(i, 1);
      }
      fromChunksEvidence.splice(0, fromChunksEvidence.length, ...fromChunksEvidence.filter((n) => !ksuToRemove.has(n)));
      reasonCodes.push('KSU_BLOCKED_PRIMARY_PRESENT');
    }
  }

  if (isMultiGoal) {
    const selectedPrimaryLawCount = selected.filter((s) => {
      const cand = candidateByNreg.get(s.rada_nreg);
      return (
        classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category) ===
        'PRIMARY_LAW'
      );
    }).length;
    if (selectedPrimaryLawCount >= 2) {
      const multiGoalNoiseToRemove = new Set<string>();
      for (const s of selected) {
        const cand = candidateByNreg.get(s.rada_nreg);
        const kind = classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category);
        if (!NOISE_KINDS.includes(kind)) continue;
        if (!hasStrongNonPrimarySupportEvidence(chunksEvidenceByNreg.get(s.rada_nreg))) {
          multiGoalNoiseToRemove.add(s.rada_nreg);
        }
      }
      if (multiGoalNoiseToRemove.size > 0) {
        for (let i = selected.length - 1; i >= 0; i -= 1) {
          if (multiGoalNoiseToRemove.has(selected[i].rada_nreg)) selected.splice(i, 1);
        }
        fromChunksEvidence.splice(
          0,
          fromChunksEvidence.length,
          ...fromChunksEvidence.filter((n) => !multiGoalNoiseToRemove.has(n))
        );
        reasonCodes.push('MULTI_GOAL_NOISE_BLOCKED_PRIMARY_PRESENT');
      }
    }
  }

  // --- Policy v2: diversity guard (by act_kind) ---
  const selectedPrimaryLawCountForDiversity = selected.filter((s) => {
    const cand = candidateByNreg.get(s.rada_nreg);
    return (
      classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category) ===
      'PRIMARY_LAW'
    );
  }).length;
  const kindsInChunks = new Set<ActKind>();
  for (const e of chunks_evidence_top_acts) {
    if (!hasMaterialChunkEvidence(e)) continue;
    const cand = candidateByNreg.get(e.rada_nreg);
    kindsInChunks.add(classifyActKind(cand?.title ?? '', cand?.document_type, cand?.category));
  }
  const kindsInSelected = new Set(selected.map((s) => {
    const cand = candidateByNreg.get(s.rada_nreg);
    return classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category);
  }));
  let diversityGuardAdded = false;
  if (
    kindsInChunks.size >= DIVERSITY_EVIDENCE_KINDS_MIN &&
    kindsInSelected.size < 2 &&
    selectedPrimaryLawCountForDiversity === 0 &&
    !(!isMultiGoal && hasStrongPrimaryLawEvidence) &&
    !allowSingleActCoverageForMultiGoal
  ) {
    // Add one act from candidates with a different kind if possible
    const existingKinds = new Set(kindsInSelected);
    for (const a of actCandidatesTop) {
      if (selected.some((s) => s.rada_nreg === a.rada_nreg)) continue;
      if (selected.length >= SELECTED_ACTS_MAX_OUT) break;
      const k = classifyActKind(a.title ?? '', a.document_type, a.category);
      if (existingKinds.has(k)) continue;
      if (isMultiGoal && selectedPrimaryLawCountForDiversity >= 2 && NOISE_KINDS.includes(k)) continue;
      if (!hasMaterialChunkEvidence(chunksEvidenceByNreg.get(a.rada_nreg))) continue;
      const source: string[] = [];
      if (taxonomyNregs.has(a.rada_nreg)) source.push('TAXONOMY');
      if (actsSearchNregs.includes(a.rada_nreg)) source.push('ACTS_SEARCH');
      if (source.length === 0) continue;
      selected.push({
        rada_nreg: a.rada_nreg,
        act_title: a.title,
        score: a.score,
        why_selected: a.why_tag ?? 'DIVERSITY_GUARD',
        reason_tag: 'TAXONOMY',
        source_tags: [...source, 'DIVERSITY_GUARD'],
      });
      if (taxonomyNregs.has(a.rada_nreg)) fromTaxonomy.push(a.rada_nreg);
      if (actsSearchNregs.includes(a.rada_nreg)) fromActsSearch.push(a.rada_nreg);
      reasonCodes.push('DIVERSITY_GUARD_ENFORCED');
      diversityGuardAdded = true;
      break;
    }
  }

  // --- Policy v3: family coverage guard (per-goal family coverage) ---
  const familyGuardActions: Array<{ goal_id: string; family: string; added_rada_nreg?: string }> = [];
  let includedFromFamilyGuard = false;
  if (familyEvidence && selected.length < SELECTED_ACTS_MAX_OUT) {
    const goalId = input.goals_summary[0]?.goal_id ?? 'goal_0';
    if (
      familyEvidence.dominant_family_key &&
      familyEvidence.family_confidence >= FAMILY_GUARD_CONFIDENCE_THRESHOLD
    ) {
      const hasDominantFamily = selected.some((s) => {
        const cand = candidateByNreg.get(s.rada_nreg);
        if (classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category) !== 'PRIMARY_LAW') return false;
        return categoryToFamilyKey(cand?.category) === familyEvidence.dominant_family_key;
      });
      if (!hasDominantFamily) {
        const candidate = actCandidatesTop.find((a) => {
          if (selected.some((s) => s.rada_nreg === a.rada_nreg)) return false;
          if (classifyActKind(a.title ?? '', a.document_type, a.category) !== 'PRIMARY_LAW') return false;
          return categoryToFamilyKey(a.category) === familyEvidence.dominant_family_key;
        });
        if (candidate && candidateHasFamilyGuardEvidenceSupport(candidate.rada_nreg, chunksEvidenceByNreg)) {
          selected.push({
            rada_nreg: candidate.rada_nreg,
            act_title: candidate.title,
            score: candidate.score,
            why_selected: 'FAMILY_GUARD',
            reason_tag: 'FAMILY_GUARD',
            source_tags: ['FAMILY_GUARD'],
          });
          if (taxonomyNregs.has(candidate.rada_nreg)) fromTaxonomy.push(candidate.rada_nreg);
          if (actsSearchNregs.includes(candidate.rada_nreg)) fromActsSearch.push(candidate.rada_nreg);
          familyGuardActions.push({ goal_id: goalId, family: familyEvidence.dominant_family_key, added_rada_nreg: candidate.rada_nreg });
          includedFromFamilyGuard = true;
        } else {
          pushReasonCode(reasonCodes, candidate ? 'FAMILY_GUARD_NO_EVIDENCE' : 'COVERAGE_GUARD_FAILED');
        }
      }
    }
    if (
      familyEvidence.family_conflict &&
      familyEvidence.top2.length >= 2 &&
      familyEvidence.top2[0].support_score >= FAMILY_CONFLICT_TOP2_MIN &&
      familyEvidence.top2[1].support_score >= FAMILY_CONFLICT_TOP2_MIN &&
      selected.length < SELECTED_ACTS_MAX_OUT
    ) {
      const familiesToCover = [familyEvidence.top2[0].family_key, familyEvidence.top2[1].family_key];
      for (const fam of familiesToCover) {
        const hasFam = selected.some((s) => {
          const cand = candidateByNreg.get(s.rada_nreg);
          return classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category) === 'PRIMARY_LAW' && categoryToFamilyKey(cand?.category) === fam;
        });
        if (!hasFam) {
          const candidate = actCandidatesTop.find((a) => {
            if (selected.some((s) => s.rada_nreg === a.rada_nreg)) return false;
            if (classifyActKind(a.title ?? '', a.document_type, a.category) !== 'PRIMARY_LAW') return false;
            return categoryToFamilyKey(a.category) === fam;
          });
          if (
            candidate &&
            selected.length < SELECTED_ACTS_MAX_OUT &&
            candidateHasFamilyGuardEvidenceSupport(candidate.rada_nreg, chunksEvidenceByNreg)
          ) {
            selected.push({
              rada_nreg: candidate.rada_nreg,
              act_title: candidate.title,
              score: candidate.score,
              why_selected: 'FAMILY_GUARD',
              reason_tag: 'FAMILY_GUARD',
              source_tags: ['FAMILY_GUARD'],
            });
            if (taxonomyNregs.has(candidate.rada_nreg)) fromTaxonomy.push(candidate.rada_nreg);
            if (actsSearchNregs.includes(candidate.rada_nreg)) fromActsSearch.push(candidate.rada_nreg);
            familyGuardActions.push({ goal_id: goalId, family: fam, added_rada_nreg: candidate.rada_nreg });
            includedFromFamilyGuard = true;
          } else if (candidate) {
            pushReasonCode(reasonCodes, 'FAMILY_GUARD_NO_EVIDENCE');
          }
        }
      }
    }
  }

  // --- Safety net: if selected is empty but we have evidence or taxonomy, recover one act ---
  // Anti-order keep-one: if all candidates were SECONDARY_ORDER only, allow 1 best (by evidence then score).
  if (selected.length === 0) {
    const ordersOnly = actCandidatesTop.filter(
      (a) => classifyActKind(a.title ?? '', a.document_type, a.category) === 'SECONDARY_ORDER'
    );
    const hasPrimaryCandidate = actCandidatesTop.some(
      (a) => classifyActKind(a.title ?? '', a.document_type, a.category) === 'PRIMARY_LAW'
    );
    if (ordersOnly.length > 0 && !hasPrimaryCandidate) {
      const evidenceByNreg = new Map(chunks_evidence_top_acts.map((e) => [e.rada_nreg, e]));
      const bestOrder = [...ordersOnly].sort((a, b) => {
        const evA = evidenceByNreg.get(a.rada_nreg);
        const evB = evidenceByNreg.get(b.rada_nreg);
        const cA = evA?.count_in_top30 ?? 0;
        const cB = evB?.count_in_top30 ?? 0;
        if (cB !== cA) return cB - cA;
        const sA = evA?.max_score ?? a.score ?? 0;
        const sB = evB?.max_score ?? b.score ?? 0;
        return sB - sA;
      })[0];
      if (bestOrder) {
        const source: string[] = [];
        if (taxonomyNregs.has(bestOrder.rada_nreg)) source.push('TAXONOMY');
        if (actsSearchNregs.includes(bestOrder.rada_nreg)) source.push('ACTS_SEARCH');
        if (chunksEvidenceNregs.has(bestOrder.rada_nreg)) {
          source.push('CHUNKS_EVIDENCE');
          fromChunksEvidence.push(bestOrder.rada_nreg);
        }
        selected.push({
          rada_nreg: bestOrder.rada_nreg,
          act_title: bestOrder.title,
          score: bestOrder.score,
          why_selected: bestOrder.why_tag ?? 'ALL_SECONDARY_ORDER_ALLOWED_ONE',
          reason_tag: source[0] ?? 'TAXONOMY',
          source_tags: [...source, 'ALL_SECONDARY_ORDER_ALLOWED_ONE'],
        });
        if (taxonomyNregs.has(bestOrder.rada_nreg)) fromTaxonomy.push(bestOrder.rada_nreg);
        if (actsSearchNregs.includes(bestOrder.rada_nreg)) fromActsSearch.push(bestOrder.rada_nreg);
        reasonCodes.push('ALL_SECONDARY_ORDER_ALLOWED_ONE');
      }
    }
    if (selected.length === 0) {
      const sortedEvidence = [...chunks_evidence_top_acts].sort(
        (a, b) => (b.count_in_top30 - a.count_in_top30) || ((b.max_score ?? 0) - (a.max_score ?? 0))
      );
      const bestFromEvidence = sortedEvidence[0];
      if (bestFromEvidence) {
        const cand = candidateByNreg.get(bestFromEvidence.rada_nreg);
        selected.push({
          rada_nreg: bestFromEvidence.rada_nreg,
          act_title: cand?.title,
          score: bestFromEvidence.max_score,
          why_selected: `count_in_top30=${bestFromEvidence.count_in_top30} max_score=${bestFromEvidence.max_score?.toFixed(2)} (recovered)`,
          reason_tag: 'CHUNKS_EVIDENCE',
          source_tags: ['CHUNKS_EVIDENCE', 'EMPTY_RECOVERED'],
        });
        fromChunksEvidence.push(bestFromEvidence.rada_nreg);
        reasonCodes.push('EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE');
      } else {
        const primaryFromTaxonomy = actCandidatesTop.find((a) => {
          if (!taxonomyNregs.has(a.rada_nreg) && !actsSearchNregs.includes(a.rada_nreg)) return false;
          return classifyActKind(a.title ?? '', a.document_type, a.category) === 'PRIMARY_LAW';
        });
        if (primaryFromTaxonomy) {
          const source: string[] = [];
          if (taxonomyNregs.has(primaryFromTaxonomy.rada_nreg)) source.push('TAXONOMY');
          if (actsSearchNregs.includes(primaryFromTaxonomy.rada_nreg)) source.push('ACTS_SEARCH');
          selected.push({
            rada_nreg: primaryFromTaxonomy.rada_nreg,
            act_title: primaryFromTaxonomy.title,
            score: primaryFromTaxonomy.score,
            why_selected: primaryFromTaxonomy.why_tag ?? 'TAXONOMY (recovered)',
            reason_tag: source[0] ?? 'TAXONOMY',
            source_tags: [...source, 'EMPTY_RECOVERED'],
          });
          if (taxonomyNregs.has(primaryFromTaxonomy.rada_nreg)) fromTaxonomy.push(primaryFromTaxonomy.rada_nreg);
          if (actsSearchNregs.includes(primaryFromTaxonomy.rada_nreg)) fromActsSearch.push(primaryFromTaxonomy.rada_nreg);
          reasonCodes.push('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY');
        }
      }
    }
  }

  // --- Policy 4.3: drop BILL_DRAFT when PRIMARY_LAW present and user didn't ask for draft ---
  const hasPrimaryInSelected = selected.some((s) => {
    const cand = candidateByNreg.get(s.rada_nreg);
    return classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category) === 'PRIMARY_LAW';
  });
  if (hasPrimaryInSelected && !hintsAllowDraft(documentTypeHints ?? [])) {
    const draftNregs = new Set<string>();
    for (let i = selected.length - 1; i >= 0; i--) {
      const s = selected[i];
      const cand = candidateByNreg.get(s.rada_nreg);
      const k = classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category);
      if (k === 'BILL_DRAFT') {
        draftNregs.add(s.rada_nreg);
        selected.splice(i, 1);
      }
    }
    if (draftNregs.size > 0) {
      reasonCodes.push('DRAFT_DROPPED_PRIMARY_PRESENT');
      for (const nreg of draftNregs) {
        const idxF = fromChunksEvidence.indexOf(nreg);
        if (idxF >= 0) fromChunksEvidence.splice(idxF, 1);
        const idxT = fromTaxonomy.indexOf(nreg);
        if (idxT >= 0) fromTaxonomy.splice(idxT, 1);
        const idxA = fromActsSearch.indexOf(nreg);
        if (idxA >= 0) fromActsSearch.splice(idxA, 1);
      }
    }
  }

  const isSingleGoal = (input.goals_summary?.length ?? 0) <= 1;
  if (isSingleGoal && selected.length > 3) {
      const evidenceByNreg = new Map(
      chunks_evidence_top_acts.map((item) => [item.rada_nreg, item] as const)
    );
    const rankedByEvidence = [...selected].sort((left, right) => {
      const leftEvidence = evidenceByNreg.get(left.rada_nreg);
      const rightEvidence = evidenceByNreg.get(right.rada_nreg);
      if (leftEvidence && rightEvidence) {
        const diff = compareChunksEvidenceStrength(leftEvidence, rightEvidence);
        if (diff !== 0) return diff;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    });
    const evidenceAll = rankedByEvidence.reduce(
      (sum, act) => sum + (evidenceByNreg.get(act.rada_nreg)?.count_in_top30 ?? 0),
      0
    );
    const top3 = rankedByEvidence.slice(0, 3);
    const evidenceTop3 = top3.reduce(
      (sum, act) => sum + (evidenceByNreg.get(act.rada_nreg)?.count_in_top30 ?? 0),
      0
    );
    const trailingWeak = rankedByEvidence
      .slice(3)
      .every((act) => !isStrongChunksEvidence(evidenceByNreg.get(act.rada_nreg)));
    if (top3.length === 3 && (trailingWeak || (evidenceAll > 0 && evidenceTop3 / evidenceAll >= 0.8))) {
      const keep = new Set(top3.map((act) => act.rada_nreg));
      for (let i = selected.length - 1; i >= 0; i -= 1) {
        if (!keep.has(selected[i].rada_nreg)) selected.splice(i, 1);
      }
      reasonCodes.push('SINGLE_GOAL_TAIL_TRIMMED');
    }
  }

  if (
    isSingleGoal &&
    familyEvidence?.dominant_family_key &&
    familyEvidence.family_confidence >= FAMILY_GUARD_CONFIDENCE_THRESHOLD &&
    !familyEvidence.family_conflict
  ) {
    const selectedPrimaryActs = selected.filter((act) => {
      const cand = candidateByNreg.get(act.rada_nreg);
      return (
        classifyActKind(cand?.title ?? act.act_title ?? '', cand?.document_type, cand?.category) ===
        'PRIMARY_LAW'
      );
    });
    if (selectedPrimaryActs.length > 1) {
      const rankedPrimaryActs = [...selectedPrimaryActs].sort((left, right) => {
        const leftEvidence = chunksEvidenceByNreg.get(left.rada_nreg);
        const rightEvidence = chunksEvidenceByNreg.get(right.rada_nreg);
        if (leftEvidence && rightEvidence) {
          const diff = compareChunksEvidenceStrength(leftEvidence, rightEvidence);
          if (diff !== 0) return diff;
        }
        return (right.score ?? 0) - (left.score ?? 0);
      });
      const dominantAct = rankedPrimaryActs[0];
      const dominantCandidate = candidateByNreg.get(dominantAct.rada_nreg);
      const dominantEvidence = chunksEvidenceByNreg.get(dominantAct.rada_nreg);
      const dominantFamilyKey = categoryToFamilyKey(dominantCandidate?.category);
      if (
        dominantEvidence &&
        isStrongChunksEvidence(dominantEvidence) &&
        dominantFamilyKey === familyEvidence.dominant_family_key
      ) {
        const offFamilyPrimaryActs = rankedPrimaryActs.slice(1).filter((act) => {
          const candidate = candidateByNreg.get(act.rada_nreg);
          const familyKey = categoryToFamilyKey(candidate?.category);
          if (familyKey === familyEvidence.dominant_family_key) return false;
          const evidence = chunksEvidenceByNreg.get(act.rada_nreg);
          if (isStrongChunksEvidence(evidence)) return false;
          const dominantRankMass = dominantEvidence.rank_mass_top30 ?? 0;
          const candidateRankMass = evidence?.rank_mass_top30 ?? 0;
          return dominantRankMass >= candidateRankMass * SINGLE_GOAL_PRIMARY_FAMILY_DOMINANCE_RATIO;
        });
        if (offFamilyPrimaryActs.length > 0) {
          const offFamilyNregs = new Set(offFamilyPrimaryActs.map((act) => act.rada_nreg));
          for (let index = selected.length - 1; index >= 0; index -= 1) {
            if (offFamilyNregs.has(selected[index].rada_nreg)) selected.splice(index, 1);
          }
          reasonCodes.push('SINGLE_GOAL_OFF_FAMILY_PRIMARY_TRIMMED');
        }
      }
    }
  }

  if (isMultiGoal && selected.length > input.goals_summary.length + 1) {
    const rankedByEvidence = [...selected].sort((left, right) => {
      const leftEvidence = chunksEvidenceByNreg.get(left.rada_nreg);
      const rightEvidence = chunksEvidenceByNreg.get(right.rada_nreg);
      if (leftEvidence && rightEvidence) {
        const diff = compareChunksEvidenceStrength(leftEvidence, rightEvidence);
        if (diff !== 0) return diff;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    });
    const targetCount = selectedActsMin;
    const trailingActs = rankedByEvidence.slice(targetCount);
    const trailingWeak = trailingActs.every((act) => {
      const evidence = chunksEvidenceByNreg.get(act.rada_nreg);
      return !isStrongChunksEvidence(evidence);
    });
    if (trailingActs.length > 0 && trailingWeak) {
      const keep = new Set(rankedByEvidence.slice(0, targetCount).map((act) => act.rada_nreg));
      for (let index = selected.length - 1; index >= 0; index -= 1) {
        if (!keep.has(selected[index].rada_nreg)) selected.splice(index, 1);
      }
      reasonCodes.push('MULTI_GOAL_TAIL_TRIMMED');
    }
  }

  if (allowSingleActCoverageForMultiGoal && selected.length > 1) {
    const rankedByEvidence = [...selected].sort((left, right) => {
      const leftEvidence = chunksEvidenceByNreg.get(left.rada_nreg);
      const rightEvidence = chunksEvidenceByNreg.get(right.rada_nreg);
      if (leftEvidence && rightEvidence) {
        const diff = compareChunksEvidenceStrength(leftEvidence, rightEvidence);
        if (diff !== 0) return diff;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    });
    const keep = new Set(rankedByEvidence.slice(0, 1).map((act) => act.rada_nreg));
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (!keep.has(selected[index].rada_nreg)) selected.splice(index, 1);
    }
    reasonCodes.push('MULTI_GOAL_SINGLE_ACT_TAIL_TRIMMED');
  }

  // Enrich selected items for Writer: document_type, category, act_kind, flags (E.2)
  for (const s of selected) {
    const cand = candidateByNreg.get(s.rada_nreg);
    s.document_type = cand?.document_type ?? null;
    s.category = cand?.category ?? null;
    s.act_kind = classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category);
    s.flags = {
      recovered: s.source_tags?.includes('EMPTY_RECOVERED') ?? false,
      keep_one: s.source_tags?.includes('ALL_SECONDARY_ORDER_ALLOWED_ONE') ?? false,
      draft: false,
      opinion: false,
    };
    if (s.act_kind === 'BILL_DRAFT') s.flags.draft = true;
    if (s.act_kind === 'CASELAW_OPINION') s.flags.opinion = true;
  }

  // Cap total for harness invariant (≤9)
  const selectedCapped = selected.slice(0, SELECTED_ACTS_MAX_OUT);

  if (fromChunksEvidence.length > 0) reasonCodes.push('SELECTED_ACTS_FROM_CHUNKS_EVIDENCE');
  if (diversityGuardAdded) {
    reasonCodes.push('SELECTED_ACTS_DIVERSITY_ENFORCED');
  }
  if (allowSingleActCoverageForMultiGoal) {
    reasonCodes.push('MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED');
  }

  // Confidence: do NOT lower only because we trimmed orders. Use evidence strength.
  let selected_acts_confidence = 0.5;
  const recoveredEmpty =
    reasonCodes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE') ||
    reasonCodes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY');
  const allSecondaryOrderAllowedOne = reasonCodes.includes('ALL_SECONDARY_ORDER_ALLOWED_ONE');
  if (recoveredEmpty || allSecondaryOrderAllowedOne) {
    selected_acts_confidence = 0.5;
  } else if (fromChunksEvidence.length > 0) {
    const strong = chunks_evidence_top_acts.filter(
      (e) => isStrongChunksEvidence(e) || e.max_score >= CHUNKS_EVIDENCE_SCORE_THRESHOLD
    ).length;
    selected_acts_confidence = strong >= 2 ? 0.9 : strong >= 1 ? 0.75 : 0.6;
  } else if (selectedCapped.length >= 2) {
    selected_acts_confidence = 0.55;
  } else {
    reasonCodes.push('NO_STRONG_ACT_EVIDENCE');
  }

  const selectedNregs = new Set(selectedCapped.map((s) => s.rada_nreg));
  const minDistinctForMultiGoal =
    input.goals_summary?.length >= 2
      ? allowSingleActCoverageForMultiGoal
        ? 1
        : input.goals_summary.length
      : 0;
  if (minDistinctForMultiGoal > 0 && selectedCapped.length > 0) {
    const distinctCount = selectedNregs.size;
    if (distinctCount < minDistinctForMultiGoal) {
      reasonCodes.push('COVERAGE_MISS_SELECTED_ACTS');
      selected_acts_confidence = Math.min(selected_acts_confidence, 0.5);
    }
  }

  const selected_acts_decision = {
    policy_version: includedFromFamilyGuard ? 3 : 2,
    included_from_chunks_evidence: fromChunksEvidence.length > 0,
    included_from_family_guard: includedFromFamilyGuard,
    family_guard_actions: familyGuardActions.length ? familyGuardActions : undefined,
    reason_codes: reasonCodes,
  };

  // selected_acts_kinds_count for trace
  const selected_acts_kinds_count: SelectedActsKindsCount = {};
  const docTypeCounts = new Map<string, number>();
  for (const s of selectedCapped) {
    const cand = candidateByNreg.get(s.rada_nreg);
    const k = classifyActKind(cand?.title ?? s.act_title ?? '', cand?.document_type, cand?.category);
    selected_acts_kinds_count[k] = (selected_acts_kinds_count[k] ?? 0) + 1;
    const dt = cand?.document_type?.trim();
    if (dt) docTypeCounts.set(dt, (docTypeCounts.get(dt) ?? 0) + 1);
  }
  const selected_acts_document_types_top = [...docTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([docType]) => docType);

  return {
    selected_acts: selectedCapped,
    selected_acts_confidence,
    selected_acts_reason_codes: reasonCodes,
    selected_acts_sources_breakdown: {
      from_taxonomy: [...new Set(fromTaxonomy)].filter((n) => selectedNregs.has(n)),
      from_acts_search: [...new Set(fromActsSearch)].filter((n) => selectedNregs.has(n)),
      from_chunks_evidence: fromChunksEvidence.filter((n) => selectedNregs.has(n)),
    },
    chunks_evidence_top_acts,
    selected_acts_decision,
    selected_acts_kinds_count,
    selected_acts_document_types_top:
      selected_acts_document_types_top.length > 0 ? selected_acts_document_types_top : undefined,
  };
}
