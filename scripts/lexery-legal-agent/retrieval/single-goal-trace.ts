import { NOISE_PENALTY_POLICY_VERSION } from './hit-ranking.js';
import { toFamilyEvidenceSummary, type FamilyEvidence } from './family-evidence.js';
import type { FinalizeSelectedActsAfterRoutingOutput } from './selected-acts-finalizer.js';
import type { CoverageGap, DegradedSources, RawHit, RetrievalTrace, SampleHit } from './types.js';
import type {
  OodGuardResult,
  RoutingHintsMeta,
  SelectedActTraceItem,
} from './single-goal-selected-acts.js';

type RetrievalMeta = NonNullable<RetrievalTrace['meta']>;

type PlannerMetaLike = {
  tier: 0 | 1 | 2;
  model_id?: string;
  duration_ms?: number;
  degraded?: boolean;
  reason_codes?: string[];
};

export interface BuildSingleGoalRetrievalTraceInput {
  hits: RawHit[];
  topScore: number | null;
  latencyMs: number;
  degradedSources?: DegradedSources;
  collectionsUsed: string[];
  stepsLatencyMs: number[];
  sampleHits: SampleHit[];
  stepsRequested: string[];
  effectiveQuery: string;
  hitsTotalBeforeCap: number;
  hitsCapApplied: boolean;
  topNUsedForDistribution: number;
  avgScore?: number;
  lowConfidence: boolean;
  coverageGap: CoverageGap;
  useLowConfidenceFallback: boolean;
  reasonCodes: string[];
  recoveredEmptySelected: boolean;
  selectedActs: SelectedActTraceItem[];
  plannerFamilyHints?: string[];
  priorAppliedAny: boolean;
  priorBoostUsed: boolean;
  lldbiSoftPriorMeta?: RetrievalMeta['lldbi_soft_prior'];
  acts2Used: boolean;
  acts2Trigger: string[];
  acts2Queries: string[];
  acts2QdrantCalls: number;
  acts2DebugTopTitles: string[];
  debugActsLookupEnabled: boolean;
  actPlannerCalledThisRun: boolean;
  plannerCalledThisRun: boolean;
  queryVariantsUsed: string[];
  useMultiQuery: boolean;
  usedFilteredChunksSearch: boolean;
  withinActPolicyReasonCodes: string[];
  actsSearchPolicyReasonCodes: string[];
  anchorsUsed: string[];
  exactActHitCount: number;
  exactActNregs: string[];
  groundedActHitCount: number;
  groundedActNregs: string[];
  taxonomySnapshotVersion?: number | null;
  lldbiHintsPresent: boolean;
  lldbiHintsUsed?: RetrievalMeta['lldbi_hints_used'];
  taxonomyHintsUsed?: RetrievalMeta['taxonomy_hints_used'];
  usedTaxonomy: boolean;
  usedLlmPlanner: boolean;
  hybridRescoreUsed?: boolean;
  actCandidatesTopHydrated: RetrievalMeta['act_candidates_top'];
  queryRewriteMeta?: RetrievalMeta['query_rewrite'];
  usedActsSearch: boolean;
  goalId: string;
  goalType?: string;
  hitsByActTop3: Record<string, number>;
  avgScoreByActTop3: Record<string, number>;
  noisePenaltyCount: number;
  noisePenaltyGuardBlockedCount: number;
  noisePenaltyGuardReasonCodes: string[];
  selectedActsSourcesBreakdown: RetrievalMeta['selected_acts_sources_breakdown'];
  chunksEvidenceTopActs: RetrievalMeta['chunks_evidence_top_acts'];
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  familyEvidence: FamilyEvidence;
  routingHintsMeta: RoutingHintsMeta;
  referenceExpansionMeta?: RetrievalMeta['reference_expansion'];
  articleBackfillMeta?: RetrievalMeta['article_backfill'];
  oodGuardResult: OodGuardResult;
  specializedDomainNoPrimary: boolean;
  coverageGuardFiredButFamilyOk: boolean;
  routingHintsAddedPrimaryLaw: boolean;
  plannerMeta: PlannerMetaLike;
  qdrantCallsCountTotal: number;
  memoryMeta?: RetrievalMeta['memory'];
  retrievalDebugStages?: Array<{ stage: string; qdrant_calls_count: number; time_ms: number }>;
}

function deriveWhyLowConfidence(input: {
  lowConfidence: boolean;
  useLowConfidenceFallback: boolean;
  reasonCodes: string[];
  recoveredEmptySelected: boolean;
  selectedActs: SelectedActTraceItem[];
  rawHitsCount: number;
}): string | undefined {
  if (!input.lowConfidence) return undefined;
  if (input.useLowConfidenceFallback && input.rawHitsCount > 0) {
    return 'all_hits_below_min_score_fallback_to_top_k';
  }
  if (input.reasonCodes.includes('ROUTING_HINTS_LOW_CONF')) return 'ROUTING_HINTS_LOW_CONF';
  if (input.recoveredEmptySelected) return 'EMPTY_SELECTED_ACTS_RECOVERED';
  if (
    input.reasonCodes.includes('NO_PRIMARY_LAW_EVIDENCE') &&
    !input.selectedActs.some((act) => act.act_kind === 'PRIMARY_LAW')
  ) {
    return 'NO_PRIMARY_LAW_EVIDENCE';
  }
  if (input.reasonCodes.includes('LOW_EVIDENCE')) return 'LOW_EVIDENCE';
  if (input.reasonCodes.includes('ACT_SELECTION_LOW_CONFIDENCE')) return 'ACT_SELECTION_LOW_CONFIDENCE';
  return undefined;
}

export function buildSingleGoalRetrievalTrace(input: BuildSingleGoalRetrievalTraceInput): RetrievalTrace {
  const whyLowConfidence = deriveWhyLowConfidence({
    lowConfidence: input.lowConfidence,
    useLowConfidenceFallback: input.useLowConfidenceFallback,
    reasonCodes: input.reasonCodes,
    recoveredEmptySelected: input.recoveredEmptySelected,
    selectedActs: input.selectedActs,
    rawHitsCount: input.hits.length,
  });

  const lowConfidenceSuppressed =
    input.specializedDomainNoPrimary ||
    input.coverageGuardFiredButFamilyOk ||
    (input.routingHintsAddedPrimaryLaw &&
      input.selectedActsFinalMeta.routing_hints_recovered_with_retrieval_evidence &&
      !input.lowConfidence)
      ? {
          fired: true,
          suppressed_reasons: [
            ...(input.specializedDomainNoPrimary ? ['SPECIALIZED_DOMAIN_NO_PRIMARY_LAW'] : []),
            ...(input.coverageGuardFiredButFamilyOk ? ['COVERAGE_GUARD_FAMILY_OK'] : []),
            ...(
              input.routingHintsAddedPrimaryLaw &&
              input.selectedActsFinalMeta.routing_hints_recovered_with_retrieval_evidence &&
              !input.lowConfidence
                ? ['ROUTING_HINTS_RECOVERED_WITH_RETRIEVAL_EVIDENCE']
                : []
            ),
          ],
        }
      : undefined;

  return {
    version: 1,
    hits: input.hits,
    top_score: input.topScore,
    latency_ms: input.latencyMs,
    degraded_sources: input.degradedSources,
    meta: {
      collections_used: input.collectionsUsed,
      steps_latency_ms: input.stepsLatencyMs,
      sample_hits: input.sampleHits,
      steps_requested: input.stepsRequested,
      steps_executed: [...input.collectionsUsed],
      query_used: input.effectiveQuery.slice(0, 200),
      hits_count: input.hits.length,
      hits_total_before_cap: input.hitsTotalBeforeCap,
      hits_total_after_cap: input.hits.length,
      hits_cap_applied: input.hitsCapApplied,
      topN_used_for_distribution: input.topNUsedForDistribution,
      scores_computed_on: 'final_hits_after_cap_and_guards',
      avg_score_source: 'final_hits_after_cap_and_guards',
      avg_score: input.avgScore,
      low_confidence: input.lowConfidence,
      coverage_gap: input.coverageGap,
      why_low_confidence: whyLowConfidence,
      selected_acts: input.selectedActs,
      family_hints: input.plannerFamilyHints?.length ? input.plannerFamilyHints.slice(0, 5) : undefined,
      prior_applied:
        input.plannerFamilyHints?.length
          ? { applied: input.priorAppliedAny, boost_used: input.priorBoostUsed }
          : undefined,
      lldbi_soft_prior: input.lldbiSoftPriorMeta,
      acts2_used: input.acts2Used,
      acts2_trigger: input.acts2Trigger.length ? input.acts2Trigger : undefined,
      acts2_queries: input.acts2Queries.length ? input.acts2Queries : undefined,
      acts2_qdrant_calls: input.acts2Used ? input.acts2QdrantCalls : undefined,
      acts2_debug_top_titles:
        input.debugActsLookupEnabled && input.acts2DebugTopTitles.length
          ? input.acts2DebugTopTitles
          : undefined,
      used_act_planner: input.actPlannerCalledThisRun,
      query_variants_used: input.queryVariantsUsed.length ? input.queryVariantsUsed : undefined,
      multi_query_variants_count: input.useMultiQuery ? input.queryVariantsUsed.length : undefined,
      used_filtered_chunks_search: input.usedFilteredChunksSearch || undefined,
      within_act_policy: input.withinActPolicyReasonCodes.length ? input.withinActPolicyReasonCodes : undefined,
      acts_search_policy: input.actsSearchPolicyReasonCodes.length ? input.actsSearchPolicyReasonCodes : undefined,
      anchors_used: input.anchorsUsed.length ? input.anchorsUsed : undefined,
      exact_act_hit_count: input.exactActHitCount || undefined,
      exact_act_nregs: input.exactActNregs.length ? input.exactActNregs : undefined,
      grounded_act_hit_count: input.groundedActHitCount || undefined,
      grounded_act_nregs: input.groundedActNregs.length ? input.groundedActNregs : undefined,
      taxonomy_snapshot_version: input.taxonomySnapshotVersion ?? undefined,
      lldbi_hints_present: input.lldbiHintsPresent,
      lldbi_hints_used: input.lldbiHintsUsed,
      taxonomy_hints_used: input.taxonomyHintsUsed,
      hybrid_rescore_used: input.hybridRescoreUsed,
      thesaurus_version: 1,
      act_candidates_top: input.actCandidatesTopHydrated,
      query_rewrite: input.queryRewriteMeta,
      stage_decisions: {
        used_taxonomy: input.usedTaxonomy,
        used_acts_search: input.usedActsSearch,
        used_filtered_chunks: input.usedFilteredChunksSearch,
        used_llm_rewrite: input.queryRewriteMeta?.used === true,
        used_llm_rerank: false,
        used_multi_query: input.useMultiQuery,
        used_goal_splitter: true,
        used_llm_planner: input.usedLlmPlanner,
        used_act_planner: input.actPlannerCalledThisRun,
        per_goal_act_retrieval: false,
        used_global_fallback: input.useLowConfidenceFallback,
      },
      goals_summary: [
        {
          goal_id: input.goalId,
          goal_type: input.goalType,
          subquery_preview: input.effectiveQuery.slice(0, 200),
          used_llm_planner: input.usedLlmPlanner,
          act_candidates_top3: (input.actCandidatesTopHydrated ?? []).slice(0, 3).map((candidate) => candidate.rada_nreg),
          hits_count: input.hits.length,
          top_score: input.topScore,
        },
      ],
      distribution:
        Object.keys(input.hitsByActTop3).length > 0 ||
        input.noisePenaltyCount > 0 ||
        input.noisePenaltyGuardBlockedCount > 0
          ? {
              hits_by_act_top3: Object.keys(input.hitsByActTop3).length > 0 ? input.hitsByActTop3 : undefined,
              avg_score_by_act_top3:
                Object.keys(input.avgScoreByActTop3).length > 0 ? input.avgScoreByActTop3 : undefined,
              noise_penalty_applied_count: input.noisePenaltyCount > 0 ? input.noisePenaltyCount : undefined,
              noise_penalty_policy_version: NOISE_PENALTY_POLICY_VERSION,
              noise_penalty_guard_blocked: input.noisePenaltyGuardBlockedCount > 0,
              noise_penalty_guard_reason_codes:
                input.noisePenaltyGuardReasonCodes.length > 0 ? input.noisePenaltyGuardReasonCodes : undefined,
            }
          : undefined,
      reason_codes: input.reasonCodes.length ? input.reasonCodes : undefined,
      selected_acts_sources_breakdown: input.selectedActsSourcesBreakdown,
      chunks_evidence_top_acts: input.chunksEvidenceTopActs,
      selected_acts_decision: input.selectedActsFinalMeta.selected_acts_decision_final,
      selected_acts_confidence: input.selectedActsFinalMeta.selected_acts_confidence_final,
      selected_acts_confidence_pre_routing: input.selectedActsFinalMeta.selected_acts_confidence_pre_routing,
      selected_acts_kinds_count: input.selectedActsFinalMeta.selected_acts_kinds_count_final,
      selected_acts_document_types_top: input.selectedActsFinalMeta.selected_acts_document_types_top_final,
      family_evidence_summary: toFamilyEvidenceSummary(input.familyEvidence),
      family_evidence_reason_codes:
        input.familyEvidence.reason_codes.length ? input.familyEvidence.reason_codes : undefined,
      routing_hints: input.routingHintsMeta,
      reference_expansion: input.referenceExpansionMeta,
      article_backfill: input.articleBackfillMeta,
      ood_guard: input.oodGuardResult,
      low_confidence_suppressed: lowConfidenceSuppressed,
      qdrant_calls_count_total: input.qdrantCallsCountTotal,
      planner: {
        tier_selected: input.plannerMeta.tier,
        called: input.plannerCalledThisRun,
        call_failed_reason: input.plannerMeta.reason_codes?.[0],
        tier: input.plannerMeta.tier,
        model_id: input.plannerMeta.model_id,
        duration_ms: input.plannerMeta.duration_ms,
        degraded: input.plannerMeta.degraded,
        reason_codes: input.plannerMeta.reason_codes,
      },
      memory: input.memoryMeta,
      retrieval_debug_bundle: {
        per_goal_act_candidates_top: (input.actCandidatesTopHydrated ?? []).map((candidate) => ({
          rada_nreg: candidate.rada_nreg,
          title: candidate.title,
          score: candidate.score,
        })),
        stages: input.retrievalDebugStages,
        distribution_by_act: Object.keys(input.hitsByActTop3).length > 0 ? input.hitsByActTop3 : undefined,
        distribution_by_goal: [{ goal_id: input.goalId, hits_count: input.hits.length }],
        selected_acts_sources_breakdown: input.selectedActsSourcesBreakdown,
        chunks_evidence_top_acts: input.chunksEvidenceTopActs,
        selected_acts_decision: input.selectedActsFinalMeta.selected_acts_decision_final,
        family_evidence_top2: input.familyEvidence.debug.top_families,
      },
    },
  };
}
