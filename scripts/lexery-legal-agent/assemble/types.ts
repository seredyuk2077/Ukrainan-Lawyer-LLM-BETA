/**
 * U9 Assemble — EvidencePack handoff contract (LEX-109)
 * Evidence-only refs for Writer; no full text in RunRecord.
 */
import { z } from 'zod';

export const RawHitRefSchema = z.object({
  r2_key: z.string().min(1),
  json_path: z.string().min(1),
  score: z.number().optional(),
  rada_nreg: z.string().optional(),
  article_number: z.string().nullable().optional(),
  title: z.string().optional(),
});

export type RawHitRef = z.infer<typeof RawHitRefSchema>;

export const MemoryRefSchema = z
  .object({
    id: z.string().optional(),
    scope_type: z.string().optional(),
    scope_id: z.string().optional(),
    content_preview: z.string().max(500).optional(),
  })
  .passthrough();

export type MemoryRef = z.infer<typeof MemoryRefSchema>;

export const EvidencePackSchema = z.object({
  raw_hit_refs: z.array(RawHitRefSchema),
  memory_refs: z.array(MemoryRefSchema).optional(),
  meta: z
    .object({
      assembled_at: z.string().optional(),
      total_refs: z.number().int().min(0).optional(),
    })
    .optional(),
});

export type EvidencePack = z.infer<typeof EvidencePackSchema>;
