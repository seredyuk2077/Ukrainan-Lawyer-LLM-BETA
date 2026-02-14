/**
 * U4 Routing-hints LLM (Phase 6.1) — budgeted, rare.
 * LLM returns routing hints only: families (from taxonomy or "unknown"), goal decomposition, query variants.
 * No word→family dictionaries; family_key must be from taxonomy categories or "unknown".
 */
import { z } from 'zod';
import { openRouterChat } from '../lib/openrouter.js';
import { config } from '../lib/config.js';
import {
  incrementU4RoutingHintsCalled,
  incrementU4RoutingHintsFailed,
  incrementU4RoutingHintsInvalidJson,
} from '../gateway/observability.js';

const SuggestedGoalSchema = z.object({
  id: z.string().optional(),
  goal_type: z.string(),
  subquery: z.string(),
  required_families: z.array(z.string()).optional(),
  required_categories: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const RoutingHintsOutputSchema = z.object({
  suggested_goals: z.array(SuggestedGoalSchema).max(3).default([]),
  routing: z
    .object({
      families_ranked: z
        .array(z.object({ family_key: z.string(), confidence: z.number().min(0).max(1).optional() }))
        .max(5)
        .default([]),
      negative_families: z.array(z.string()).max(5).optional(),
      negative_terms: z.array(z.string()).max(10).optional(),
    })
    .default({}),
  query_variants: z.array(z.string()).max(3).default([]),
  missing_info_flags: z.array(z.string()).max(5).default([]),
  overall_confidence: z.number().min(0).max(1).default(0.5),
  rationale_short: z.string().max(500).default(''),
});

export type RoutingHintsOutput = z.infer<typeof RoutingHintsOutputSchema>;

export type RoutingHintsInput = {
  original_query: string;
  goals_summary: Array<{ goal_id?: string; required_categories?: string[] }>;
  taxonomy_snapshot_summary: string;
  family_evidence_summary: {
    dominant_family_key?: string;
    family_confidence?: number;
    family_conflict?: boolean;
    top2?: Array<{ family_key: string; support_score: number }>;
  };
  selected_acts_decision_summary: {
    confidence?: number;
    reason_codes?: string[];
  };
  allowed_family_keys: string[];
  max_goals?: number;
};

/** Triggers: call LLM only when at least one is true (no dictionaries). */
export type RoutingHintsTriggers = {
  family_weak_evidence: boolean;
  family_conflict: boolean;
  selected_acts_confidence_below_055: boolean;
  /** v3: confidence < 0.6 for conflict trigger (TRIGGER_STRONG). */
  selected_acts_confidence_below_06?: boolean;
  reason_codes_include_coverage_guard_failed: boolean;
  reason_codes_include_no_strong_act_evidence: boolean;
  query_short_cryptic_high_entropy?: boolean;
  /** v2: dominant family has strong support but selected_acts don't contain that family (evidence-based, no word→family). */
  confident_family_mismatch?: boolean;
  /** v3: single goal for TRIGGER_MEDIUM (optional). */
  goals_count?: number;
};

const CONFIDENT_FAMILY_SUPPORT_THRESHOLD = 0.62;

/** v3: Budget guard ≤25%. TRIGGER_STRONG + TRIGGER_MEDIUM + coverage_guard_failed (single-goal path). */
export function shouldCallRoutingHints(triggers: RoutingHintsTriggers): boolean {
  if (!config.u4RoutingHintsEnabled || !config.openRouterApiKey) return false;
  const strongMismatch = triggers.confident_family_mismatch === true;
  const strongConflict =
    triggers.family_conflict === true && (triggers.selected_acts_confidence_below_06 === true);
  if (strongMismatch || strongConflict) return true;
  const medium =
    triggers.family_weak_evidence === true &&
    (triggers.goals_count ?? 1) === 1 &&
    triggers.selected_acts_confidence_below_055 === true;
  if (medium) return true;
  const coverageWithEvidence =
    triggers.reason_codes_include_coverage_guard_failed === true &&
    (triggers.goals_count ?? 1) === 1 &&
    (triggers.family_weak_evidence === true ||
      triggers.family_conflict === true ||
      triggers.confident_family_mismatch === true);
  return coverageWithEvidence;
}

function mapFamilyKeyToAllowed(key: string, allowed: string[]): string {
  const normalized = key
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();
  if (!normalized) return 'unknown';
  const found = allowed.find((a) => a.normalize('NFC').toLowerCase().replace(/\s+/g, '_') === normalized);
  return found ?? 'unknown';
}

function buildPrompt(input: RoutingHintsInput): string {
  const q = input.original_query.slice(0, 2000).trim();
  const goalsLine =
    input.goals_summary.length > 0
      ? `Поточні цілі (heuristic): ${input.goals_summary.map((g) => g.goal_id ?? '').join(', ')}.`
      : 'Одна ціль (single goal).';
  const familyLine = input.family_evidence_summary.dominant_family_key
    ? `Dominant family: ${input.family_evidence_summary.dominant_family_key}, confidence: ${input.family_evidence_summary.family_confidence ?? 0}. Conflict: ${input.family_evidence_summary.family_conflict ?? false}.`
    : 'Family evidence weak or absent.';
  const decisionLine = `Selected acts confidence: ${input.selected_acts_decision_summary.confidence ?? 0}. Reason codes: ${(input.selected_acts_decision_summary.reason_codes ?? []).join(', ') || 'none'}.`;
  const allowedLine = `Дозволені family_key (тільки з цього списку, або "unknown"): ${input.allowed_family_keys.slice(0, 25).join(', ')}.`;

  return `Ти — асистент маршрутизації пошуку в законодавстві. Запит користувача і контекст нижче. Поверни один JSON об'єкт без markdown.

Поля виходу (всі опційні, можна порожні масиви):
- suggested_goals: масив до ${input.max_goals ?? 3} об'єктів { goal_type, subquery, required_families?: string[], required_categories?: string[], confidence?: 0-1 }. required_families/required_categories — тільки значення з дозволеного списку або "unknown".
- routing: { families_ranked: [{ family_key: string, confidence?: 0-1 }] до 5 елементів, negative_families?: string[], negative_terms?: string[] }. family_key — тільки з дозволеного списку або "unknown".
- query_variants: до 3 переформулювань запиту (короткі).
- missing_info_flags: до 5 рядків (що не вистачає для точної відповіді).
- overall_confidence: число 0-1.
- rationale_short: 1-2 речення (макс 500 символів).

${allowedLine}

Запит: ${q}
${goalsLine}
${familyLine}
${decisionLine}

Taxonomy snapshot (top categories/families): ${input.taxonomy_snapshot_summary.slice(0, 800)}

Return ONLY valid JSON. No markdown. No text. No comments. Schema: { suggested_goals?: [], routing?: { families_ranked?: [{ family_key, confidence? }], ... }, query_variants?: [], missing_info_flags?: [], overall_confidence?: 0-1, rationale_short?: "" }.`;
}

const RETRY_SYSTEM =
  'Your previous output was invalid JSON. Return ONLY valid JSON matching the schema. No extra keys. No markdown.';

/** Best-effort: strip markdown/backticks, extract first { ... last }. */
function extractJsonBestEffort(trimmed: string): { jsonStr: string; parse_mode: 'strict' | 'extract' } {
  let s = trimmed;
  const backtickMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (backtickMatch) {
    s = backtickMatch[1].trim();
  }
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace === 0 && lastBrace === s.length - 1) {
    return { jsonStr: s, parse_mode: 'strict' };
  }
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return { jsonStr: s.slice(firstBrace, lastBrace + 1), parse_mode: 'extract' };
  }
  return { jsonStr: s, parse_mode: 'extract' };
}

export type RoutingHintsCallResult = {
  output: RoutingHintsOutput | null;
  called: boolean;
  call_failed_reason?: string;
  model_id?: string;
  duration_ms?: number;
  tokens_approx?: number;
  /** Phase 2: 1 or 2 when retry was used */
  attempts?: number;
  /** Phase 2: "strict" when content was already JSON-like, "extract" when best-effort extraction was used */
  parse_mode?: 'strict' | 'extract';
};

async function doOneCall(
  input: RoutingHintsInput,
  messages: Array<{ role: 'system' | 'user'; content: string }>
): Promise<{
  content: string;
  model_id?: string;
  parse_mode: 'strict' | 'extract';
  parseError?: boolean;
  schemaError?: boolean;
  output?: z.infer<typeof RoutingHintsOutputSchema>;
}> {
  const res = await openRouterChat(
    config.openRouterApiKey!,
    {
      model: config.u4RoutingHintsModel,
      messages,
      temperature: 0.1,
      max_tokens: config.u4RoutingHintsMaxTokens,
    },
    config.u4RoutingHintsTimeoutSec
  );
  const trimmed = (res.content ?? '').trim();
  const { jsonStr, parse_mode } = extractJsonBestEffort(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { content: res.content ?? '', model_id: res.model_id, parse_mode, parseError: true };
  }
  const validated = RoutingHintsOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return { content: res.content ?? '', model_id: res.model_id, parse_mode, schemaError: true };
  }
  return { content: res.content ?? '', model_id: res.model_id, parse_mode, output: validated.data };
}

export async function callRoutingHints(input: RoutingHintsInput): Promise<RoutingHintsCallResult> {
  if (!config.u4RoutingHintsEnabled || !config.openRouterApiKey) {
    return { output: null, called: false };
  }

  const started = Date.now();
  incrementU4RoutingHintsCalled();

  try {
    const prompt = buildPrompt(input);
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: 'Return ONLY valid JSON. No markdown. No text. No comments.' },
      { role: 'user', content: prompt },
    ];

    let result = await doOneCall(input, messages);
    let attempts: number = 1;
    if (result.parseError || result.schemaError) {
      messages.push({ role: 'assistant', content: result.content });
      messages.push({ role: 'user', content: RETRY_SYSTEM });
      result = await doOneCall(input, messages);
      attempts = 2;
    }

    if (result.parseError) {
      incrementU4RoutingHintsFailed();
      incrementU4RoutingHintsInvalidJson();
      return {
        output: null,
        called: true,
        call_failed_reason: 'INVALID_JSON_PARSE',
        model_id: result.model_id,
        duration_ms: Date.now() - started,
        attempts,
        parse_mode: result.parse_mode,
      };
    }
    if (result.schemaError) {
      incrementU4RoutingHintsFailed();
      incrementU4RoutingHintsInvalidJson();
      return {
        output: null,
        called: true,
        call_failed_reason: 'INVALID_JSON_SCHEMA',
        model_id: result.model_id,
        duration_ms: Date.now() - started,
        attempts,
        parse_mode: result.parse_mode,
      };
    }

    const output = result.output!;
    const allowed = input.allowed_family_keys;

    const mappedRouting = {
      ...output.routing,
      families_ranked: (output.routing.families_ranked ?? []).map((f) => ({
        family_key: mapFamilyKeyToAllowed(f.family_key, allowed),
        confidence: f.confidence ?? 0.5,
      })),
      negative_families: (output.routing.negative_families ?? []).map((k) => mapFamilyKeyToAllowed(k, allowed)),
    };

    const mappedGoals = (output.suggested_goals ?? []).map((g) => ({
      ...g,
      required_families: (g.required_families ?? []).map((k) => mapFamilyKeyToAllowed(k, allowed)),
      required_categories: (g.required_categories ?? []).map((k) => mapFamilyKeyToAllowed(k, allowed)),
    }));

    const mappedOutput: RoutingHintsOutput = {
      ...output,
      routing: mappedRouting,
      suggested_goals: mappedGoals,
    };

    const duration_ms = Date.now() - started;
    const tokens_approx = Math.min(config.u4RoutingHintsMaxTokens, (result.content?.length ?? 0) / 4 + 100);

    return {
      output: mappedOutput,
      called: true,
      model_id: result.model_id,
      duration_ms,
      tokens_approx,
      attempts,
      parse_mode: result.parse_mode,
    };
  } catch (err) {
    incrementU4RoutingHintsFailed();
    const duration_ms = Date.now() - started;
    const reason = err instanceof Error ? err.message : 'CALL_FAILED';
    const isTimeout = /timeout|ETIMEDOUT/i.test(reason);
    return {
      output: null,
      called: true,
      call_failed_reason: isTimeout ? 'TIMEOUT' : reason.slice(0, 64),
      duration_ms,
    };
  }
}
