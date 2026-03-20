export interface SingleGoalTaxonomyStrength {
  taxonomy_act_count: number;
  alias_hit_count: number;
  category_hint_count: number;
  document_type_hint_count: number;
}

export function hasStrongSingleGoalTaxonomySignal(input: {
  goals_count?: number;
  taxonomy_strength?: SingleGoalTaxonomyStrength;
}): boolean {
  const goalsCount = Math.max(1, input.goals_count ?? 1);
  const taxonomyStrength = input.taxonomy_strength;
  if (goalsCount !== 1 || taxonomyStrength == null) return false;
  return (
    taxonomyStrength.taxonomy_act_count >= 4 ||
    taxonomyStrength.alias_hit_count >= 2 ||
    (taxonomyStrength.taxonomy_act_count >= 2 &&
      (taxonomyStrength.alias_hit_count >= 1 ||
        taxonomyStrength.category_hint_count >= 1 ||
        taxonomyStrength.document_type_hint_count >= 1))
  );
}
