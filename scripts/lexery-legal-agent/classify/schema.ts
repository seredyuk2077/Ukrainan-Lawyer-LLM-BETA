/**
 * Zod schema for U2 LLM classifier JSON output (strict validation).
 */
import { z } from 'zod';
import { extractFirstJsonObject } from '../lib/jsonExtract.js';

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
    .nullable()
    .optional(),
});

export const AmbiguitySchema = z.object({
  is_ambiguous: z.boolean(),
  reasons: z.array(z.string()),
  ambig_terms: z.array(z.string()).optional(),
});

export const ContextModeEnum = z.enum(['law', 'memory', 'mixed']);
/** Accepts nullable from provider; normalizes to safe booleans and optional context_mode. */
export const RoutingFlagsSchema = z
  .object({
    need_deep_retrieval: z.boolean().nullable().optional(),
    need_web: z.boolean().nullable().optional(),
    ambiguous: z.boolean().nullable().optional(),
    context_mode: ContextModeEnum.nullable().optional(),
  })
  .transform((r) => ({
    need_deep_retrieval: r.need_deep_retrieval ?? false,
    need_web: r.need_web ?? false,
    ambiguous: r.ambiguous ?? false,
    context_mode: r.context_mode ?? undefined,
  }));

export const LLMClassifyOutputSchema = z.object({
  intent: IntentEnum,
  domain: DomainEnum,
  entities: z.array(ExtractedEntitySchema),
  ambiguity: AmbiguitySchema,
  routing_flags: RoutingFlagsSchema.optional(),
});

export type LLMClassifyOutput = z.infer<typeof LLMClassifyOutputSchema>;

function normalizeRawForJson(s: string): string {
  return s.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

export function parseLLMClassifyOutput(raw: string): LLMClassifyOutput {
  const jsonStr = extractFirstJsonObject(raw);
  const candidate = jsonStr || normalizeRawForJson(raw);
  if (!candidate) throw new Error('No JSON object found in classifier output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`U2 classifier JSON.parse failed: ${msg}`);
  }
  try {
    return LLMClassifyOutputSchema.parse(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`U2 classifier schema validation failed: ${msg}`);
  }
}

export function tryParseLLMOutput(raw: string): LLMClassifyOutput | null {
  return tryParseLLMOutputWithReason(raw).parsed;
}

export function tryParseLLMOutputWithReason(
  raw: string
): { parsed: LLMClassifyOutput | null; reason?: string } {
  try {
    return { parsed: parseLLMClassifyOutput(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { parsed: null, reason: msg.slice(0, 240) };
  }
}
