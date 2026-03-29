export interface SingleGoalTaxonomyStrength {
  taxonomy_act_count: number;
  alias_hit_count: number;
  exact_act_hit_count?: number;
  grounded_act_hit_count?: number;
  category_hint_count: number;
  document_type_hint_count: number;
  has_explicit_calendar_date?: boolean;
}

export function hasStrongSingleGoalTaxonomySignal(input: {
  goals_count?: number;
  taxonomy_strength?: SingleGoalTaxonomyStrength;
}): boolean {
  const goalsCount = Math.max(1, input.goals_count ?? 1);
  const taxonomyStrength = input.taxonomy_strength;
  if (goalsCount !== 1 || taxonomyStrength == null) return false;
  if (
    taxonomyStrength.has_explicit_calendar_date === true &&
    (taxonomyStrength.grounded_act_hit_count ?? 0) === 0 &&
    (taxonomyStrength.exact_act_hit_count ?? 0) === 0
  ) {
    return false;
  }
  return (
    (taxonomyStrength.grounded_act_hit_count ?? 0) >= 1 ||
    (taxonomyStrength.exact_act_hit_count ?? 0) >= 1 ||
    taxonomyStrength.taxonomy_act_count >= 4 ||
    (taxonomyStrength.taxonomy_act_count >= 2 &&
      (taxonomyStrength.category_hint_count >= 1 ||
        taxonomyStrength.document_type_hint_count >= 1))
  );
}
