/**
 * U5 Gate — GateDecision contract (LEX-118)
 */
import { z } from 'zod';

export const GateDecisionReasonCodeSchema = z.enum([
  'FEW_HITS',
  'LOW_SCORE',
  'DIRECT_REF_MISSING',
  'AMBIGUOUS_QUERY',
  'NEED_DEEP_RETRIEVAL',
  'DEGRADED_LLDBI',
  'WEAK_EVIDENCE',
  'LIKELY_MISSING_ACT',
  'OUT_OF_SCOPE_QUERY',
  'DOCLIST_DISABLED',
  'FORCE_EXPAND',
  'OK',
]);
export type GateDecisionReasonCode = z.infer<typeof GateDecisionReasonCodeSchema>;

export const GateDecisionThresholdsSchema = z.object({
  min_hits: z.number().int().min(0),
  min_avg_score: z.number().min(0).max(1),
});
export type GateDecisionThresholds = z.infer<typeof GateDecisionThresholdsSchema>;

export const GateDecisionSignalsSchema = z.object({
  hits_count: z.number().int().min(0),
  top_score: z.number().nullable(),
  avg_score: z.number().nullable(),
  has_direct_citation: z.boolean().optional(),
  ambiguous: z.boolean().optional(),
  degraded_lldbi: z.boolean().optional(),
  need_deep_retrieval: z.boolean().optional(),
  coverage_gap: z.enum(['none', 'weak_evidence', 'likely_missing_act', 'out_of_scope']).optional(),
  direct_refs_total: z.number().int().min(0).optional(),
  direct_refs_hit: z.number().int().min(0).optional(),
  direct_act_hints_total: z.number().int().min(0).optional(),
  direct_act_hints_hit: z.number().int().min(0).optional(),
});
export type GateDecisionSignals = z.infer<typeof GateDecisionSignalsSchema>;

export const GateDecisionSchema = z.object({
  expand: z.boolean(),
  reason_codes: z.array(GateDecisionReasonCodeSchema),
  thresholds: GateDecisionThresholdsSchema,
  signals: GateDecisionSignalsSchema,
  meta: z
    .object({
      decision_version: z.number().int().min(1),
      evaluated_at_ms: z.number().optional(),
      duration_ms: z.number().int().min(0).optional(),
    })
    .passthrough()
    .optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;
