import type { ExtractedEntity } from '../classify/types.js';
import type { QueryCitationSelectors } from './structural-citation.js';

const STRUCTURAL_WITHIN_ACT_LIMIT = 4;
const PROCEDURAL_WITHIN_ACT_LIMIT = 4;
const COMPACT_PROCEDURAL_WITHIN_ACT_LIMIT = 3;
const SIGNAL_ONLY_WITHIN_ACT_LIMIT = 2;
const ACT_ANCHORED_WITHIN_ACT_LIMIT = 3;

export interface WithinActExpansionDecision {
  limit: number;
  reason_codes: string[];
}

function hasActCue(entities: ExtractedEntity[]): boolean {
  return entities.some((entity) => entity.type === 'law_title' || entity.type === 'act_abbrev');
}

function hasStructuralEntityCue(entities: ExtractedEntity[]): boolean {
  return entities.some(
    (entity) =>
      entity.type === 'article_ref' ||
      entity.type === 'law_title' ||
      entity.type === 'act_abbrev'
  );
}

export function decideWithinActExpansion(input: {
  hasActCandidates: boolean;
  needTwoStage: boolean;
  querySelectors: QueryCitationSelectors;
  entities: ExtractedEntity[];
  goalType?: string;
  goalReasonCodes?: string[];
  mustHaveSignalsCount?: number;
  weakLimit: number;
}): WithinActExpansionDecision {
  if (!input.hasActCandidates) {
    return { limit: 0, reason_codes: ['NO_ACT_CANDIDATES'] };
  }

  if (input.needTwoStage) {
    return { limit: input.weakLimit, reason_codes: ['WEAK_FIRST_PASS'] };
  }

  const reasonCodes = new Set<string>();

  if (
    input.querySelectors.explicitSelectorCount >= 2 ||
    (input.querySelectors.explicitSelectorCount >= 1 && hasActCue(input.entities)) ||
    input.querySelectors.noteMentioned
  ) {
    reasonCodes.add('STRUCTURAL_QUERY');
  }

  if (input.goalType === 'procedure') {
    reasonCodes.add('PROCEDURAL_GOAL');
  }

  if ((input.mustHaveSignalsCount ?? 0) > 0) {
    reasonCodes.add('GOAL_SIGNALS_PRESENT');
  }

  if ((input.goalReasonCodes ?? []).includes('procedural_bundle_compaction')) {
    reasonCodes.add('PROCEDURAL_BUNDLE');
  }

  if ((input.goalReasonCodes ?? []).includes('multi_clause_structure')) {
    reasonCodes.add('MULTI_CLAUSE_QUERY');
  }

  if (reasonCodes.has('STRUCTURAL_QUERY')) {
    return {
      limit: STRUCTURAL_WITHIN_ACT_LIMIT,
      reason_codes: [...reasonCodes],
    };
  }

  if (reasonCodes.has('PROCEDURAL_GOAL')) {
    const compactBundleQuery =
      (input.goalReasonCodes ?? []).includes('procedural_bundle_compaction') &&
      input.querySelectors.explicitSelectorCount === 0 &&
      !input.querySelectors.noteMentioned &&
      !hasActCue(input.entities);
    return {
      limit:
        compactBundleQuery
          ? SIGNAL_ONLY_WITHIN_ACT_LIMIT
          : input.querySelectors.explicitSelectorCount === 0 &&
              !input.querySelectors.noteMentioned &&
              !hasActCue(input.entities)
          ? COMPACT_PROCEDURAL_WITHIN_ACT_LIMIT
          : PROCEDURAL_WITHIN_ACT_LIMIT,
      reason_codes: [...reasonCodes],
    };
  }

  if (reasonCodes.size > 0) {
    return {
      limit: SIGNAL_ONLY_WITHIN_ACT_LIMIT,
      reason_codes: [...reasonCodes],
    };
  }

  if (hasStructuralEntityCue(input.entities)) {
    return { limit: ACT_ANCHORED_WITHIN_ACT_LIMIT, reason_codes: ['ENTITY_ANCHORED_QUERY'] };
  }

  return { limit: 0, reason_codes: ['STRONG_GENERIC_FIRST_PASS'] };
}
