import { collectCoveredGoalIdsForActs, type GoalSupportByAct } from './goal-support.js';
import {
  extractActReferenceSignals,
  extractQuotedActTitleFragments,
  normalizeActReferenceCue,
} from './act-taxonomy-store.js';
import {
  areCompatiblePrimaryFamilies,
  hasOnlyCompatiblePrimaryFamilies,
  isDomainHintAlignedFamily,
  isSpecificDomainHint,
  toFamilyKey,
} from './family-alignment.js';
import {
  hasActTitleSupportOverlap,
  isInterrogativePrimaryLawLocatorQuery,
  isExplicitlyHintedSupportActCandidate,
  isMetadataGroundedActCandidate,
  queryRequestsPrimaryLawLikeAct,
} from './single-goal-act-scope.js';
import {
  CHUNKS_EVIDENCE_COUNT_THRESHOLD,
  CHUNKS_EVIDENCE_SCORE_THRESHOLD,
  classifyActKind,
  type ChunksEvidenceItem,
  type SelectedActOutput,
  type SelectedActsKindsCount,
} from './selected-acts.js';
import { compareTrimEvidence, sameRadaNreg, uniqueStrings } from './retrieval-utils.js';
import type { RawHit } from './types.js';

type GoalSummaryLike = {
  goal_id: string;
  goal_type?: string;
  subquery_preview?: string;
  act_candidates_top3?: string[];
  required_categories?: string[];
};

type GoalSummaryCoverageLike = GoalSummaryLike & {
  hits_count?: number;
  top_score?: number | null;
};

type SupportedActLike = {
  rada_nreg: string;
  act_kind?: string | null;
  category?: string | null;
};

type ActCandidateLike = {
  rada_nreg: string;
  category?: string | null;
  title?: string;
  score?: number;
  reasons?: string[];
  document_type?: string | null;
  document_type_slug?: string | null;
};

type SelectedActsSourcesBreakdownLike = {
  from_taxonomy?: string[];
  from_acts_search?: string[];
  from_chunks_evidence?: string[];
};

type MultiGoalSelectedActsFinalizationOutput = {
  selectedActsConfidence: number;
  metadataGroundedActCount: number;
  selectedActsSourcesBreakdown: {
    from_taxonomy: string[];
    from_acts_search: string[];
    from_chunks_evidence: string[];
  };
  selectedActsKindsCount: SelectedActsKindsCount;
  selectedActsDocumentTypesTop?: string[];
};

type ExplicitPrimaryActMultiGoalResolution = {
  selectedActs: SelectedActOutput[];
  selectedActsSourcesBreakdown: MultiGoalSelectedActsFinalizationOutput['selectedActsSourcesBreakdown'];
  allowSingleActCoverage: boolean;
  changed: boolean;
  reasonCodes: string[];
};

const MULTI_GOAL_METADATA_GROUNDING_REASON_CODES = new Set([
  'exact_alias_match',
  'exact_title_match',
]);

const STRONG_PRIMARY_LOCATOR_SEMANTIC_REASON_CODES = new Set([
  'exact_alias_match',
  'exact_title_match',
  'alias_match',
  'title_match',
  'summary_match',
  'keyword_match',
  'topic_match',
]);

const STRONG_MULTI_GOAL_RECOVERY_REASON_CODES = new Set([
  'exact_alias_match',
  'exact_title_match',
  'alias_match',
  'title_match',
  'summary_match',
  'keyword_match',
  'topic_match',
]);

const EXPLICIT_PRIMARY_ANCHOR_MAX_BEST_RANK = 12;
const EXPLICIT_PRIMARY_ANCHOR_MIN_ORDERING_SCORE = 0.36;

const MULTI_GOAL_VARIANT_MIN_HITS = 6;
const MULTI_GOAL_VARIANT_MIN_TOP_SCORE = 0.48;
const GENERIC_EXPLICIT_TITLE_ANCHOR_TOKENS = new Set([
  'закон',
  'закону',
  'україни',
  'угода',
  'угоди',
  'про',
  'між',
  'який',
  'яка',
  'яке',
  'які',
  'яких',
  'саме',
  'цей',
]);

function normalizeQuotedPrimaryAnchorKey(value: string | undefined | null): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeExplicitTitleAnchor(
  value: string | undefined | null,
  documentType: string | undefined | null
): string[] {
  const documentCue = normalizeActReferenceCue(documentType);
  return uniqueStrings(
    String(value ?? '')
      .normalize('NFC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
      .filter((token) => !GENERIC_EXPLICIT_TITLE_ANCHOR_TOKENS.has(token))
      .filter((token) => normalizeActReferenceCue(token) !== documentCue)
  );
}

function softAnchorTokenMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 6 || right.length < 6) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function getQuotedPrimaryAnchorSignals(query: string): string[] {
  return uniqueStrings(extractQuotedActTitleFragments(query)).filter(
    (signal) => tokenizeExplicitTitleAnchor(signal, null).length >= 2
  );
}

function getRawQuotedPrimaryAnchorSignals(query: string): string[] {
  return uniqueStrings(extractQuotedActTitleFragments(query));
}

function getQuotedPrimaryAnchorStrength(
  signals: string[],
  candidate: ActCandidateLike | undefined
): {
  bestExactSignalTokens: number;
  matchedSignals: number;
  bestMatchedTokens: number;
  bestCoverage: number;
  bestSignalTokenCount: number;
} {
  if (!candidate || signals.length === 0) {
    return {
      bestExactSignalTokens: 0,
      matchedSignals: 0,
      bestMatchedTokens: 0,
      bestCoverage: 0,
      bestSignalTokenCount: 0,
    };
  }
  const candidateTokens = tokenizeExplicitTitleAnchor(candidate.title, candidate.document_type);
  const candidateTitleKey = normalizeQuotedPrimaryAnchorKey(candidate.title);
  if (candidateTokens.length === 0) {
    return {
      bestExactSignalTokens: 0,
      matchedSignals: 0,
      bestMatchedTokens: 0,
      bestCoverage: 0,
      bestSignalTokenCount: 0,
    };
  }
  let bestExactSignalTokens = 0;
  let matchedSignals = 0;
  let bestMatchedTokens = 0;
  let bestCoverage = 0;
  let bestSignalTokenCount = 0;
  for (const signal of signals) {
    const signalTokens = tokenizeExplicitTitleAnchor(signal, candidate.document_type);
    if (signalTokens.length < 2) continue;
    const signalKey = normalizeQuotedPrimaryAnchorKey(signal);
    if (candidateTitleKey && signalKey && candidateTitleKey.includes(signalKey)) {
      bestExactSignalTokens = Math.max(bestExactSignalTokens, signalTokens.length);
    }
    const matchedTokens = signalTokens.filter((token) =>
      candidateTokens.some((candidateToken) => softAnchorTokenMatch(token, candidateToken))
    ).length;
    if (matchedTokens === 0) continue;
    matchedSignals += 1;
    const coverage = matchedTokens / signalTokens.length;
    if (
      matchedTokens > bestMatchedTokens ||
      (matchedTokens === bestMatchedTokens && coverage > bestCoverage) ||
      (matchedTokens === bestMatchedTokens && coverage === bestCoverage && signalTokens.length > bestSignalTokenCount)
    ) {
      bestMatchedTokens = matchedTokens;
      bestCoverage = coverage;
      bestSignalTokenCount = signalTokens.length;
    }
  }
  return { bestExactSignalTokens, matchedSignals, bestMatchedTokens, bestCoverage, bestSignalTokenCount };
}

function getExactQuotedPrimaryAnchorSignalTokenCount(
  signals: string[],
  candidate: ActCandidateLike | undefined
): number {
  if (!candidate || signals.length === 0) return 0;
  const candidateTitleKey = normalizeQuotedPrimaryAnchorKey(candidate.title);
  if (!candidateTitleKey) return 0;
  let bestExactSignalTokens = 0;
  for (const signal of signals) {
    const signalTokens = tokenizeExplicitTitleAnchor(signal, candidate.document_type);
    if (signalTokens.length < 2) continue;
    const signalKey = normalizeQuotedPrimaryAnchorKey(signal);
    if (signalKey && candidateTitleKey.includes(signalKey)) {
      bestExactSignalTokens = Math.max(bestExactSignalTokens, signalTokens.length);
    }
  }
  return bestExactSignalTokens;
}

function countActsWithUniqueGoalContribution(
  acts: SelectedActOutput[],
  goalSupportByAct: GoalSupportByAct
): number {
  return acts.filter((act) => {
    const ownGoals = goalSupportByAct.get(act.rada_nreg);
    if (!ownGoals || ownGoals.size === 0) return false;
    const otherGoals = new Set<string>();
    for (const otherAct of acts) {
      if (otherAct.rada_nreg === act.rada_nreg) continue;
      const goals = goalSupportByAct.get(otherAct.rada_nreg);
      if (!goals) continue;
      for (const goalId of goals) otherGoals.add(goalId);
    }
    return [...ownGoals].some((goalId) => !otherGoals.has(goalId));
  }).length;
}

function countSummaryAnchoredGoalsForAct(
  radaNreg: string,
  goalsSummary: GoalSummaryLike[]
): number {
  return goalsSummary.filter((goal) =>
    (goal.act_candidates_top3 ?? []).some((candidateRadaNreg) => sameRadaNreg(candidateRadaNreg, radaNreg))
  ).length;
}

function countGoalLocalHitsForAct(
  radaNreg: string,
  hits: RawHit[],
  requiredGoalIds: Set<string>
): number {
  return hits.filter(
    (hit) =>
      sameRadaNreg(hit.rada_nreg, radaNreg) &&
      !!hit.goal_id &&
      requiredGoalIds.has(String(hit.goal_id).trim())
  ).length;
}

function countGoalAnchoredUniqueContributionsForAct(input: {
  radaNreg: string;
  selectedActs: SelectedActOutput[];
  goalsSummary: GoalSummaryLike[];
  goalSupportByAct: GoalSupportByAct;
  requiredGoalIds: Set<string>;
  finalHits: RawHit[];
}): number {
  const ownGoalIds = collectEffectiveGoalIdsForAct({
    radaNreg: input.radaNreg,
    goalsSummary: input.goalsSummary,
    goalSupportByAct: input.goalSupportByAct,
    requiredGoalIds: input.requiredGoalIds,
    finalHits: input.finalHits,
  });
  if (ownGoalIds.size === 0) return 0;

  const otherGoalIds = new Set<string>();
  for (const act of input.selectedActs) {
    if (sameRadaNreg(act.rada_nreg, input.radaNreg)) continue;
    for (const goalId of collectEffectiveGoalIdsForAct({
      radaNreg: act.rada_nreg,
      goalsSummary: input.goalsSummary,
      goalSupportByAct: input.goalSupportByAct,
      requiredGoalIds: input.requiredGoalIds,
      finalHits: input.finalHits,
    })) {
      otherGoalIds.add(goalId);
    }
  }

  return [...ownGoalIds].filter((goalId) => {
    if (otherGoalIds.has(goalId)) return false;
    const summaryAnchored = input.goalsSummary.some(
      (goal) =>
        goal.goal_id === goalId &&
        (goal.act_candidates_top3 ?? []).some((candidateRadaNreg) => sameRadaNreg(candidateRadaNreg, input.radaNreg))
    );
    if (summaryAnchored) return true;
    return input.finalHits.some(
      (hit) => sameRadaNreg(hit.rada_nreg, input.radaNreg) && String(hit.goal_id ?? '').trim() === goalId
    );
  }).length;
}

function collectEffectiveGoalIdsForAct(input: {
  radaNreg: string;
  goalsSummary: GoalSummaryLike[];
  goalSupportByAct: GoalSupportByAct;
  requiredGoalIds: Set<string>;
  finalHits: RawHit[];
}): Set<string> {
  const goalIds = collectGoalIdsForAct(input.radaNreg, input.goalSupportByAct, input.requiredGoalIds);
  for (const goal of input.goalsSummary) {
    const goalId = goal.goal_id.trim();
    if (!goalId || !input.requiredGoalIds.has(goalId)) continue;
    if ((goal.act_candidates_top3 ?? []).some((candidateRadaNreg) => sameRadaNreg(candidateRadaNreg, input.radaNreg))) {
      goalIds.add(goalId);
      continue;
    }
    if (
      input.finalHits.some(
        (hit) => sameRadaNreg(hit.rada_nreg, input.radaNreg) && String(hit.goal_id ?? '').trim() === goalId
      )
    ) {
      goalIds.add(goalId);
    }
  }
  return goalIds;
}

function hasStrongGoalAnchoredCrossFamilyBundle(input: {
  domainHint?: string;
  goalsSummary: GoalSummaryLike[];
  selectedActs: SelectedActOutput[];
  goalSupportByAct: GoalSupportByAct;
  finalHits?: RawHit[];
  metadataGroundedActCount?: number;
}): boolean {
  const requiredGoalIds = new Set(
    input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  if (requiredGoalIds.size < 2 || input.selectedActs.length < 2) return false;

  const distinctPrimaryFamilies = [
    ...new Set(
      input.selectedActs
        .map((act) => toFamilyKey(act.category))
        .filter((familyKey) => familyKey !== 'unknown')
    ),
  ];
  if (distinctPrimaryFamilies.length < 2 || distinctPrimaryFamilies.length > 2) return false;

  const coveredGoalIds = new Set<string>();
  const finalHits = input.finalHits ?? [];
  for (const act of input.selectedActs) {
    for (const goalId of collectEffectiveGoalIdsForAct({
      radaNreg: act.rada_nreg,
      goalsSummary: input.goalsSummary,
      goalSupportByAct: input.goalSupportByAct,
      requiredGoalIds,
      finalHits,
    })) {
      coveredGoalIds.add(goalId);
    }
  }
  if (coveredGoalIds.size < requiredGoalIds.size) return false;

  let anchoredActs = 0;
  let uniquelyAnchoredActs = 0;
  for (const act of input.selectedActs) {
    const summaryAnchoredGoalCount = countSummaryAnchoredGoalsForAct(act.rada_nreg, input.goalsSummary);
    const goalLocalHitCount = countGoalLocalHitsForAct(act.rada_nreg, finalHits, requiredGoalIds);
    if (summaryAnchoredGoalCount === 0 && goalLocalHitCount === 0) continue;
    anchoredActs += 1;
    if (
      countGoalAnchoredUniqueContributionsForAct({
        radaNreg: act.rada_nreg,
        selectedActs: input.selectedActs,
        goalsSummary: input.goalsSummary,
        goalSupportByAct: input.goalSupportByAct,
        requiredGoalIds,
        finalHits,
      }) > 0
    ) {
      uniquelyAnchoredActs += 1;
    }
  }
  if (anchoredActs < Math.min(2, input.selectedActs.length)) return false;
  if (uniquelyAnchoredActs === 0) return false;

  const hasDomainAlignedSelectedFamily = distinctPrimaryFamilies.some((familyKey) =>
    isDomainHintAlignedFamily(input.domainHint, familyKey)
  );
  return hasDomainAlignedSelectedFamily || (input.metadataGroundedActCount ?? 0) > 0;
}

function collectGoalIdsForAct(
  radaNreg: string,
  goalSupportByAct: GoalSupportByAct,
  requiredGoalIds: Set<string>
): Set<string> {
  const supportedGoalIds = goalSupportByAct.get(radaNreg);
  if (!supportedGoalIds || supportedGoalIds.size === 0 || requiredGoalIds.size === 0) return new Set();
  return new Set([...supportedGoalIds].filter((goalId) => requiredGoalIds.has(goalId)));
}

function hasStrongChunksEvidence(item: ChunksEvidenceItem | undefined): boolean {
  if (!item) return false;
  const bestRank = item.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const orderingScore = item.max_ordering_score ?? item.max_score;
  return (
    item.count_in_top30 >= CHUNKS_EVIDENCE_COUNT_THRESHOLD ||
    (bestRank <= 5 && orderingScore >= CHUNKS_EVIDENCE_SCORE_THRESHOLD)
  );
}

function hasStrongMultiGoalRecoverySemanticSupport(candidate: ActCandidateLike | undefined): boolean {
  if (!candidate) return false;
  if ((candidate.score ?? 0) < 1) return false;
  return candidate.reasons?.some((reasonCode) => STRONG_MULTI_GOAL_RECOVERY_REASON_CODES.has(reasonCode)) === true;
}

function isProceduralPrimaryLawActLike(act: Pick<SelectedActOutput, 'act_kind' | 'category' | 'act_title'>): boolean {
  if (act.act_kind !== 'PRIMARY_LAW') return false;
  const familyKey = toFamilyKey(act.category);
  if (familyKey.includes('procedure') || familyKey === 'judiciary_justice') return true;
  const normalizedTitle = String(act.act_title ?? '')
    .normalize('NFC')
    .toLowerCase();
  return normalizedTitle.includes('процесуальн') || normalizedTitle.includes('судочинств');
}

function normalizeSelectedActsSourcesBreakdown(
  selectedActs: SelectedActOutput[],
  breakdown: SelectedActsSourcesBreakdownLike | undefined
): MultiGoalSelectedActsFinalizationOutput['selectedActsSourcesBreakdown'] {
  const selectedNregs = new Set(selectedActs.map((act) => act.rada_nreg));
  const next = {
    from_taxonomy: [...new Set((breakdown?.from_taxonomy ?? []).filter((radaNreg) => selectedNregs.has(radaNreg)))],
    from_acts_search: [...new Set((breakdown?.from_acts_search ?? []).filter((radaNreg) => selectedNregs.has(radaNreg)))],
    from_chunks_evidence: [
      ...new Set((breakdown?.from_chunks_evidence ?? []).filter((radaNreg) => selectedNregs.has(radaNreg))),
    ],
  };
  for (const act of selectedActs) {
    const radaNreg = act.rada_nreg?.trim();
    if (!radaNreg) continue;
    const sourceTags = new Set(act.source_tags ?? []);
    if (sourceTags.has('TAXONOMY')) {
      next.from_taxonomy = [...new Set([...next.from_taxonomy, radaNreg])];
    }
    if (sourceTags.has('ACTS_SEARCH')) {
      next.from_acts_search = [...new Set([...next.from_acts_search, radaNreg])];
    }
    if (sourceTags.has('CHUNKS_EVIDENCE')) {
      next.from_chunks_evidence = [...new Set([...next.from_chunks_evidence, radaNreg])];
    }
  }
  return next;
}

function hasSameSelectedActSet(left: SelectedActOutput[], right: SelectedActOutput[]): boolean {
  if (left.length !== right.length) return false;
  const leftNregs = [...left.map((act) => act.rada_nreg)].sort();
  const rightNregs = [...right.map((act) => act.rada_nreg)].sort();
  return leftNregs.every((radaNreg, index) => radaNreg === rightNregs[index]);
}

function buildRecoveredExplicitPrimaryAct(input: {
  candidate: ActCandidateLike;
  evidence: ChunksEvidenceItem | undefined;
}): SelectedActOutput {
  const orderingScore = input.evidence?.max_ordering_score ?? input.evidence?.max_score ?? input.candidate.score;
  return {
    rada_nreg: input.candidate.rada_nreg,
    act_title: input.candidate.title ?? input.candidate.rada_nreg,
    score: orderingScore,
    why_selected: `explicit_primary_anchor best_rank=${input.evidence?.best_rank_in_top30 ?? 'n/a'} max_score=${(
      orderingScore ?? 0
    ).toFixed(2)}`,
    reason_tag: 'CHUNKS_EVIDENCE',
    source_tags: ['CHUNKS_EVIDENCE', 'EXPLICIT_PRIMARY_ACT_RECOVERED'],
    document_type: input.candidate.document_type ?? null,
    category: input.candidate.category ?? null,
    act_kind: classifyActKind(
      input.candidate.title ?? input.candidate.rada_nreg,
      input.candidate.document_type ?? null,
      input.candidate.category ?? null,
      input.candidate.document_type_slug ?? null
    ),
    flags: {
      recovered: true,
      keep_one: false,
      draft: false,
      opinion: false,
    },
  };
}

function buildRecoveredMultiGoalAct(input: {
  candidate: ActCandidateLike;
  evidence: ChunksEvidenceItem | undefined;
}): SelectedActOutput {
  const orderingScore = input.evidence?.max_ordering_score ?? input.evidence?.max_score ?? input.candidate.score;
  return {
    rada_nreg: input.candidate.rada_nreg,
    act_title: input.candidate.title ?? input.candidate.rada_nreg,
    score: orderingScore,
    why_selected: `goal_recovery best_rank=${input.evidence?.best_rank_in_top30 ?? 'n/a'} max_score=${(
      orderingScore ?? 0
    ).toFixed(2)}`,
    reason_tag: input.evidence ? 'CHUNKS_EVIDENCE' : 'TAXONOMY_TOP',
    source_tags: input.evidence ? ['CHUNKS_EVIDENCE', 'GOAL_RECOVERY'] : ['TAXONOMY', 'GOAL_RECOVERY'],
    document_type: input.candidate.document_type ?? null,
    category: input.candidate.category ?? null,
    act_kind: classifyActKind(
      input.candidate.title ?? input.candidate.rada_nreg,
      input.candidate.document_type ?? null,
      input.candidate.category ?? null,
      input.candidate.document_type_slug ?? null
    ),
    flags: {
      recovered: true,
      keep_one: false,
      draft: false,
      opinion: false,
    },
  };
}

function hasUsableExplicitPrimaryAnchorEvidence(evidence: ChunksEvidenceItem | undefined): boolean {
  if (!evidence) return false;
  const bestRank = evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const orderingScore = evidence.max_ordering_score ?? evidence.max_score ?? 0;
  return bestRank <= EXPLICIT_PRIMARY_ANCHOR_MAX_BEST_RANK && orderingScore >= EXPLICIT_PRIMARY_ANCHOR_MIN_ORDERING_SCORE;
}

function hasStrongPrimaryLocatorSemanticSupport(candidate: ActCandidateLike | undefined): boolean {
  if (!candidate) return false;
  if ((candidate.score ?? 0) < 1) return false;
  return candidate.reasons?.some((reasonCode) => STRONG_PRIMARY_LOCATOR_SEMANTIC_REASON_CODES.has(reasonCode)) === true;
}

function matchesRequestedPrimaryLawCue(query: string, candidate: ActCandidateLike | undefined): boolean {
  if (!candidate) return false;
  const requestedCue =
    extractActReferenceSignals(query)
      .map((signal) => normalizeActReferenceCue(signal))
      .find(Boolean) ?? normalizeActReferenceCue(query);
  if (!requestedCue) return true;
  return [candidate.document_type, candidate.document_type_slug, candidate.title].some(
    (value) => normalizeActReferenceCue(value) === requestedCue
  );
}

function collectExplicitPrimaryCompanionActs(input: {
  anchorCandidate: ActCandidateLike;
  selectedActs: SelectedActOutput[];
  candidateByNreg: Map<string, ActCandidateLike>;
  evidenceByNreg: Map<string, ChunksEvidenceItem>;
  goalsSummary: GoalSummaryLike[];
  goalSupportByAct: GoalSupportByAct;
}): SelectedActOutput[] {
  const requiredGoalIds = new Set(
    input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  if (requiredGoalIds.size < 2) return [];

  const anchorFamilyKey = toFamilyKey(input.anchorCandidate.category);
  const anchorGoalIds = collectGoalIdsForAct(
    input.anchorCandidate.rada_nreg,
    input.goalSupportByAct,
    requiredGoalIds
  );

  return input.selectedActs.filter((act) => {
    if (act.rada_nreg === input.anchorCandidate.rada_nreg) return false;
    const candidate = input.candidateByNreg.get(act.rada_nreg);
    const actKind =
      act.act_kind ??
      classifyActKind(
        candidate?.title ?? act.act_title ?? act.rada_nreg,
        candidate?.document_type ?? act.document_type ?? null,
        candidate?.category ?? act.category ?? null,
        candidate?.document_type_slug ?? null
      );
    if (actKind !== 'PRIMARY_LAW') return false;
    if (!hasStrongChunksEvidence(input.evidenceByNreg.get(act.rada_nreg))) return false;

    const candidateFamilyKey = toFamilyKey(candidate?.category ?? act.category);
    if (!areCompatiblePrimaryFamilies(anchorFamilyKey, candidateFamilyKey)) return false;

    const hasGoalLevelCandidateSupport = input.goalsSummary.some((goal) => goal.act_candidates_top3?.includes(act.rada_nreg));
    if (!hasGoalLevelCandidateSupport) return false;

    const actGoalIds = collectGoalIdsForAct(act.rada_nreg, input.goalSupportByAct, requiredGoalIds);
    if (actGoalIds.size === 0) return false;
    return [...actGoalIds].some((goalId) => !anchorGoalIds.has(goalId));
  });
}

export function resolveExplicitPrimaryActMultiGoalSelection(input: {
  query: string;
  documentTypeHints?: string[];
  selectedActs: SelectedActOutput[];
  selectedActsSourcesBreakdown: SelectedActsSourcesBreakdownLike | undefined;
  actCandidatesTop: ActCandidateLike[];
  chunksEvidenceTopActs: ChunksEvidenceItem[];
  goalsSummary: GoalSummaryLike[];
  goalSupportByAct: GoalSupportByAct;
}): ExplicitPrimaryActMultiGoalResolution {
  const baseBreakdown = normalizeSelectedActsSourcesBreakdown(input.selectedActs, input.selectedActsSourcesBreakdown);
  if (!queryRequestsPrimaryLawLikeAct(input.query, input.documentTypeHints)) {
    return {
      selectedActs: input.selectedActs,
      selectedActsSourcesBreakdown: baseBreakdown,
      allowSingleActCoverage: false,
      changed: false,
      reasonCodes: [],
    };
  }
  const interrogativePrimaryLawLocator = isInterrogativePrimaryLawLocatorQuery(input.query);
  const rawQuotedPrimaryAnchorSignals = getRawQuotedPrimaryAnchorSignals(input.query);
  const quotedPrimaryAnchorSignals = getQuotedPrimaryAnchorSignals(input.query);
  const strictQuotedPrimaryActLocator = rawQuotedPrimaryAnchorSignals.length > 0;

  const candidateByNreg = new Map(
    input.actCandidatesTop.map((candidate) => [candidate.rada_nreg, candidate] as const)
  );
  const evidenceByNreg = new Map(
    input.chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const)
  );
  const selectedByNreg = new Map(
    input.selectedActs.map((act) => [act.rada_nreg, act] as const)
  );

  const anchoredPrimaryCandidates = input.actCandidatesTop
    .filter((candidate) => {
      const evidence = evidenceByNreg.get(candidate.rada_nreg);
      const quotedTitleStrength = getQuotedPrimaryAnchorStrength(quotedPrimaryAnchorSignals, candidate);
      if (
        classifyActKind(
          candidate.title ?? candidate.rada_nreg,
          candidate.document_type ?? null,
          candidate.category ?? null,
          candidate.document_type_slug ?? null
        ) !== 'PRIMARY_LAW'
      ) {
        return false;
      }
      const metadataGrounded = isMetadataGroundedActCandidate(
        candidate,
        input.query,
        MULTI_GOAL_METADATA_GROUNDING_REASON_CODES
      );
      const goal0Anchored =
        input.goalsSummary[0]?.act_candidates_top3?.[0] === candidate.rada_nreg &&
        (
          selectedByNreg.has(candidate.rada_nreg) ||
          (evidence?.max_score ?? 0) >= 0.75
        );
      const quotedTitleAnchored =
        strictQuotedPrimaryActLocator &&
        (
          quotedTitleStrength.bestExactSignalTokens >= 4 ||
          (quotedTitleStrength.bestMatchedTokens >= 3 && quotedTitleStrength.bestCoverage >= 0.5)
        );
      if (!metadataGrounded && !goal0Anchored && !quotedTitleAnchored) {
        return false;
      }
      if (interrogativePrimaryLawLocator && !metadataGrounded) {
        if (!matchesRequestedPrimaryLawCue(input.query, candidate)) {
          return false;
        }
        const titleOverlap = hasActTitleSupportOverlap(
          input.query,
          candidate.title,
          candidate.document_type
        );
        const semanticSupport = hasStrongPrimaryLocatorSemanticSupport(candidate);
        if (!titleOverlap && !semanticSupport) {
          return false;
        }
      }
      return hasUsableExplicitPrimaryAnchorEvidence(evidence);
    })
    .sort((left, right) => {
      if (strictQuotedPrimaryActLocator) {
        const leftQuotedStrength = getQuotedPrimaryAnchorStrength(quotedPrimaryAnchorSignals, left);
        const rightQuotedStrength = getQuotedPrimaryAnchorStrength(quotedPrimaryAnchorSignals, right);
        if (leftQuotedStrength.bestExactSignalTokens !== rightQuotedStrength.bestExactSignalTokens) {
          return rightQuotedStrength.bestExactSignalTokens - leftQuotedStrength.bestExactSignalTokens;
        }
        if (leftQuotedStrength.matchedSignals !== rightQuotedStrength.matchedSignals) {
          return rightQuotedStrength.matchedSignals - leftQuotedStrength.matchedSignals;
        }
        if (leftQuotedStrength.bestMatchedTokens !== rightQuotedStrength.bestMatchedTokens) {
          return rightQuotedStrength.bestMatchedTokens - leftQuotedStrength.bestMatchedTokens;
        }
        if (leftQuotedStrength.bestCoverage !== rightQuotedStrength.bestCoverage) {
          return rightQuotedStrength.bestCoverage - leftQuotedStrength.bestCoverage;
        }
        if (leftQuotedStrength.bestSignalTokenCount !== rightQuotedStrength.bestSignalTokenCount) {
          return rightQuotedStrength.bestSignalTokenCount - leftQuotedStrength.bestSignalTokenCount;
        }
      }

      const leftGoal0Top1 = Number(input.goalsSummary[0]?.act_candidates_top3?.[0] === left.rada_nreg);
      const rightGoal0Top1 = Number(input.goalsSummary[0]?.act_candidates_top3?.[0] === right.rada_nreg);
      if (leftGoal0Top1 !== rightGoal0Top1) return rightGoal0Top1 - leftGoal0Top1;

      const leftGoalHits = input.goalsSummary.filter((goal) => goal.act_candidates_top3?.includes(left.rada_nreg)).length;
      const rightGoalHits = input.goalsSummary.filter((goal) => goal.act_candidates_top3?.includes(right.rada_nreg)).length;
      if (leftGoalHits !== rightGoalHits) return rightGoalHits - leftGoalHits;

      return compareTrimEvidence(
        {
          score: left.score,
          rankMassTop30: evidenceByNreg.get(left.rada_nreg)?.rank_mass_top30,
          bestRankInTop30: evidenceByNreg.get(left.rada_nreg)?.best_rank_in_top30,
        },
        {
          score: right.score,
          rankMassTop30: evidenceByNreg.get(right.rada_nreg)?.rank_mass_top30,
          bestRankInTop30: evidenceByNreg.get(right.rada_nreg)?.best_rank_in_top30,
        }
      );
    });

  const exactQuotedPrimaryCandidates = strictQuotedPrimaryActLocator
    ? input.actCandidatesTop
        .filter((candidate) => {
          if (
            classifyActKind(
              candidate.title ?? candidate.rada_nreg,
              candidate.document_type ?? null,
              candidate.category ?? null,
              candidate.document_type_slug ?? null
            ) !== 'PRIMARY_LAW'
          ) {
            return false;
          }
          if (!hasUsableExplicitPrimaryAnchorEvidence(evidenceByNreg.get(candidate.rada_nreg))) {
            return false;
          }
          return getExactQuotedPrimaryAnchorSignalTokenCount(rawQuotedPrimaryAnchorSignals, candidate) >= 4;
        })
        .sort((left, right) => {
          const leftExactSignalTokens = getExactQuotedPrimaryAnchorSignalTokenCount(
            rawQuotedPrimaryAnchorSignals,
            left
          );
          const rightExactSignalTokens = getExactQuotedPrimaryAnchorSignalTokenCount(
            rawQuotedPrimaryAnchorSignals,
            right
          );
          if (leftExactSignalTokens !== rightExactSignalTokens) {
            return rightExactSignalTokens - leftExactSignalTokens;
          }

          const leftGoalHits = input.goalsSummary.filter((goal) =>
            goal.act_candidates_top3?.includes(left.rada_nreg)
          ).length;
          const rightGoalHits = input.goalsSummary.filter((goal) =>
            goal.act_candidates_top3?.includes(right.rada_nreg)
          ).length;
          if (leftGoalHits !== rightGoalHits) return rightGoalHits - leftGoalHits;

          return compareTrimEvidence(
            {
              score: left.score,
              rankMassTop30: evidenceByNreg.get(left.rada_nreg)?.rank_mass_top30,
              bestRankInTop30: evidenceByNreg.get(left.rada_nreg)?.best_rank_in_top30,
            },
            {
              score: right.score,
              rankMassTop30: evidenceByNreg.get(right.rada_nreg)?.rank_mass_top30,
              bestRankInTop30: evidenceByNreg.get(right.rada_nreg)?.best_rank_in_top30,
            }
          );
        })
    : [];

  const goal0TopCandidateNreg = input.goalsSummary[0]?.act_candidates_top3?.[0] ?? null;
  let anchorCandidate = exactQuotedPrimaryCandidates[0] ?? anchoredPrimaryCandidates[0];
  if (!anchorCandidate && goal0TopCandidateNreg) {
    const selectedGoal0Primary = input.selectedActs.find(
      (act) =>
        act.rada_nreg === goal0TopCandidateNreg &&
        act.act_kind === 'PRIMARY_LAW' &&
        hasUsableExplicitPrimaryAnchorEvidence(evidenceByNreg.get(act.rada_nreg))
    );
    if (selectedGoal0Primary) {
      anchorCandidate = candidateByNreg.get(selectedGoal0Primary.rada_nreg) ?? {
        rada_nreg: selectedGoal0Primary.rada_nreg,
        title: selectedGoal0Primary.act_title,
        score: selectedGoal0Primary.score,
        category: selectedGoal0Primary.category,
        document_type: selectedGoal0Primary.document_type ?? undefined,
      };
    }
  }
  if (!anchorCandidate) {
    return {
      selectedActs: input.selectedActs,
      selectedActsSourcesBreakdown: baseBreakdown,
      allowSingleActCoverage: false,
      changed: false,
      reasonCodes: [],
    };
  }
  const anchorMetadataGrounded = isMetadataGroundedActCandidate(
    anchorCandidate,
    input.query,
    MULTI_GOAL_METADATA_GROUNDING_REASON_CODES
  );
  if (interrogativePrimaryLawLocator && !anchorMetadataGrounded) {
    if (!matchesRequestedPrimaryLawCue(input.query, anchorCandidate)) {
      return {
        selectedActs: input.selectedActs,
        selectedActsSourcesBreakdown: baseBreakdown,
        allowSingleActCoverage: false,
        changed: false,
        reasonCodes: [],
      };
    }
    const titleOverlap = hasActTitleSupportOverlap(
      input.query,
      anchorCandidate.title,
      anchorCandidate.document_type
    );
    const semanticSupport = hasStrongPrimaryLocatorSemanticSupport(anchorCandidate);
    if (!titleOverlap && !semanticSupport) {
      return {
        selectedActs: input.selectedActs,
        selectedActsSourcesBreakdown: baseBreakdown,
        allowSingleActCoverage: false,
        changed: false,
        reasonCodes: [],
      };
    }
  }

  const anchorSelectedAct =
    selectedByNreg.get(anchorCandidate.rada_nreg) ?? buildRecoveredExplicitPrimaryAct({
      candidate: anchorCandidate,
      evidence: evidenceByNreg.get(anchorCandidate.rada_nreg),
    });

  const preservedPrimaryCompanions = collectExplicitPrimaryCompanionActs({
    anchorCandidate,
    selectedActs: input.selectedActs,
    candidateByNreg,
    evidenceByNreg,
    goalsSummary: input.goalsSummary,
    goalSupportByAct: input.goalSupportByAct,
  });
  const normalizedSelectedActs: SelectedActOutput[] = [anchorSelectedAct, ...preservedPrimaryCompanions];
  const anchorFamilyKey = toFamilyKey(anchorCandidate.category);
  for (const act of input.selectedActs) {
    if (act.rada_nreg === anchorCandidate.rada_nreg) continue;
    if (normalizedSelectedActs.some((selectedAct) => selectedAct.rada_nreg === act.rada_nreg)) continue;
    const candidate = candidateByNreg.get(act.rada_nreg);
    const evidence = evidenceByNreg.get(act.rada_nreg);
    const actKind =
      act.act_kind ??
      classifyActKind(
        candidate?.title ?? act.act_title ?? act.rada_nreg,
        candidate?.document_type ?? act.document_type ?? null,
        candidate?.category ?? act.category ?? null,
        candidate?.document_type_slug ?? null
      );
    if (actKind === 'PRIMARY_LAW') continue;
    const candidateFamilyKey = toFamilyKey(candidate?.category ?? act.category);
    const sameFamily = anchorFamilyKey !== 'unknown' && candidateFamilyKey === anchorFamilyKey;
    const hasGoalLevelCandidateSupport = input.goalsSummary.some((goal) => goal.act_candidates_top3?.includes(act.rada_nreg));
    const explicitlyHintedSupport = isExplicitlyHintedSupportActCandidate({
      query: input.query,
      act: { act_title: act.act_title },
      candidate,
      documentTypeHints: input.documentTypeHints ?? [],
    });
    const sameFamilySupportAllowed =
      sameFamily &&
      !strictQuotedPrimaryActLocator &&
      hasGoalLevelCandidateSupport &&
      hasStrongChunksEvidence(evidence);
    const explicitSupportAllowed = explicitlyHintedSupport && hasGoalLevelCandidateSupport;
    if (!sameFamilySupportAllowed && !explicitSupportAllowed) continue;
    normalizedSelectedActs.push(act);
  }

  const normalizedBreakdown = normalizeSelectedActsSourcesBreakdown(
    normalizedSelectedActs,
    {
      from_taxonomy: [...new Set([...baseBreakdown.from_taxonomy, anchorCandidate.rada_nreg])],
      from_acts_search: baseBreakdown.from_acts_search,
      from_chunks_evidence: evidenceByNreg.has(anchorCandidate.rada_nreg)
        ? [...new Set([...baseBreakdown.from_chunks_evidence, anchorCandidate.rada_nreg])]
        : baseBreakdown.from_chunks_evidence,
    }
  );

  const changed = !hasSameSelectedActSet(normalizedSelectedActs, input.selectedActs);
  const reasonCodes: string[] = [];
  if (!selectedByNreg.has(anchorCandidate.rada_nreg)) {
    reasonCodes.push('MULTI_GOAL_EXPLICIT_PRIMARY_ACT_RECOVERED');
  }
  if (normalizedSelectedActs.length < input.selectedActs.length) {
    reasonCodes.push('MULTI_GOAL_EXPLICIT_PRIMARY_TAIL_TRIMMED');
  }
  if (preservedPrimaryCompanions.length > 0) {
    reasonCodes.push('MULTI_GOAL_EXPLICIT_PRIMARY_COMPANION_PRESERVED');
  } else {
    reasonCodes.push('MULTI_GOAL_EXPLICIT_PRIMARY_SINGLE_ACT_ALLOWED');
  }

  return {
    selectedActs: normalizedSelectedActs,
    selectedActsSourcesBreakdown: normalizedBreakdown,
    allowSingleActCoverage: preservedPrimaryCompanions.length === 0,
    changed,
    reasonCodes,
  };
}

export function finalizeMultiGoalSelectedActs(input: {
  selectedActs: SelectedActOutput[];
  originalSelectedActs: SelectedActOutput[];
  baseSelectedActsConfidence: number;
  selectedActsSourcesBreakdown: SelectedActsSourcesBreakdownLike;
  chunksEvidenceTopActs: ChunksEvidenceItem[];
  goalsSummary: GoalSummaryLike[];
  goalSupportByAct: GoalSupportByAct;
}): MultiGoalSelectedActsFinalizationOutput {
  const selectedActsSourcesBreakdown = normalizeSelectedActsSourcesBreakdown(
    input.selectedActs,
    input.selectedActsSourcesBreakdown
  );
  const selectedActsKindsCount: SelectedActsKindsCount = {};
  const selectedActsDocumentTypeCounts = new Map<string, number>();
  for (const act of input.selectedActs) {
    const actKind = act.act_kind ?? 'UNKNOWN';
    selectedActsKindsCount[actKind] = (selectedActsKindsCount[actKind] ?? 0) + 1;
    const documentType = act.document_type?.trim();
    if (documentType) {
      selectedActsDocumentTypeCounts.set(documentType, (selectedActsDocumentTypeCounts.get(documentType) ?? 0) + 1);
    }
  }

  const metadataGroundedActCount = new Set(selectedActsSourcesBreakdown.from_taxonomy).size;

  let selectedActsConfidence = input.baseSelectedActsConfidence;
  if (!hasSameSelectedActSet(input.selectedActs, input.originalSelectedActs)) {
    const evidenceByNreg = new Map(
      input.chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const)
    );
    if (selectedActsSourcesBreakdown.from_chunks_evidence.length > 0) {
      const strongEvidenceCount = input.selectedActs.filter((act) =>
        hasStrongChunksEvidence(evidenceByNreg.get(act.rada_nreg))
      ).length;
      selectedActsConfidence =
        strongEvidenceCount >= 2 ? 0.9 : strongEvidenceCount >= 1 ? 0.75 : 0.6;
    } else if (input.selectedActs.length >= 2) {
      selectedActsConfidence = 0.55;
    } else if (input.selectedActs.length === 1) {
      selectedActsConfidence = 0.5;
    }

    const selectedPrimaryActs = input.selectedActs.filter((act) => act.act_kind === 'PRIMARY_LAW');
    if (selectedPrimaryActs.length === 0 && input.selectedActs.length > 0) {
      selectedActsConfidence = Math.min(selectedActsConfidence, 0.55);
    }
    const requiredGoalIds = new Set(
      input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
    );
    if (requiredGoalIds.size >= 2 && input.selectedActs.length > 0) {
      const coveredGoalIds = collectCoveredGoalIdsForActs(input.selectedActs, input.goalSupportByAct);
      if (coveredGoalIds.size < requiredGoalIds.size) {
        selectedActsConfidence = Math.min(selectedActsConfidence, 0.5);
      }
    }
  }

  const selectedActsDocumentTypesTop = [...selectedActsDocumentTypeCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([documentType]) => documentType);

  return {
    selectedActsConfidence,
    metadataGroundedActCount,
    selectedActsSourcesBreakdown,
    selectedActsKindsCount,
    selectedActsDocumentTypesTop:
      selectedActsDocumentTypesTop.length > 0 ? selectedActsDocumentTypesTop : undefined,
  };
}

export function trimUngroundedMultiGoalFallbackSelection(input: {
  selectedActs: SelectedActOutput[];
  chunksEvidenceTopActs: ChunksEvidenceItem[];
  maxActs?: number;
  goalsSummary?: GoalSummaryLike[];
  goalSupportByAct?: GoalSupportByAct;
  domainHint?: string;
  mismatchSignalsPresent?: boolean;
  finalHits?: RawHit[];
}): SelectedActOutput[] {
  const maxActs = Math.max(1, input.maxActs ?? 2);
  if (input.selectedActs.length === 0) return input.selectedActs;

  const evidenceByNreg = new Map(
    input.chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const)
  );
  const requiredGoalIds = new Set(
    (input.goalsSummary ?? []).map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  const goalSupportByAct = input.goalSupportByAct ?? new Map<string, Set<string>>();
  const distinctFamilies = [
    ...new Set(
      input.selectedActs
        .map((act) => toFamilyKey(act.category))
        .filter((familyKey) => familyKey !== 'unknown')
    ),
  ];
  const hasDomainAlignedSelectedFamily = distinctFamilies.some((familyKey) =>
    isDomainHintAlignedFamily(input.domainHint, familyKey)
  );
  const noDomainAlignedSelectedFamily =
    isSpecificDomainHint(input.domainHint) &&
    distinctFamilies.length > 0 &&
    !hasDomainAlignedSelectedFamily;

  const metrics = input.selectedActs.map((act) => {
    const coveredGoalIds = collectGoalIdsForAct(act.rada_nreg, goalSupportByAct, requiredGoalIds);
    const otherCoveredGoalIds = new Set<string>();
    for (const otherAct of input.selectedActs) {
      if (otherAct.rada_nreg === act.rada_nreg) continue;
      for (const goalId of collectGoalIdsForAct(otherAct.rada_nreg, goalSupportByAct, requiredGoalIds)) {
        otherCoveredGoalIds.add(goalId);
      }
    }
    const evidence = evidenceByNreg.get(act.rada_nreg);
    const summaryAnchoredGoalCount = countSummaryAnchoredGoalsForAct(act.rada_nreg, input.goalsSummary ?? []);
    const goalLocalHitCount = countGoalLocalHitsForAct(act.rada_nreg, input.finalHits ?? [], requiredGoalIds);
    const strongEvidence =
      (evidence?.count_in_top30 ?? 0) >= CHUNKS_EVIDENCE_COUNT_THRESHOLD ||
      (
        (evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 5 &&
        (evidence?.max_ordering_score ?? evidence?.max_score ?? act.score ?? 0) >= CHUNKS_EVIDENCE_SCORE_THRESHOLD
      );
    return {
      act,
      coveredGoalIds,
      coveredGoalCount: coveredGoalIds.size,
      uniqueGoalCount: [...coveredGoalIds].filter((goalId) => !otherCoveredGoalIds.has(goalId)).length,
      summaryAnchoredGoalCount,
      goalLocalHitCount,
      strongSummaryAnchor: summaryAnchoredGoalCount > 0 && strongEvidence,
      domainAligned: isDomainHintAlignedFamily(input.domainHint, toFamilyKey(act.category)),
      rankMassTop30: evidence?.rank_mass_top30 ?? 0,
      bestRankInTop30: evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY,
      score: act.score ?? 0,
    };
  });

  const compareMetrics = (
    left: (typeof metrics)[number],
    right: (typeof metrics)[number],
    coveredGoalIds: Set<string>
  ): number => {
    const leftNewGoals = [...left.coveredGoalIds].filter((goalId) => !coveredGoalIds.has(goalId)).length;
    const rightNewGoals = [...right.coveredGoalIds].filter((goalId) => !coveredGoalIds.has(goalId)).length;
    if (leftNewGoals !== rightNewGoals) return rightNewGoals - leftNewGoals;
    if (left.uniqueGoalCount !== right.uniqueGoalCount) return right.uniqueGoalCount - left.uniqueGoalCount;
    if (left.strongSummaryAnchor !== right.strongSummaryAnchor) {
      return Number(right.strongSummaryAnchor) - Number(left.strongSummaryAnchor);
    }
    if (left.summaryAnchoredGoalCount !== right.summaryAnchoredGoalCount) {
      return right.summaryAnchoredGoalCount - left.summaryAnchoredGoalCount;
    }
    if (left.goalLocalHitCount !== right.goalLocalHitCount) {
      return right.goalLocalHitCount - left.goalLocalHitCount;
    }
    if (left.coveredGoalCount !== right.coveredGoalCount) return right.coveredGoalCount - left.coveredGoalCount;
    const evidenceDiff = compareTrimEvidence(left, right);
    if (evidenceDiff !== 0) return evidenceDiff;
    if (left.domainAligned !== right.domainAligned) return Number(right.domainAligned) - Number(left.domainAligned);
    return 0;
  };

  if (input.selectedActs.length <= maxActs) {
    const hasStrongGoalAnchoredTwoActBundle =
      input.selectedActs.length === 2 &&
      metrics.filter((item) => item.strongSummaryAnchor).length === 2;
    if (hasStrongGoalAnchoredTwoActBundle) return input.selectedActs;
    const shouldCollapseRedundantTwoActBundle =
      input.selectedActs.length === 2 &&
      (
        noDomainAlignedSelectedFamily ||
        (input.mismatchSignalsPresent && metrics.every((item) => item.uniqueGoalCount === 0)) ||
        (!hasOnlyCompatiblePrimaryFamilies(distinctFamilies) &&
          metrics.filter((item) => item.uniqueGoalCount > 0).length < 2)
      );
    if (!shouldCollapseRedundantTwoActBundle) return input.selectedActs;
    return [...metrics]
      .sort((left, right) => compareMetrics(left, right, new Set()))
      .slice(0, 1)
      .map((item) => item.act);
  }

  const selectedMetrics: typeof metrics = [];
  const coveredGoalIds = new Set<string>();
  const remainingMetrics = [...metrics];
  while (selectedMetrics.length < maxActs && remainingMetrics.length > 0) {
    remainingMetrics.sort((left, right) => compareMetrics(left, right, coveredGoalIds));
    const next = remainingMetrics.shift();
    if (!next) break;
    selectedMetrics.push(next);
    for (const goalId of next.coveredGoalIds) coveredGoalIds.add(goalId);
  }

  return selectedMetrics.map((item) => item.act);
}

export function trimLowConfidenceMultiGoalSelection(input: {
  selectedActs: SelectedActOutput[];
  chunksEvidenceTopActs: ChunksEvidenceItem[];
  maxActs?: number;
  goalsSummary?: GoalSummaryLike[];
  goalSupportByAct?: GoalSupportByAct;
  domainHint?: string;
  mismatchSignalsPresent?: boolean;
  finalHits?: RawHit[];
}): SelectedActOutput[] {
  // Reuse the goal-aware trim policy so early low-confidence normalization
  // does not drop the only act with unique goal coverage before finalization.
  return trimUngroundedMultiGoalFallbackSelection(input);
}

export function recoverUncoveredMultiGoalActs(input: {
  selectedActs: SelectedActOutput[];
  actCandidatesTop: ActCandidateLike[];
  chunksEvidenceTopActs: ChunksEvidenceItem[];
  goalsSummary: GoalSummaryCoverageLike[];
  goalSupportByAct: GoalSupportByAct;
  domainHint?: string;
  maxActs?: number;
}): SelectedActOutput[] {
  const maxActs = Math.max(input.selectedActs.length, Math.max(1, input.maxActs ?? 2));
  if (input.selectedActs.length === 0 || input.selectedActs.length >= maxActs) {
    return input.selectedActs;
  }

  const requiredGoalIds = new Set(
    input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  if (requiredGoalIds.size < 2) return input.selectedActs;

  const goalById = new Map(
    input.goalsSummary.map((goal) => [goal.goal_id, goal] as const)
  );
  const evidenceByNreg = new Map(
    input.chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const)
  );
  const selectedActs = [...input.selectedActs];
  const selectedNregs = new Set(selectedActs.map((act) => act.rada_nreg));

  while (selectedActs.length < maxActs) {
    const coveredGoalIds = collectCoveredGoalIdsForActs(selectedActs, input.goalSupportByAct);
    const uncoveredGoalIds = new Set(
      [...requiredGoalIds].filter((goalId) => !coveredGoalIds.has(goalId))
    );
    if (uncoveredGoalIds.size === 0) break;

    const selectedFamilies = selectedActs
      .map((act) => toFamilyKey(act.category))
      .filter((familyKey) => familyKey !== 'unknown');

    const recoveredCandidate = input.actCandidatesTop
      .filter((candidate) => !selectedNregs.has(candidate.rada_nreg))
      .map((candidate) => {
        const actKind = classifyActKind(
          candidate.title ?? candidate.rada_nreg,
          candidate.document_type ?? null,
          candidate.category ?? null,
          candidate.document_type_slug ?? null
        );
        if (actKind !== 'PRIMARY_LAW') return null;

        const candidateGoalIds = collectGoalIdsForAct(candidate.rada_nreg, input.goalSupportByAct, requiredGoalIds);
        const uncoveredMatches = [...candidateGoalIds].filter((goalId) => uncoveredGoalIds.has(goalId));
        if (uncoveredMatches.length === 0) return null;

        const evidence = evidenceByNreg.get(candidate.rada_nreg);
        const strongEvidence = hasStrongChunksEvidence(evidence);
        const strongSemantic = hasStrongMultiGoalRecoverySemanticSupport(candidate);
        if (!strongEvidence && !strongSemantic) return null;

        const familyKey = toFamilyKey(candidate.category);
        const domainAligned = isDomainHintAlignedFamily(input.domainHint, familyKey);
        const compatibleWithSelected = selectedFamilies.some((selectedFamily) =>
          areCompatiblePrimaryFamilies(selectedFamily, familyKey)
        );
        const proceduralLike = isProceduralPrimaryLawActLike({
          act_kind: 'PRIMARY_LAW',
          category: candidate.category ?? null,
          act_title: candidate.title ?? candidate.rada_nreg,
        });
        const categoryMatchedGoals = uncoveredMatches.filter((goalId) => {
          const requiredCategories = goalById.get(goalId)?.required_categories?.filter(Boolean) ?? [];
          if (requiredCategories.length === 0) return true;
          return !!candidate.category && requiredCategories.includes(candidate.category);
        }).length;

        return {
          candidate,
          evidence,
          uncoveredGoalCount: uncoveredMatches.length,
          categoryMatchedGoals,
          domainAligned,
          compatibleWithSelected,
          proceduralLike,
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if ((left?.categoryMatchedGoals ?? 0) !== (right?.categoryMatchedGoals ?? 0)) {
          return (right?.categoryMatchedGoals ?? 0) - (left?.categoryMatchedGoals ?? 0);
        }
        if ((left?.uncoveredGoalCount ?? 0) !== (right?.uncoveredGoalCount ?? 0)) {
          return (right?.uncoveredGoalCount ?? 0) - (left?.uncoveredGoalCount ?? 0);
        }
        if ((left?.domainAligned ?? false) !== (right?.domainAligned ?? false)) {
          return Number(right?.domainAligned ?? false) - Number(left?.domainAligned ?? false);
        }
        if ((left?.compatibleWithSelected ?? false) !== (right?.compatibleWithSelected ?? false)) {
          return Number(right?.compatibleWithSelected ?? false) - Number(left?.compatibleWithSelected ?? false);
        }
        if ((left?.proceduralLike ?? false) !== (right?.proceduralLike ?? false)) {
          return Number(right?.proceduralLike ?? false) - Number(left?.proceduralLike ?? false);
        }
        return compareTrimEvidence(
          {
            score: left?.candidate.score,
            rankMassTop30: left?.evidence?.rank_mass_top30,
            bestRankInTop30: left?.evidence?.best_rank_in_top30,
          },
          {
            score: right?.candidate.score,
            rankMassTop30: right?.evidence?.rank_mass_top30,
            bestRankInTop30: right?.evidence?.best_rank_in_top30,
          }
        );
      })[0];

    if (!recoveredCandidate) break;

    const recoveredAct = buildRecoveredMultiGoalAct({
      candidate: recoveredCandidate.candidate,
      evidence: recoveredCandidate.evidence,
    });
    selectedActs.push(recoveredAct);
    selectedNregs.add(recoveredAct.rada_nreg);
  }

  return selectedActs;
}

export function hasStrongGoalSupportedMultiPrimaryCoverage(input: {
  selectedActs: SelectedActOutput[];
  goalsSummary: GoalSummaryLike[];
  goalSupportByAct: GoalSupportByAct;
  chunksEvidenceTopActs: ChunksEvidenceItem[];
  actCandidatesTop: ActCandidateLike[];
}): boolean {
  const requiredGoalIds = new Set(
    input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  if (requiredGoalIds.size < 2) return false;

  const evidenceByNreg = new Map(
    input.chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const)
  );
  const categoryByNreg = new Map(
    input.actCandidatesTop.map((candidate) => [candidate.rada_nreg, candidate.category ?? null] as const)
  );

  const strongPrimaryActs = input.selectedActs.filter((act) => {
    if (act.act_kind !== 'PRIMARY_LAW') return false;
    if (!hasStrongChunksEvidence(evidenceByNreg.get(act.rada_nreg))) return false;
    return (input.goalSupportByAct.get(act.rada_nreg)?.size ?? 0) > 0;
  });
  if (strongPrimaryActs.length < 2) return false;
  if (strongPrimaryActs.length > requiredGoalIds.size) return false;

  const distinctFamilies = [
    ...new Set(
      strongPrimaryActs
        .map((act) => toFamilyKey(categoryByNreg.get(act.rada_nreg) ?? act.category))
        .filter((familyKey) => familyKey !== 'unknown')
    ),
  ];
  if (distinctFamilies.length < 2) return false;
  if (distinctFamilies.length > Math.min(requiredGoalIds.size, 2)) return false;
  if (!hasOnlyCompatiblePrimaryFamilies(distinctFamilies)) return false;

  const coveredGoalIds = collectCoveredGoalIdsForActs(strongPrimaryActs, input.goalSupportByAct);
  return coveredGoalIds.size >= requiredGoalIds.size;
}

const UNGROUNDED_MULTI_GOAL_TOP_SCORE_MAX = 0.62;

export function shouldFlagUngroundedMultiGoalFallback(input: {
  domainHint?: string;
  goalsSummary: GoalSummaryLike[];
  selectedActs: SelectedActOutput[];
  goalSupportByAct: GoalSupportByAct;
  selectedActsSourcesBreakdown: SelectedActsSourcesBreakdownLike;
  topScore: number | null;
  mismatchSignalsPresent: boolean;
  secondaryFamilySupportScore?: number;
  exactActHitCount?: number;
  groundedActHitCount?: number;
  metadataGroundedActCount?: number;
  explicitActScopeCue?: boolean;
  finalHits?: RawHit[];
}): boolean {
  const requiredGoalIds = new Set(
    input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  if (requiredGoalIds.size < 2) return false;
  if ((input.topScore ?? 0) >= UNGROUNDED_MULTI_GOAL_TOP_SCORE_MAX) return false;
  if (input.selectedActs.length === 0) return false;
  if (!input.selectedActs.every((act) => act.act_kind === 'PRIMARY_LAW')) return false;

  const fromChunksEvidence = input.selectedActsSourcesBreakdown.from_chunks_evidence ?? [];
  if (fromChunksEvidence.length === 0) return false;
  const hasIndexedActGroundingSignal =
    (input.exactActHitCount ?? 0) > 0 || (input.groundedActHitCount ?? 0) > 0;
  if (hasIndexedActGroundingSignal) return false;
  const metadataGroundedActCount = input.metadataGroundedActCount ?? 0;

  if (
    input.explicitActScopeCue === true &&
    metadataGroundedActCount === 0 &&
    fromChunksEvidence.length === input.selectedActs.length &&
    input.selectedActs.length >= 2
  ) {
    return true;
  }

  const finalHits = input.finalHits ?? [];
  const coveredGoalIds = new Set<string>();
  for (const act of input.selectedActs) {
    for (const goalId of collectEffectiveGoalIdsForAct({
      radaNreg: act.rada_nreg,
      goalsSummary: input.goalsSummary,
      goalSupportByAct: input.goalSupportByAct,
      requiredGoalIds,
      finalHits,
    })) {
      coveredGoalIds.add(goalId);
    }
  }
  if (coveredGoalIds.size < requiredGoalIds.size) return true;
  const strongSingleActProceduralBundle =
    input.selectedActs.length === 1 &&
    isProceduralPrimaryLawActLike(input.selectedActs[0]!) &&
    fromChunksEvidence.includes(input.selectedActs[0]!.rada_nreg) &&
    input.explicitActScopeCue !== true &&
    (input.topScore ?? 0) >= 0.54;
  if (strongSingleActProceduralBundle) return false;
  if (
    hasStrongGoalAnchoredCrossFamilyBundle({
      domainHint: input.domainHint,
      goalsSummary: input.goalsSummary,
      selectedActs: input.selectedActs,
      goalSupportByAct: input.goalSupportByAct,
      finalHits: input.finalHits,
      metadataGroundedActCount,
    })
  ) {
    return false;
  }
  if (input.mismatchSignalsPresent && input.selectedActs.length >= 2) {
    const actsWithUniqueGoalContribution = countActsWithUniqueGoalContribution(
      input.selectedActs,
      input.goalSupportByAct
    );
    if (actsWithUniqueGoalContribution === 0) return true;
  }

  const distinctPrimaryFamilies = [
    ...new Set(
      input.selectedActs
        .map((act) => toFamilyKey(act.category))
        .filter((familyKey) => familyKey !== 'unknown')
    ),
  ];
  const hasDomainAlignedSelectedFamily = distinctPrimaryFamilies.some((familyKey) =>
    isDomainHintAlignedFamily(input.domainHint, familyKey)
  );
  if (
    isSpecificDomainHint(input.domainHint) &&
    input.mismatchSignalsPresent &&
    distinctPrimaryFamilies.length > 0 &&
    !hasDomainAlignedSelectedFamily
  ) {
    return true;
  }
  const strongSecondaryFamilyCompetition = (input.secondaryFamilySupportScore ?? 0) >= 0.4;
  if (distinctPrimaryFamilies.length > 2) return true;
  if (!hasOnlyCompatiblePrimaryFamilies(distinctPrimaryFamilies)) return true;
  if (
    input.mismatchSignalsPresent &&
    strongSecondaryFamilyCompetition &&
    distinctPrimaryFamilies.length <= 1
  ) {
    return true;
  }
  if (!input.mismatchSignalsPresent) return false;
  return false;
}

export function shouldSkipMultiGoalVariantSearch(input: {
  goalsSummary: GoalSummaryCoverageLike[];
  goalSupportByAct: GoalSupportByAct;
  supportedActs: SupportedActLike[];
}): boolean {
  const requiredGoalIds = new Set(
    input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  if (requiredGoalIds.size < 2) return false;
  if (
    input.goalsSummary.some((goal) => (goal.required_categories?.filter(Boolean).length ?? 0) === 0)
  ) {
    return false;
  }

  const materialCoverage = input.goalsSummary.every((goal) => {
    const hitsCount = goal.hits_count ?? 0;
    const topScore = goal.top_score ?? 0;
    return hitsCount >= MULTI_GOAL_VARIANT_MIN_HITS && topScore >= MULTI_GOAL_VARIANT_MIN_TOP_SCORE;
  });
  if (!materialCoverage) return false;

  const supportedPrimaryActs = input.supportedActs.filter((act) => act.act_kind === 'PRIMARY_LAW');
  if (supportedPrimaryActs.length < Math.min(2, requiredGoalIds.size)) return false;

  const goalById = new Map(
    input.goalsSummary.map((goal) => [goal.goal_id, goal] as const)
  );
  const coveredGoalIds = new Set<string>();
  for (const act of supportedPrimaryActs) {
    const goalIds = input.goalSupportByAct.get(act.rada_nreg);
    if (!goalIds) continue;
    for (const goalId of goalIds) {
      if (!requiredGoalIds.has(goalId)) continue;
      const goal = goalById.get(goalId);
      const requiredCategories = goal?.required_categories?.filter(Boolean) ?? [];
      if (requiredCategories.length > 0) {
        const category = act.category?.trim();
        if (!category || !requiredCategories.includes(category)) continue;
      }
      coveredGoalIds.add(goalId);
    }
  }
  if (coveredGoalIds.size < requiredGoalIds.size) return false;

  return true;
}
