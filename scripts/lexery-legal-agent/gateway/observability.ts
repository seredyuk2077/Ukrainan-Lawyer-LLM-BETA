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
  u4_hits_total: 0,
  u4_degraded_lldbi_total: 0,
  u4_filtered_search_total: 0,
  u4_low_confidence_total: 0,
  taxonomy_refresh_success_total: 0,
  taxonomy_refresh_failed_total: 0,
  taxonomy_snapshot_age_seconds: 0,
  u5_processed_total: 0,
  u5_failed_total: 0,
  u5_expand_total: 0,
  u5_no_expand_total: 0,
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
