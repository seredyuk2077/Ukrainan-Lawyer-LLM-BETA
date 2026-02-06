/**
 * Zod schema for U2 LLM classifier JSON output (strict validation).
 */
import { z } from 'zod';

const EntityTypeEnum = z.enum(['act_abbrev', 'law_title', 'article_ref', 'authority', 'term']);
const IntentEnum = z.enum(['question', 'drafting', 'procedure', 'research', 'other']);
const DomainEnum = z.enum([
  'criminal',
  'civil',
  'labor',
  'admin',
  'tax',
  'corporate',
  'general',
]);

export const ExtractedEntitySchema = z.object({
  type: EntityTypeEnum,
  value: z.string(),
  norm: z
    .object({
      act: z.string().optional(),
      article: z.string().optional(),
      part: z.string().optional(),
    })
    .optional(),
});

export const AmbiguitySchema = z.object({
  is_ambiguous: z.boolean(),
  reasons: z.array(z.string()),
  ambig_terms: z.array(z.string()).optional(),
});

export const RoutingFlagsSchema = z.object({
  need_deep_retrieval: z.boolean().optional(),
  need_web: z.boolean().optional(),
  ambiguous: z.boolean().optional(),
});

export const LLMClassifyOutputSchema = z.object({
  intent: IntentEnum,
  domain: DomainEnum,
  entities: z.array(ExtractedEntitySchema),
  ambiguity: AmbiguitySchema,
  routing_flags: RoutingFlagsSchema.optional(),
});

export type LLMClassifyOutput = z.infer<typeof LLMClassifyOutputSchema>;

export function parseLLMClassifyOutput(raw: string): LLMClassifyOutput {
  const trimmed = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed = JSON.parse(trimmed) as unknown;
  return LLMClassifyOutputSchema.parse(parsed);
}

export function tryParseLLMOutput(raw: string): LLMClassifyOutput | null {
  try {
    return parseLLMClassifyOutput(raw);
  } catch {
    return null;
  }
}
