import type { ExtractedEntity } from '../classify/types.js';
import type { QueryCitationSelectors } from './structural-citation.js';

const STRUCTURAL_WITHIN_ACT_LIMIT = 4;
const PROCEDURAL_WITHIN_ACT_LIMIT = 4;
const COMPACT_PROCEDURAL_WITHIN_ACT_LIMIT = 3;
const SIGNAL_ONLY_WITHIN_ACT_LIMIT = 2;
const GROUNDED_STRUCTURAL_WITHIN_ACT_LIMIT = 2;
const ACT_ANCHORED_WITHIN_ACT_LIMIT = 3;
const STRONG_HEAD_SINGLE_ACT_LIMIT = 1;
const DEFAULT_WITHIN_ACT_CHUNKS_PER_ACT = 35;
const WIDE_MULTI_GOAL_WITHIN_ACT_CHUNKS_PER_ACT = 50;
const COMPACT_WITHIN_ACT_CHUNKS_PER_ACT = 28;
const SINGLE_ACT_WITHIN_ACT_CHUNKS_PER_ACT = 24;

type RetrievalEntityLike =
  | ExtractedEntity
  | {
      act_abbrev?: string;
      law_title?: string;
      article_ref?: string;
    };

export interface WithinActExpansionDecision {
  limit: number;
  chunks_per_act_limit: number;
  reason_codes: string[];
}

function getEntityKind(entity: RetrievalEntityLike): string | null {
  if ('type' in entity && typeof entity.type === 'string') return entity.type;
  if ('article_ref' in entity && entity.article_ref) return 'article_ref';
  if ('law_title' in entity && entity.law_title) return 'law_title';
  if ('act_abbrev' in entity && entity.act_abbrev) return 'act_abbrev';
  return null;
}

function hasActCue(entities: RetrievalEntityLike[]): boolean {
  return entities.some((entity) => {
    const kind = getEntityKind(entity);
    return kind === 'law_title' || kind === 'act_abbrev';
  });
}

function hasStructuralEntityCue(entities: RetrievalEntityLike[]): boolean {
  return entities.some((entity) => {
    const kind = getEntityKind(entity);
    return kind === 'article_ref' || kind === 'law_title' || kind === 'act_abbrev';
  });
}

export function decideWithinActExpansion(input: {
  hasActCandidates: boolean;
  needTwoStage: boolean;
  querySelectors: QueryCitationSelectors;
  entities: RetrievalEntityLike[];
  explicitActScopeCue?: boolean;
  descriptiveActTitleScope?: boolean;
  goalType?: string;
  goalReasonCodes?: string[];
  mustHaveSignalsCount?: number;
  groundedActHitCount?: number;
  queryTokenCount?: number;
  chunkEvidenceActCount?: number;
  topChunkEvidenceHitCount?: number;
  topChunkEvidenceMatchesLeadingAct?: boolean;
  weakLimit: number;
}): WithinActExpansionDecision {
  const defaultChunkLimit =
    input.weakLimit > COMPACT_PROCEDURAL_WITHIN_ACT_LIMIT
      ? WIDE_MULTI_GOAL_WITHIN_ACT_CHUNKS_PER_ACT
      : DEFAULT_WITHIN_ACT_CHUNKS_PER_ACT;
  if (!input.hasActCandidates) {
    return {
      limit: 0,
      chunks_per_act_limit: defaultChunkLimit,
      reason_codes: ['NO_ACT_CANDIDATES'],
    };
  }

  if (input.needTwoStage) {
    return {
      limit: input.weakLimit,
      chunks_per_act_limit: defaultChunkLimit,
      reason_codes: ['WEAK_FIRST_PASS'],
    };
  }

  const reasonCodes = new Set<string>();
  const descriptiveActTitleScope = input.descriptiveActTitleScope === true;
  if (descriptiveActTitleScope) {
    reasonCodes.add('DESCRIPTIVE_ACT_TITLE_QUERY');
  }

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

  const groundedSingleAct =
    (input.groundedActHitCount ?? 0) === 1 &&
    (
      (input.queryTokenCount ?? Number.POSITIVE_INFINITY) <= 14 ||
      descriptiveActTitleScope
    );
  const groundedStructuralSingleAct =
    groundedSingleAct &&
    (
      reasonCodes.has('STRUCTURAL_QUERY') ||
      input.explicitActScopeCue ||
      descriptiveActTitleScope ||
      hasActCue(input.entities)
    );
  const strongHeadActConsensus =
    (input.topChunkEvidenceMatchesLeadingAct ?? false) &&
    (input.topChunkEvidenceHitCount ?? 0) >= 2 &&
    (input.chunkEvidenceActCount ?? Number.POSITIVE_INFINITY) <= 2;

  if (groundedSingleAct && strongHeadActConsensus) {
    return {
      limit: STRONG_HEAD_SINGLE_ACT_LIMIT,
      chunks_per_act_limit: SINGLE_ACT_WITHIN_ACT_CHUNKS_PER_ACT,
      reason_codes: [
        ...reasonCodes,
        'GROUNDED_SINGLE_ACT_QUERY',
        'STRONG_HEAD_ACT_CONSENSUS',
      ],
    };
  }

  if ((input.explicitActScopeCue || descriptiveActTitleScope) && strongHeadActConsensus) {
    return {
      limit: STRONG_HEAD_SINGLE_ACT_LIMIT,
      chunks_per_act_limit: SINGLE_ACT_WITHIN_ACT_CHUNKS_PER_ACT,
      reason_codes: [
        ...reasonCodes,
        ...(input.explicitActScopeCue ? ['EXPLICIT_ACT_SCOPE_QUERY'] : []),
        'STRONG_HEAD_ACT_CONSENSUS',
      ],
    };
  }

  if (groundedStructuralSingleAct) {
    return {
      limit: GROUNDED_STRUCTURAL_WITHIN_ACT_LIMIT,
      chunks_per_act_limit: COMPACT_WITHIN_ACT_CHUNKS_PER_ACT,
      reason_codes: [...reasonCodes, 'GROUNDED_SINGLE_ACT_QUERY'],
    };
  }

  if (reasonCodes.has('STRUCTURAL_QUERY')) {
    return {
      limit: STRUCTURAL_WITHIN_ACT_LIMIT,
      chunks_per_act_limit: defaultChunkLimit,
      reason_codes: [...reasonCodes],
    };
  }

  if (input.explicitActScopeCue && (input.groundedActHitCount ?? 0) === 0) {
    return {
      limit: ACT_ANCHORED_WITHIN_ACT_LIMIT,
      chunks_per_act_limit: COMPACT_WITHIN_ACT_CHUNKS_PER_ACT,
      reason_codes: ['EXPLICIT_ACT_SCOPE_QUERY'],
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
      chunks_per_act_limit:
        compactBundleQuery ||
        (input.querySelectors.explicitSelectorCount === 0 &&
          !input.querySelectors.noteMentioned &&
          !hasActCue(input.entities))
          ? COMPACT_WITHIN_ACT_CHUNKS_PER_ACT
          : defaultChunkLimit,
      reason_codes: [...reasonCodes],
    };
  }

  if (reasonCodes.size > 0) {
    return {
      limit: SIGNAL_ONLY_WITHIN_ACT_LIMIT,
      chunks_per_act_limit: COMPACT_WITHIN_ACT_CHUNKS_PER_ACT,
      reason_codes: [...reasonCodes],
    };
  }

  if (hasStructuralEntityCue(input.entities)) {
    return {
      limit: ACT_ANCHORED_WITHIN_ACT_LIMIT,
      chunks_per_act_limit: COMPACT_WITHIN_ACT_CHUNKS_PER_ACT,
      reason_codes: ['ENTITY_ANCHORED_QUERY'],
    };
  }

  if (
    (input.groundedActHitCount ?? 0) === 1 &&
    (input.queryTokenCount ?? Number.POSITIVE_INFINITY) <= 8
  ) {
    return {
      limit: SIGNAL_ONLY_WITHIN_ACT_LIMIT,
      chunks_per_act_limit: COMPACT_WITHIN_ACT_CHUNKS_PER_ACT,
      reason_codes: ['GROUNDED_SINGLE_ACT_QUERY'],
    };
  }

  return {
    limit: 0,
    chunks_per_act_limit: defaultChunkLimit,
    reason_codes: ['STRONG_GENERIC_FIRST_PASS'],
  };
}
