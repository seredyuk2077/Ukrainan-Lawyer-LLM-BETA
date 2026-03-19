import type { ExtractedEntity, RoutingFlags } from '../classify/types.js';
import { extractQueryCitationSelectors } from './structural-citation.js';

export interface QueryRewritePolicyDecision {
  shouldCall: boolean;
  reason_codes: string[];
}

export interface QueryRewriteTaxonomyStrength {
  taxonomy_act_count: number;
  alias_hit_count: number;
  category_hint_count: number;
  document_type_hint_count: number;
}

function countTokens(query: string): number {
  return query
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean).length;
}

function hasActCue(entities: ExtractedEntity[]): boolean {
  return entities.some((entity) => entity.type === 'act_abbrev' || entity.type === 'law_title');
}

function hasArticleCue(entities: ExtractedEntity[]): boolean {
  return entities.some((entity) => entity.type === 'article_ref');
}

export function decideQueryRewritePolicy(input: {
  query: string;
  entities: ExtractedEntity[];
  routing_flags?: RoutingFlags;
  goals_count?: number;
  taxonomy_strength?: QueryRewriteTaxonomyStrength;
}): QueryRewritePolicyDecision {
  const selectors = extractQueryCitationSelectors(input.query);
  const tokenCount = countTokens(input.query);
  const goalsCount = Math.max(1, input.goals_count ?? 1);
  const taxonomyStrength = input.taxonomy_strength;
  const strongTaxonomySupport =
    goalsCount === 1 &&
    taxonomyStrength != null &&
    (taxonomyStrength.taxonomy_act_count >= 4 ||
      taxonomyStrength.alias_hit_count >= 2 ||
      (taxonomyStrength.taxonomy_act_count >= 2 &&
        (taxonomyStrength.alias_hit_count >= 1 ||
          taxonomyStrength.category_hint_count >= 1 ||
          taxonomyStrength.document_type_hint_count >= 1)));
  const titleAnchoredStructure =
    input.entities.some((entity) => entity.type === 'law_title') &&
    selectors.explicitSelectorCount >= 1;
  const groundedCitationStructure =
    selectors.explicitSelectorCount >= 1 &&
    (hasActCue(input.entities) || hasArticleCue(input.entities));
  const preciseCitationStructure =
    selectors.explicitSelectorCount >= 2 &&
    (hasActCue(input.entities) || hasArticleCue(input.entities));
  const noteAnchoredStructure =
    selectors.noteMentioned && (hasActCue(input.entities) || hasArticleCue(input.entities));

  if (
    titleAnchoredStructure ||
    groundedCitationStructure ||
    preciseCitationStructure ||
    noteAnchoredStructure
  ) {
    return { shouldCall: false, reason_codes: ['ANCHORED_STRUCTURAL_QUERY'] };
  }

  if (strongTaxonomySupport) {
    return { shouldCall: false, reason_codes: ['STRONG_TAXONOMY_SIGNAL'] };
  }

  const simpleFocusedQuery =
    goalsCount === 1 &&
    tokenCount <= 14 &&
    input.query.length <= 120 &&
    !input.routing_flags?.need_deep_retrieval &&
    !input.routing_flags?.input_looks_like_contract &&
    !input.routing_flags?.input_looks_like_legal_text &&
    !/[\n:;]/u.test(input.query);

  if (simpleFocusedQuery) {
    return { shouldCall: false, reason_codes: ['SIMPLE_FOCUSED_QUERY'] };
  }

  return { shouldCall: true, reason_codes: [] };
}
