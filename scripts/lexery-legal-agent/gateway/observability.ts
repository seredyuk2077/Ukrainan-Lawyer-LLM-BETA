/**
 * U1 Observability (LEX-74) — Metrics stub
 * U2 Observability (LEX-90) — u2_* counters, queue/inflight/rate_limited
 */
const metrics: Record<string, number> = {
  runs_started_total: 0,
  runs_rejected_total: 0,
  runs_failed_total: 0,
  enqueue_latency_ms: 0,
  db_write_latency_ms: 0,
  u2_processed_total: 0,
  u2_failed_total: 0,
  u2_ambiguous_total: 0,
  u2_queue_depth: 0,
  u2_inflight_total: 0,
  u2_llm_inflight_total: 0,
  u2_llm_rate_limited_total: 0,
  u2_gating_llm_skipped_total: 0,
  u2_gating_llm_called_total: 0,
  u3_processed_total: 0,
  u3_failed_total: 0,
  u3_duration_ms: 0,
  u3a_processed_total: 0,
  u3a_failed_total: 0,
  u3a_steps_count: 0,
  u4_processed_total: 0,
  u4_failed_total: 0,
  u4_qdrant_latency_ms: 0,
  u4_qdrant_calls_total: 0,
  u4_hits_total: 0,
  u4_degraded_lldbi_total: 0,
  u4_filtered_search_total: 0,
  u4_low_confidence_total: 0,
  u4_planner_tier_selected_0_total: 0,
  u4_planner_tier_selected_1_total: 0,
  u4_planner_tier_selected_2_total: 0,
  u4_planner_calls_1_total: 0,
  u4_planner_calls_2_total: 0,
  u4_goals_count_1_total: 0,
  u4_goals_count_2_total: 0,
  u4_goals_count_3_total: 0,
  u4_coverage_enforced_total: 0,
  u4_noise_penalty_total: 0,
  u4_hits_cap_applied_total: 0,
  u4_hits_before_cap_le_100_total: 0,
  u4_hits_before_cap_101_200_total: 0,
  u4_hits_before_cap_gt_200_total: 0,
  u4_family_conflict_total: 0,
  u4_family_weak_evidence_total: 0,
  u4_routing_hints_called_total: 0,
  u4_routing_hints_failed_total: 0,
  u4_routing_hints_used_total: 0,
  u4_routing_hints_not_used_total: 0,
  u4_routing_hints_invalid_json_total: 0,
  u4_query_rewrite_called_total: 0,
  u4_query_rewrite_failed_total: 0,
  u4_query_rewrite_used_total: 0,
  u4_domain_bootstrap_attempted_total: 0,
  u4_domain_bootstrap_used_total: 0,
  u4_domain_bootstrap_conflict_total: 0,
  taxonomy_refresh_success_total: 0,
  taxonomy_refresh_failed_total: 0,
  taxonomy_snapshot_age_seconds: 0,
  u4_taxonomy_category_hints_used_total: 0,
  u4_taxonomy_doc_type_hints_used_total: 0,
  u4_taxonomy_hints_injected_acts_total: 0,
  u4_lldbi_hints_present_total: 0,
  u4_lldbi_hints_used_total: 0,
  u4_lldbi_hints_injected_acts_total: 0,
  // U4 Memory (LEX-MEM)
  u4_memory_recent_count_total: 0,
  u4_memory_degraded_total: 0,
  u4_memory_latency_ms_total: 0,
  u4_memory_latency_ms_count: 0,
  u5_processed_total: 0,
  u5_failed_total: 0,
  u5_expand_total: 0,
  u5_no_expand_total: 0,
  u2_ai_domain_called_total: 0,
  u2_ai_domain_used_total: 0,
  u2_ai_domain_invalid_json_total: 0,
  u2_ai_domain_conf_too_low_total: 0,
  u2_ai_domain_disagrees_with_heuristic_total: 0,
  u2_ai_routing_called_total: 0,
  u2_ai_routing_used_total: 0,
  u2_ai_routing_invalid_json_total: 0,
  u2_ai_routing_conf_too_low_total: 0,
  u2_ai_routing_disagrees_with_heuristic_total: 0,
  u2_rules_routing_derived_total: 0,
  u2_rules_doc_type_nonempty_total: 0,
  u2_rules_category_nonempty_total: 0,
};

const u2IntentCounts: Record<string, number> = {};
const u2DomainCounts: Record<string, number> = {};
const u2GatingReasonCounts: Record<string, number> = {};

export function incrementRunsStarted() {
  metrics.runs_started_total += 1;
}

export function incrementRunsRejected(reason: string) {
  metrics.runs_rejected_total += 1;
}

export function incrementRunsFailed(reason: string) {
  metrics.runs_failed_total += 1;
}

export function recordEnqueueLatency(ms: number) {
  metrics.enqueue_latency_ms = ms;
}

export function recordDbWriteLatency(ms: number) {
  metrics.db_write_latency_ms = ms;
}

export function getMetrics() {
  return {
    ...metrics,
    u2_intent: { ...u2IntentCounts },
    u2_domain: { ...u2DomainCounts },
    u2_gating_reason: { ...u2GatingReasonCounts },
    u4_routing_hints_not_used_by_reason: getU4RoutingHintsNotUsedBreakdown(),
  };
}

// U2 (LEX-90)
export function incrementU2Processed() {
  metrics.u2_processed_total += 1;
}
export function incrementU2Failed() {
  metrics.u2_failed_total += 1;
}
export function incrementU2Ambiguous() {
  metrics.u2_ambiguous_total += 1;
}
export function incrementU2Intent(intent: string) {
  u2IntentCounts[intent] = (u2IntentCounts[intent] || 0) + 1;
}
export function incrementU2Domain(domain: string) {
  u2DomainCounts[domain] = (u2DomainCounts[domain] || 0) + 1;
}

export function setU2QueueDepth(n: number) {
  metrics.u2_queue_depth = n;
}
export function incrementU2Inflight() {
  metrics.u2_inflight_total += 1;
}
export function decrementU2Inflight() {
  metrics.u2_inflight_total = Math.max(0, metrics.u2_inflight_total - 1);
}
export function incrementU2LlmInflight() {
  metrics.u2_llm_inflight_total += 1;
}
export function decrementU2LlmInflight() {
  metrics.u2_llm_inflight_total = Math.max(0, metrics.u2_llm_inflight_total - 1);
}
export function incrementU2LlmRateLimited() {
  metrics.u2_llm_rate_limited_total += 1;
}

export function incrementU2GatingLlmSkipped() {
  metrics.u2_gating_llm_skipped_total += 1;
}
export function incrementU2GatingLlmCalled() {
  metrics.u2_gating_llm_called_total += 1;
}
export function incrementU2GatingReason(reason: string) {
  const key = reason.replace(/\s+/g, '_').slice(0, 64);
  u2GatingReasonCounts[key] = (u2GatingReasonCounts[key] || 0) + 1;
}

export function incrementU2AiDomainCalled() {
  metrics.u2_ai_domain_called_total += 1;
}
export function incrementU2AiDomainUsed() {
  metrics.u2_ai_domain_used_total += 1;
}
export function incrementU2AiDomainInvalidJson() {
  metrics.u2_ai_domain_invalid_json_total += 1;
}
export function incrementU2AiDomainConfTooLow() {
  metrics.u2_ai_domain_conf_too_low_total += 1;
}
export function incrementU2AiDomainDisagreesWithHeuristic() {
  metrics.u2_ai_domain_disagrees_with_heuristic_total += 1;
}

export function incrementU2AiRoutingCalled() {
  metrics.u2_ai_routing_called_total += 1;
}
export function incrementU2AiRoutingUsed() {
  metrics.u2_ai_routing_used_total += 1;
}
export function incrementU2AiRoutingInvalidJson() {
  metrics.u2_ai_routing_invalid_json_total += 1;
}
export function incrementU2AiRoutingConfTooLow() {
  metrics.u2_ai_routing_conf_too_low_total += 1;
}
export function incrementU2AiRoutingDisagreesWithHeuristic() {
  metrics.u2_ai_routing_disagrees_with_heuristic_total += 1;
}
export function incrementU2RulesRoutingDerived() {
  metrics.u2_rules_routing_derived_total += 1;
}
export function incrementU2RulesDocTypeNonempty() {
  metrics.u2_rules_doc_type_nonempty_total += 1;
}
export function incrementU2RulesCategoryNonempty() {
  metrics.u2_rules_category_nonempty_total += 1;
}

// U3 / U3a (LEX-112, LEX-113)
export function incrementU3Processed() {
  metrics.u3_processed_total += 1;
}
export function incrementU3Failed() {
  metrics.u3_failed_total += 1;
}
export function recordU3Duration(ms: number) {
  metrics.u3_duration_ms = ms;
}
export function incrementU3aProcessed() {
  metrics.u3a_processed_total += 1;
}
export function incrementU3aFailed() {
  metrics.u3a_failed_total += 1;
}
export function recordU3aStepsCount(n: number) {
  metrics.u3a_steps_count = n;
}

// U4 CacheRAG (LEX-114, LEX-117)
export function incrementU4Processed() {
  metrics.u4_processed_total += 1;
}
export function incrementU4Failed() {
  metrics.u4_failed_total += 1;
}
export function recordU4QdrantLatency(ms: number) {
  metrics.u4_qdrant_latency_ms = ms;
}
export function recordU4Hits(n: number) {
  metrics.u4_hits_total = n;
}
export function incrementU4DegradedLldbi() {
  metrics.u4_degraded_lldbi_total += 1;
}
export function incrementU4FilteredSearch() {
  metrics.u4_filtered_search_total += 1;
}
export function incrementU4LowConfidence() {
  metrics.u4_low_confidence_total += 1;
}
export function incrementU4QdrantCalls(n: number) {
  metrics.u4_qdrant_calls_total += n;
}
export function incrementU4PlannerTierSelected(tier: 0 | 1 | 2) {
  if (tier === 0) metrics.u4_planner_tier_selected_0_total += 1;
  else if (tier === 1) metrics.u4_planner_tier_selected_1_total += 1;
  else metrics.u4_planner_tier_selected_2_total += 1;
}
export function incrementU4PlannerCalls(tier: 1 | 2) {
  if (tier === 1) metrics.u4_planner_calls_1_total += 1;
  else metrics.u4_planner_calls_2_total += 1;
}
export function incrementU4GoalsCount(n: number) {
  if (n <= 1) metrics.u4_goals_count_1_total += 1;
  else if (n === 2) metrics.u4_goals_count_2_total += 1;
  else metrics.u4_goals_count_3_total += 1;
}
export function incrementU4CoverageEnforced() {
  metrics.u4_coverage_enforced_total += 1;
}
export function incrementU4NoisePenalty() {
  metrics.u4_noise_penalty_total += 1;
}
export function incrementU4HitsCapApplied() {
  metrics.u4_hits_cap_applied_total += 1;
}
export function recordU4HitsBeforeCapBucket(beforeCap: number) {
  if (beforeCap <= 100) metrics.u4_hits_before_cap_le_100_total += 1;
  else if (beforeCap <= 200) metrics.u4_hits_before_cap_101_200_total += 1;
  else metrics.u4_hits_before_cap_gt_200_total += 1;
}
export function incrementU4FamilyConflict() {
  metrics.u4_family_conflict_total += 1;
}
export function incrementU4FamilyWeakEvidence() {
  metrics.u4_family_weak_evidence_total += 1;
}
export function incrementU4RoutingHintsCalled() {
  metrics.u4_routing_hints_called_total += 1;
}
export function incrementU4RoutingHintsFailed() {
  metrics.u4_routing_hints_failed_total += 1;
}
export function incrementU4RoutingHintsUsed() {
  metrics.u4_routing_hints_used_total += 1;
}

const u4RoutingHintsNotUsedByReason: Record<string, number> = {};

export function incrementU4RoutingHintsNotUsed(reason: string) {
  metrics.u4_routing_hints_not_used_total += 1;
  const key = reason.slice(0, 64);
  u4RoutingHintsNotUsedByReason[key] = (u4RoutingHintsNotUsedByReason[key] ?? 0) + 1;
}

export function incrementU4RoutingHintsInvalidJson() {
  metrics.u4_routing_hints_invalid_json_total += 1;
}

export function getU4RoutingHintsNotUsedBreakdown(): Record<string, number> {
  return { ...u4RoutingHintsNotUsedByReason };
}

// U4 Always-on Query Rewriter (Phase 7)
export function incrementU4QueryRewriteCalled() {
  metrics.u4_query_rewrite_called_total += 1;
}
export function incrementU4QueryRewriteFailed() {
  metrics.u4_query_rewrite_failed_total += 1;
}
export function incrementU4QueryRewriteUsed() {
  metrics.u4_query_rewrite_used_total += 1;
}

// U4 Domain bootstrap (evidence-based, no wordlists)
export function incrementU4DomainBootstrapAttempted() {
  metrics.u4_domain_bootstrap_attempted_total += 1;
}
export function incrementU4DomainBootstrapUsed() {
  metrics.u4_domain_bootstrap_used_total += 1;
}
export function incrementU4DomainBootstrapConflict() {
  metrics.u4_domain_bootstrap_conflict_total += 1;
}

// U4 ActTaxonomyStore (LEX-114, LEX-117)
export function incrementTaxonomyRefreshSuccess() {
  metrics.taxonomy_refresh_success_total += 1;
}
export function incrementTaxonomyRefreshFailed() {
  metrics.taxonomy_refresh_failed_total += 1;
}
export function setTaxonomySnapshotAgeSeconds(seconds: number) {
  metrics.taxonomy_snapshot_age_seconds = Math.max(0, seconds);
}
export function addU4TaxonomyCategoryHintsUsed(count: number) {
  metrics.u4_taxonomy_category_hints_used_total += count;
}
export function addU4TaxonomyDocTypeHintsUsed(count: number) {
  metrics.u4_taxonomy_doc_type_hints_used_total += count;
}
export function addU4TaxonomyHintsInjectedActs(count: number) {
  metrics.u4_taxonomy_hints_injected_acts_total += count;
}
export function incrementU4LldbiHintsPresent() {
  metrics.u4_lldbi_hints_present_total += 1;
}
export function incrementU4LldbiHintsUsed() {
  metrics.u4_lldbi_hints_used_total += 1;
}
export function addU4LldbiHintsInjectedActs(count: number) {
  metrics.u4_lldbi_hints_injected_acts_total += count;
}

// U4 Memory (LEX-MEM)
export function addU4MemoryRecentCount(count: number) {
  metrics.u4_memory_recent_count_total += count;
}
export function incrementU4MemoryDegraded() {
  metrics.u4_memory_degraded_total += 1;
}
export function recordU4MemoryLatency(latencyMs: number) {
  metrics.u4_memory_latency_ms_total += latencyMs;
  metrics.u4_memory_latency_ms_count += 1;
}

// U5 Gate (LEX-118)
export function incrementU5Processed() {
  metrics.u5_processed_total += 1;
}
export function incrementU5Failed() {
  metrics.u5_failed_total += 1;
}
export function incrementU5Expand() {
  metrics.u5_expand_total += 1;
}
export function incrementU5NoExpand() {
  metrics.u5_no_expand_total += 1;
}
