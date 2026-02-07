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
  source: RawHitSourceSchema.optional(), // which collection produced this hit
  rada_nreg: z.string().optional(),
  article_number: z.string().nullable().optional(),
  title: z.string().optional(),
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
    })
    .passthrough()
    .optional(),
});

export type DegradedSources = z.infer<typeof DegradedSourcesSchema>;
export type RetrievalTrace = z.infer<typeof RetrievalTraceSchema>;
