/**
 * U4 CacheRAG — RawHit + RetrievalTrace contracts (LEX-106)
 * Provenance: r2_key + json_path per LLDBI; audit trace in RunRecord.
 */
import { z } from 'zod';

// --- RawHit (U4 output: pointer to R2 fragment, no full text in RunRecord) ---

export const RawHitSourceSchema = z.enum(['lldbi_chunks', 'lldbi_acts', 'memory']);
export type RawHitSource = z.infer<typeof RawHitSourceSchema>;

export const RawHitSchema = z.object({
  r2_key: z.string().min(1),
  json_path: z.string().min(1), // e.g. $.content.chunks[N].text
  score: z.number(),
  source: RawHitSourceSchema.optional(),
  rada_nreg: z.string().optional(),
  article_number: z.string().nullable().optional(),
  title: z.string().optional(),
  /** Multi-goal: which evidence goal this hit belongs to. */
  goal_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type RawHit = z.infer<typeof RawHitSchema>;

export const RawHitsSchema = z.array(RawHitSchema);
export type RawHits = z.infer<typeof RawHitsSchema>;

// --- SampleHit (refs only, for audit/verify; max 3–5 in meta.sample_hits) ---

export const SampleHitSchema = z.object({
  source: RawHitSourceSchema.optional(),
  score: z.number(),
  r2_key: z.string().min(1),
  json_path: z.string().min(1),
  act_title: z.string().optional(),
  article_ref: z.string().nullable().optional(),
  chunk_id: z.union([z.string(), z.number()]).optional(),
});
export type SampleHit = z.infer<typeof SampleHitSchema>;

// --- RetrievalTrace (audit: persisted to runs.retrieval_trace) ---

export const DegradedSourcesSchema = z.object({
  lldbi: z.boolean().optional(),
  memory: z.boolean().optional(),
  doclist: z.boolean().optional(),
});

export const RetrievalTraceSchema = z.object({
  version: z.number().int().min(1),
  hits: RawHitsSchema,
  top_score: z.number().nullable().optional(),
  latency_ms: z.number().int().min(0).optional(),
  degraded_sources: DegradedSourcesSchema.optional(),
  meta: z
    .object({
      source: z.string().optional(),
      collection: z.string().optional(),
      collections_used: z.array(z.string()).optional(),
      steps_latency_ms: z.array(z.number()).optional(),
      sample_hits: z.array(SampleHitSchema).max(5).optional(),
      steps_requested: z.array(z.string()).optional(),
      steps_executed: z.array(z.string()).optional(),
      query_used: z.string().max(300).optional(),
      hits_count: z.number().int().min(0).optional(),
      avg_score: z.number().optional(),
      low_confidence: z.boolean().optional(),
      query_variants_used: z.array(z.string()).optional(),
      used_filtered_chunks_search: z.boolean().optional(),
      anchors_used: z.array(z.string()).optional(),
      taxonomy_snapshot_version: z.number().nullable().optional(),
      hybrid_rescore_used: z.boolean().optional(),
      why_low_confidence: z.string().optional(),
      thesaurus_version: z.number().int().optional(),
      act_candidates_top: z
        .array(
          z.object({
            rada_nreg: z.string(),
            title: z.string().optional(),
            score: z.number().optional(),
            reasons: z.array(z.string()).optional(),
          })
        )
        .optional(),
      stage_decisions: z
        .object({
          used_taxonomy: z.boolean().optional(),
          used_acts_search: z.boolean().optional(),
          used_filtered_chunks: z.boolean().optional(),
          used_llm_rewrite: z.boolean().optional(),
          used_llm_rerank: z.boolean().optional(),
          used_goal_splitter: z.boolean().optional(),
          used_llm_planner: z.boolean().optional(),
          used_act_planner: z.boolean().optional(),
          per_goal_act_retrieval: z.boolean().optional(),
          used_global_fallback: z.boolean().optional(),
        })
        .optional(),
      goals_summary: z
        .array(
          z.object({
            goal_id: z.string(),
            goal_type: z.string().optional(),
            subquery_preview: z.string().max(200).optional(),
            used_llm_planner: z.boolean().optional(),
            act_candidates_top3: z.array(z.string()).optional(),
            hits_count: z.number().optional(),
            top_score: z.number().nullable().optional(),
          })
        )
        .optional(),
      fusion: z
        .object({
          coverage_enforced: z.boolean().optional(),
          per_goal_min_hits: z.number().optional(),
          topN: z.number().optional(),
          /** Per-goal hit counts in top-N (for observability). */
          per_goal_counts_in_topN: z.record(z.number()).optional(),
        })
        .optional(),
      planner: z
        .object({
          /** 0 = no LLM, 1 = cheap/short, 2 = full planner */
          tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
          model_id: z.string().optional(),
          duration_ms: z.number().optional(),
          degraded: z.boolean().optional(),
          reason_codes: z.array(z.string()).optional(),
        })
        .optional(),
      distribution: z
        .object({
          hits_by_act_top3: z.record(z.number()).optional(),
          avg_score_by_act_top3: z.record(z.number()).optional(),
          noise_penalty_applied_count: z.number().optional(),
        })
        .optional(),
      reason_codes: z.array(z.string()).optional(),
      /** Act list for writer (Phase 5.4): top acts with why_selected. */
      selected_acts: z
        .array(
          z.object({
            rada_nreg: z.string(),
            act_title: z.string().optional(),
            family: z.string().optional(),
            score: z.number().optional(),
            why_selected: z.string().max(200).optional(),
          })
        )
        .optional(),
      used_act_planner: z.boolean().optional(),
      /** Phase 1 diagnostics: where selected_acts came from. */
      selected_acts_sources_breakdown: z
        .object({
          from_taxonomy: z.array(z.string()).optional(),
          from_acts_search: z.array(z.string()).optional(),
          from_chunks_evidence: z.array(z.string()).optional(),
        })
        .optional(),
      /** Top acts by count/score in top-30 hits (chunks evidence). */
      chunks_evidence_top_acts: z
        .array(
          z.object({
            rada_nreg: z.string(),
            count_in_top30: z.number(),
            avg_score_in_top30: z.number(),
            max_score: z.number(),
          })
        )
        .optional(),
      /** Selected-acts decision metadata (policy version, whether chunks evidence was used). */
      selected_acts_decision: z
        .object({
          policy_version: z.number().optional(),
          included_from_chunks_evidence: z.boolean().optional(),
          reason_codes: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .passthrough()
    .optional(),
});

export type DegradedSources = z.infer<typeof DegradedSourcesSchema>;
export type RetrievalTrace = z.infer<typeof RetrievalTraceSchema>;
