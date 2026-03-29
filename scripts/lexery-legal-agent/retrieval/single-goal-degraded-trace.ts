import type { CoverageGap, DegradedSources, RetrievalTrace } from './types.js';
import { uniqueStrings } from './helpers/retrieval-utils.js';

export interface BuildSingleGoalDegradedTraceInput {
  queryUsed: string;
  latencyMs: number;
  stepsLatencyMs: number[];
  degradedSources?: DegradedSources;
  collectionsUsed?: string[];
  stepsRequested?: string[];
  error?: string;
  coverageGap?: CoverageGap;
  reasonCodes?: string[];
  qdrantCallsCountTotal?: number;
}

export function buildSingleGoalDegradedTrace(
  input: BuildSingleGoalDegradedTraceInput
): RetrievalTrace {
  const reasonCodes = uniqueStrings([
    ...(input.reasonCodes ?? []),
    input.degradedSources?.lldbi ? 'DEGRADED_LLDBI' : undefined,
    'LOW_EVIDENCE',
  ]);

  return {
    version: 1,
    hits: [],
    top_score: null,
    latency_ms: input.latencyMs,
    degraded_sources: input.degradedSources,
    meta: {
      collections_used: input.collectionsUsed ?? [],
      steps_latency_ms: input.stepsLatencyMs,
      error: input.error?.slice(0, 200),
      steps_requested: input.stepsRequested ?? [],
      steps_executed: [],
      query_used: input.queryUsed.slice(0, 200),
      hits_count: 0,
      qdrant_calls_count_total: input.qdrantCallsCountTotal ?? 0,
      hits_total_before_cap: 0,
      hits_total_after_cap: 0,
      hits_cap_applied: false,
      low_confidence: true,
      coverage_gap: input.coverageGap ?? 'weak_evidence',
      why_low_confidence: 'DEGRADED_LLDBI',
      reason_codes: reasonCodes,
    },
  };
}
