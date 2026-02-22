/**
 * U7 DocList — ActCandidate contract (LEX-107)
 * Aligned with Act Catalog Resolver API ResolveResultItem.
 */
import { z } from 'zod';

export const ActCandidateSchema = z.object({
  nreg: z.string().min(1),
  dokid: z.number().int(),
  nazva: z.string(),
  score: z.number(),
  source_score: z.number().optional(),
  rerank_score: z.number().optional(),
  why: z.string().optional(),
});

export type ActCandidate = z.infer<typeof ActCandidateSchema>;

export const ActCandidatesSchema = z.array(ActCandidateSchema);
export type ActCandidates = z.infer<typeof ActCandidatesSchema>;
