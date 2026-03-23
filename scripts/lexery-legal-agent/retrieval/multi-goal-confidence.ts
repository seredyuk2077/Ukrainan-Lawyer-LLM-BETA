import { collectCoveredGoalIdsForActs, type GoalSupportByAct } from './goal-support.js';
import type { ChunksEvidenceItem, SelectedActOutput } from './selected-acts.js';

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

const MULTI_GOAL_VARIANT_MIN_HITS = 6;
const MULTI_GOAL_VARIANT_MIN_TOP_SCORE = 0.48;

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
  return item.count_in_top30 >= 3 || (bestRank <= 5 && orderingScore >= 0.55);
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
