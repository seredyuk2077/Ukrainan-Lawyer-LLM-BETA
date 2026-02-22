/**
 * U3 Plan — SearchPlan + SearchStep contracts (LEX-105)
 * Sources, thresholds, timeouts; concrete steps for U3a Builder.
 */
import { z } from 'zod';

// --- SearchPlan (U3 rules output: "де шукати?") ---

export const SearchPlanSourcesSchema = z.object({
  use_lldbi: z.boolean(),
  use_memory: z.boolean(),
  use_doclist: z.boolean(),
  use_web: z.boolean().optional(),
});

export const SearchPlanThresholdsSchema = z.object({
  top_k_chunks: z.number().int().min(1).max(200).optional(),
  top_k_acts: z.number().int().min(1).max(50).optional(),
  min_score: z.number().min(0).max(1).optional(),
  embedding_required: z.boolean().optional(),
});

export const SearchPlanSchema = z.object({
  version: z.number().int().min(1),
  sources: SearchPlanSourcesSchema,
  thresholds: SearchPlanThresholdsSchema.optional(),
  reason_codes: z.array(z.string()).optional(),
  meta: z
    .object({
      built_at: z.string(),
      builder_version: z.string().optional(),
      rules_version: z.string().optional(),
      use_preview: z.boolean().optional(),
      assemble_attachments: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

export type SearchPlanSources = z.infer<typeof SearchPlanSourcesSchema>;
export type SearchPlanThresholds = z.infer<typeof SearchPlanThresholdsSchema>;
export type SearchPlan = z.infer<typeof SearchPlanSchema>;

// --- SearchStep (U3a Builder output: concrete steps) ---

export const SearchStepKindSchema = z.enum([
  'lldbi_chunks',
  'lldbi_acts',
  'memory',
  'doclist',
  'import_fast',
  'web',
]);

export const SearchStepSchema = z.object({
  kind: SearchStepKindSchema,
  params: z
    .object({
      top_k: z.number().int().min(1).max(200).optional(),
      min_score: z.number().min(0).max(1).optional(),
      timeout_ms: z.number().int().min(100).max(60_000).optional(),
      nreg_filter: z.string().optional(),
    })
    .passthrough()
    .optional(),
  order: z.number().int().min(0).optional(),
});

export type SearchStepKind = z.infer<typeof SearchStepKindSchema>;
export type SearchStep = z.infer<typeof SearchStepSchema>;

export const SearchStepsSchema = z.array(SearchStepSchema);
export type SearchSteps = z.infer<typeof SearchStepsSchema>;

// --- RunRecord audit: search_plan payload (JSONB) ---

export const RunRecordSearchPlanAuditSchema = z.object({
  plan: SearchPlanSchema,
  steps: SearchStepsSchema.optional(),
  built_at: z.string().optional(),
  next_step: z.string().optional(), // e.g. 'U4' after U3a
});

export type RunRecordSearchPlanAudit = z.infer<typeof RunRecordSearchPlanAuditSchema>;
