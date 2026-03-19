/**
 * U4 CacheRAG — RawHit + RetrievalTrace contracts (LEX-106)
 * Provenance: r2_key + json_path per LLDBI; audit trace in RunRecord.
 */
import { z } from 'zod';

// --- RawHit (U4 output: pointer to R2 fragment, no full text in RunRecord) ---

export const RawHitSourceSchema = z.enum(['lldbi_chunks', 'lldbi_acts', 'memory', 'REFERENCE_EXPANSION']);
export type RawHitSource = z.infer<typeof RawHitSourceSchema>;

export const RawHitSchema = z.object({
  r2_key: z.string().min(1),
  json_path: z.string().min(1), // e.g. $.content.chunks[N].text
  score: z.number(),
  /** Post-vector ordering score after hybrid rerank. Keeps rerank stable through later pipeline stages. */
  ordering_score: z.number().optional(),
  source: RawHitSourceSchema.optional(),
  rada_nreg: z.string().optional(),
  article_number: z.string().nullable().optional(),
  unit_number: z.string().nullable().optional(),
  unit_type: z.string().nullable().optional(),
  article_part_number: z.string().nullable().optional(),
  point_number: z.string().nullable().optional(),
  subpoint_number: z.string().nullable().optional(),
  paragraph_number: z.string().nullable().optional(),
  note_number: z.string().nullable().optional(),
  citation_path: z.string().nullable().optional(),
  title: z.string().optional(),
  document_type: z.string().nullable().optional(),
  document_type_slug: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  storage_category: z.string().nullable().optional(),
  validity_status: z.string().nullable().optional(),
  unstructured_fallback: z.boolean().optional(),
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
  unit_ref: z.string().nullable().optional(),
  unit_type: z.string().nullable().optional(),
  citation_ref: z.string().nullable().optional(),
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
      multi_query_variants_count: z.number().int().min(0).optional(),
      used_filtered_chunks_search: z.boolean().optional(),
      within_act_policy: z.array(z.string()).optional(),
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
            why_tag: z.string().optional(),
            source_tier: z.string().optional(),
            category: z.string().optional(),
            document_type: z.string().optional(),
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
          used_multi_query: z.boolean().optional(),
          used_goal_splitter: z.boolean().optional(),
          used_llm_planner: z.boolean().optional(),
          used_act_planner: z.boolean().optional(),
          per_goal_act_retrieval: z.boolean().optional(),
          used_global_fallback: z.boolean().optional(),
          /** Multi-goal: whether taxonomy cluster split v2 was used for goal decomposition. */
          goal_split_v2: z.boolean().optional(),
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
          /** Alias for tier (legacy field, same value). */
          tier_selected: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
          called: z.boolean().optional(),
          call_failed_reason: z.string().optional(),
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
          noise_penalty_policy_version: z.number().optional(),
          noise_penalty_guard_blocked: z.boolean().optional(),
          noise_penalty_guard_reason_codes: z.array(z.string()).optional(),
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
            /** Source tags for this act (CHUNKS_EVIDENCE, TAXONOMY, ACTS_SEARCH, FAMILY_GUARD, ROUTING_HINTS, etc.). */
            source_tags: z.array(z.string()).optional(),
            /** LLDBI/taxonomy metadata, hydrated by rada_nreg when missing. */
            document_type: z.string().nullable().optional(),
            category: z.string().nullable().optional(),
            storage_category: z.string().nullable().optional(),
            /** Act kind classifier output (PRIMARY_LAW / SECONDARY_ORDER / ... / UNKNOWN). */
            act_kind: z.string().optional(),
            /** Flags for Writer (e.g. recovered/keep_one/draft/opinion). */
            flags: z
              .object({
                recovered: z.boolean().optional(),
                keep_one: z.boolean().optional(),
                draft: z.boolean().optional(),
                opinion: z.boolean().optional(),
              })
              .optional(),
            /** Per-act confidence (usually selected_acts_confidence copied per item). */
            confidence: z.number().optional(),
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
          from_routing_hints: z.array(z.string()).optional(),
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
            best_rank_in_top30: z.number().optional(),
            rank_mass_top30: z.number().optional(),
            max_ordering_score: z.number().optional(),
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
      selected_acts_confidence_pre_routing: z.number().optional(),
      article_backfill: z
        .object({
          added_count: z.number().optional(),
          not_found_refs: z.array(z.string()).optional(),
          calls: z.number().optional(),
          preferred_rada_nreg: z.string().optional(),
          used_structural_filter: z.boolean().optional(),
          used_post_filter_fallback: z.boolean().optional(),
          fallback_reason_code: z.string().optional(),
        })
        .optional(),
      /** U4 Reference expansion: extract refs from top chunks, resolve via taxonomy, add hits. */
      reference_expansion: z
        .object({
          enabled: z.boolean().optional(),
          attempted: z.boolean().optional(),
          added_count: z.number().optional(),
          referenced_acts: z.array(z.string()).optional(),
          parse_hits_used: z.number().optional(),
          skipped_reason_codes: z.array(z.string()).optional(),
        })
        .optional(),
      /** U4 LLDBI Soft Prior: data-driven boost trace (policy_version, categories, doc_types, applied count). */
      lldbi_soft_prior: z
        .object({
          enabled: z.boolean().optional(),
          categories_top3: z.array(z.string()).optional(),
          doc_types_top3: z.array(z.string()).optional(),
          applied_acts_count: z.number().optional(),
          max_category_boost: z.number().optional(),
          max_doc_type_boost: z.number().optional(),
          taxonomy_first_reorder: z.boolean().optional(),
          policy_version: z.number().optional(),
        })
        .optional(),
      /** U4 OOD Confidence Guard: fired, why, thresholds. */
      ood_guard: z
        .object({
          fired: z.boolean().optional(),
          why: z.array(z.string()).optional(),
          thresholds: z
            .object({
              top_score: z.number().optional(),
              avg_score: z.number().optional(),
            })
            .optional(),
        })
        .optional(),
      /**
       * U4 low_confidence suppression trace: set when Fix A (specialized domain, no PRIMARY_LAW needed)
       * or Fix B (COVERAGE_GUARD_FAILED + FAMILY_DOMINANT_OK coexistence) suppresses low_confidence.
       * Allows writer/trace consumers to see that low_confidence WOULD have fired but was correctly suppressed.
       */
      low_confidence_suppressed: z
        .object({
          fired: z.boolean(),
          suppressed_reasons: z.array(z.string()),
        })
        .optional(),
      /**
       * U4 Memory Retrieval trace (LEX-MEM): recent mm_memory_items fetch result.
       * degraded=true means fetch failed (non-fatal); pipeline always continues.
       */
      memory: z
        .object({
          enabled: z.boolean().optional(),
          semantic_enabled: z.boolean().optional(),
          recent_count: z.number().int().min(0).optional(),
          semantic_count: z.number().int().min(0).optional(),
          degraded: z.boolean().optional(),
          degraded_reason_codes: z.array(z.string()).optional(),
          latency_ms: z
            .object({
              recent: z.number().optional(),
              semantic: z.number().optional(),
            })
            .optional(),
          sources_used: z.array(z.string()).optional(),
        })
        .optional(),
      /** U4 Always-on Query Rewriter: trace per run. */
      query_rewrite: z
        .object({
          enabled: z.boolean().optional(),
          called: z.boolean().optional(),
          used: z.boolean().optional(),
          model_id: z.string().optional(),
          attempts: z.number().optional(),
          duration_ms: z.number().optional(),
          parse_mode: z.enum(['strict', 'extract']).optional(),
          rewritten_query: z.string().optional(),
          variants: z.array(z.string()).optional(),
          negative_terms: z.array(z.string()).optional(),
          categories_top3: z.array(z.string()).optional(),
          doc_types_top3: z.array(z.string()).optional(),
          confidence: z.number().optional(),
          not_used_reason_codes: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .passthrough()
    .optional(),
});

export type DegradedSources = z.infer<typeof DegradedSourcesSchema>;
export type RetrievalTrace = z.infer<typeof RetrievalTraceSchema>;
