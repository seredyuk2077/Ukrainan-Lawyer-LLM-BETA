import type { ExtractedEntity, RoutingFlags } from '../classify/types.js';
import { config } from '../lib/config.js';
import { isCircuitOpen } from '../classify/circuit-breaker.js';
import { incrementU4QueryRewriteUsed } from '../gateway/observability.js';
import { getLldbiVocabulary } from './lldbi-vocabulary.js';
import { callQueryRewriter } from './query-rewriter-llm.js';
import { decideQueryRewritePolicy } from './query-rewrite-policy.js';
import type { EvidenceGoal } from './goals.js';
import type { QueryRewriteTaxonomyStrength } from './query-rewrite-policy.js';

export interface QueryRewriteTraceMeta {
  enabled: boolean;
  called: boolean;
  used?: boolean;
  model_id?: string;
  attempts?: number;
  duration_ms?: number;
  parse_mode?: 'strict' | 'extract';
  rewritten_query?: string;
  variants?: string[];
  negative_terms?: string[];
  categories_top3?: string[];
  doc_types_top3?: string[];
  confidence?: number;
  not_used_reason_codes?: string[];
}

export async function runQueryRewritePhase(input: {
  query: string;
  entities: ExtractedEntity[];
  routing_flags?: RoutingFlags;
  goalSplit: { goals: EvidenceGoal[] };
  domainHint?: string;
  categoryHints: string[];
  documentTypeHints: string[];
  taxonomySnapshotSummary: string;
  taxonomyStrength?: QueryRewriteTaxonomyStrength;
  run_id?: string;
}): Promise<{ queryForEmbed: string; meta: QueryRewriteTraceMeta; durationMs: number }> {
  let queryForEmbed = input.query;
  const queryRewritePolicy = decideQueryRewritePolicy({
    query: input.query,
    entities: input.entities,
    routing_flags: input.routing_flags,
    goals_count: input.goalSplit.goals.length,
    taxonomy_strength: input.taxonomyStrength,
  });
  const queryRewriteAllowed = config.u4QueryRewriteEnabled && config.openRouterApiKey && !isCircuitOpen();

  if (!queryRewriteAllowed || !queryRewritePolicy.shouldCall) {
    const notUsedReasons: string[] = [];
    if (!queryRewriteAllowed) {
      if (!config.u4QueryRewriteEnabled) notUsedReasons.push('DISABLED');
      else if (!config.openRouterApiKey) notUsedReasons.push('NO_API_KEY');
      else if (isCircuitOpen()) notUsedReasons.push('CIRCUIT_OPEN');
    } else {
      notUsedReasons.push(...queryRewritePolicy.reason_codes);
    }
    return {
      queryForEmbed,
      durationMs: 0,
      meta: {
        enabled: config.u4QueryRewriteEnabled,
        called: false,
        not_used_reason_codes: notUsedReasons.length > 0 ? notUsedReasons : undefined,
      },
    };
  }

  const vocabulary = await getLldbiVocabulary();
  const queryRewriteResult = await callQueryRewriter({
    original_query: input.query,
    goals_summary: input.goalSplit.goals.map((goal) => ({ goal_id: goal.id, subquery: goal.subquery })),
    domainHint: input.domainHint,
    lldbi:
      input.categoryHints.length > 0 || input.documentTypeHints.length > 0
        ? {
            categories_ranked_top3: input.categoryHints,
            document_types_ranked_top3: input.documentTypeHints,
          }
        : undefined,
    taxonomy_snapshot_summary: input.taxonomySnapshotSummary,
    lldbi_vocabulary: vocabulary,
    run_id: input.run_id,
  });

  const minRewriteConfidence = config.u4QueryRewriteMinConfidence;
  const hasRewrite =
    queryRewriteResult.output?.rewritten_query?.trim() &&
    (queryRewriteResult.output.overall_confidence ?? 0) >= minRewriteConfidence;

  if (hasRewrite) {
    queryForEmbed = queryRewriteResult.output!.rewritten_query!.trim();
    const used =
      queryForEmbed !== input.query ||
      (queryRewriteResult.output!.query_variants?.length ?? 0) > 0 ||
      (queryRewriteResult.output!.negative_terms?.length ?? 0) > 0;
    if (used) incrementU4QueryRewriteUsed();
  }

  const notUsedReasons: string[] = [];
  if (queryRewriteResult.called && !queryRewriteResult.output) {
    notUsedReasons.push(queryRewriteResult.call_failed_reason ?? 'FAILED');
  } else if (
    queryRewriteResult.output?.rewritten_query?.trim() &&
    (queryRewriteResult.output.overall_confidence ?? 0) < minRewriteConfidence
  ) {
    notUsedReasons.push('LOW_CONFIDENCE');
  }

  return {
    queryForEmbed,
    durationMs: queryRewriteResult.duration_ms ?? 0,
    meta: {
      enabled: true,
      called: Boolean(queryRewriteResult.called),
      used: Boolean(hasRewrite),
      model_id: queryRewriteResult.model_id,
      attempts: queryRewriteResult.attempts,
      duration_ms: queryRewriteResult.duration_ms,
      parse_mode: queryRewriteResult.parse_mode,
      rewritten_query: queryRewriteResult.output?.rewritten_query?.slice(0, 300),
      variants: queryRewriteResult.output?.query_variants,
      negative_terms: queryRewriteResult.output?.negative_terms,
      categories_top3: queryRewriteResult.output?.categories_ranked_top3,
      doc_types_top3: queryRewriteResult.output?.document_types_ranked_top3,
      confidence: queryRewriteResult.output?.overall_confidence,
      not_used_reason_codes: notUsedReasons.length > 0 ? notUsedReasons : undefined,
    },
  };
}
