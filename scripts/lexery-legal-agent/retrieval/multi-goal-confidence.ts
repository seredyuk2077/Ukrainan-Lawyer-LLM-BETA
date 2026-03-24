import { collectCoveredGoalIdsForActs, type GoalSupportByAct } from './goal-support.js';
import {
  CHUNKS_EVIDENCE_COUNT_THRESHOLD,
  CHUNKS_EVIDENCE_SCORE_THRESHOLD,
  type ChunksEvidenceItem,
  type SelectedActOutput,
  type SelectedActsKindsCount,
} from './selected-acts.js';

type GoalSummaryLike = {
  goal_id: string;
  goal_type?: string;
};

type GoalSummaryCoverageLike = GoalSummaryLike & {
  hits_count?: number;
  top_score?: number | null;
  required_categories?: string[];
};

type SupportedActLike = {
  rada_nreg: string;
  act_kind?: string | null;
  category?: string | null;
};

type ActCandidateLike = {
  rada_nreg: string;
  category?: string | null;
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

const MULTI_GOAL_VARIANT_MIN_HITS = 6;
const MULTI_GOAL_VARIANT_MIN_TOP_SCORE = 0.48;

function isSpecificDomainHint(domainHint: string | undefined | null): boolean {
  const normalized = (domainHint ?? '').normalize('NFC').trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'general';
}

function toFamilyKey(category: string | undefined | null): string {
  return (category ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim() || 'unknown';
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

function normalizeSelectedActsSourcesBreakdown(
  selectedActs: SelectedActOutput[],
  breakdown: SelectedActsSourcesBreakdownLike | undefined
): MultiGoalSelectedActsFinalizationOutput['selectedActsSourcesBreakdown'] {
  const selectedNregs = new Set(selectedActs.map((act) => act.rada_nreg));
  return {
    from_taxonomy: [...new Set((breakdown?.from_taxonomy ?? []).filter((radaNreg) => selectedNregs.has(radaNreg)))],
    from_acts_search: [...new Set((breakdown?.from_acts_search ?? []).filter((radaNreg) => selectedNregs.has(radaNreg)))],
    from_chunks_evidence: [
      ...new Set((breakdown?.from_chunks_evidence ?? []).filter((radaNreg) => selectedNregs.has(radaNreg))),
    ],
  };
}

function hasSameSelectedActSet(left: SelectedActOutput[], right: SelectedActOutput[]): boolean {
  if (left.length !== right.length) return false;
  const leftNregs = [...left.map((act) => act.rada_nreg)].sort();
  const rightNregs = [...right.map((act) => act.rada_nreg)].sort();
  return leftNregs.every((radaNreg, index) => radaNreg === rightNregs[index]);
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

  const metadataGroundedActCount = new Set([
    ...selectedActsSourcesBreakdown.from_taxonomy,
    ...selectedActsSourcesBreakdown.from_acts_search,
  ]).size;

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

  const distinctFamilies = new Set(
    strongPrimaryActs
      .map((act) => toFamilyKey(categoryByNreg.get(act.rada_nreg) ?? act.category))
      .filter((familyKey) => familyKey !== 'unknown')
  );
  if (distinctFamilies.size < 2) return false;

  const coveredGoalIds = collectCoveredGoalIdsForActs(strongPrimaryActs, input.goalSupportByAct);
  return coveredGoalIds.size >= requiredGoalIds.size;
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

export function shouldFlagUngroundedMultiGoalFallback(input: {
  domainHint?: string;
  goalsSummary: GoalSummaryLike[];
  selectedActs: SelectedActOutput[];
  goalSupportByAct: GoalSupportByAct;
  selectedActsSourcesBreakdown: SelectedActsSourcesBreakdownLike;
  topScore: number | null;
  mismatchSignalsPresent: boolean;
}): boolean {
  const requiredGoalIds = new Set(
    input.goalsSummary.map((goal) => goal.goal_id.trim()).filter(Boolean)
  );
  if (requiredGoalIds.size < 2) return false;
  if (isSpecificDomainHint(input.domainHint)) return false;
  if ((input.topScore ?? 0) >= 0.6) return false;
  if (!input.mismatchSignalsPresent) return false;
  if (input.selectedActs.length === 0) return false;
  if (!input.selectedActs.every((act) => act.act_kind === 'PRIMARY_LAW')) return false;

  const coveredGoalIds = collectCoveredGoalIdsForActs(input.selectedActs, input.goalSupportByAct);
  if (coveredGoalIds.size >= requiredGoalIds.size) return false;

  const goalTypes = new Set(
    input.goalsSummary
      .map((goal) => String(goal.goal_type ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  if ([...goalTypes].some((goalType) => goalType !== 'definition')) return false;

  const fromChunksEvidence = input.selectedActsSourcesBreakdown.from_chunks_evidence ?? [];
  const fromTaxonomy = input.selectedActsSourcesBreakdown.from_taxonomy ?? [];
  const fromActsSearch = input.selectedActsSourcesBreakdown.from_acts_search ?? [];
  if (fromChunksEvidence.length === 0) return false;
  if (fromTaxonomy.length > 0 || fromActsSearch.length > 0) return false;

  return true;
}
