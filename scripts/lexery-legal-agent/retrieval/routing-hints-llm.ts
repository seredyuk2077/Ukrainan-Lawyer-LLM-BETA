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
  incrementU4RoutingHintsUsed,
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
  reason_codes_include_coverage_guard_failed: boolean;
  reason_codes_include_no_strong_act_evidence: boolean;
  query_short_cryptic_high_entropy?: boolean;
};

export function shouldCallRoutingHints(triggers: RoutingHintsTriggers): boolean {
  if (!config.u4RoutingHintsEnabled || !config.openRouterApiKey) return false;
  return (
    triggers.family_weak_evidence ||
    triggers.family_conflict ||
    triggers.selected_acts_confidence_below_055 ||
    triggers.reason_codes_include_coverage_guard_failed ||
    triggers.reason_codes_include_no_strong_act_evidence ||
    (triggers.query_short_cryptic_high_entropy ?? false)
  );
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

Поверни лише JSON об'єкт.`;
}

export type RoutingHintsCallResult = {
  output: RoutingHintsOutput | null;
  called: boolean;
  call_failed_reason?: string;
  model_id?: string;
  duration_ms?: number;
  tokens_approx?: number;
};

export async function callRoutingHints(input: RoutingHintsInput): Promise<RoutingHintsCallResult> {
  if (!config.u4RoutingHintsEnabled || !config.openRouterApiKey) {
    return { output: null, called: false };
  }

  const started = Date.now();
  incrementU4RoutingHintsCalled();

  try {
    const prompt = buildPrompt(input);
    const res = await openRouterChat(
      config.openRouterApiKey,
      {
        model: config.u4RoutingHintsModel,
        messages: [
          { role: 'system', content: 'Ти повертаєш лише один JSON об\'єкт без markdown та без коментарів.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: config.u4RoutingHintsMaxTokens,
      },
      config.u4RoutingHintsTimeoutSec
    );

    const duration_ms = Date.now() - started;
    const trimmed = res.content.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      incrementU4RoutingHintsFailed();
      return {
        output: null,
        called: true,
        call_failed_reason: 'INVALID_JSON',
        model_id: res.model_id,
        duration_ms,
      };
    }

    const validated = RoutingHintsOutputSchema.safeParse(parsed);
    if (!validated.success) {
      incrementU4RoutingHintsFailed();
      return {
        output: null,
        called: true,
        call_failed_reason: 'VALIDATION_FAILED',
        model_id: res.model_id,
        duration_ms,
      };
    }

    const output = validated.data;
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

    incrementU4RoutingHintsUsed();
    const tokens_approx = Math.min(config.u4RoutingHintsMaxTokens, (res.content?.length ?? 0) / 4 + 100);

    return {
      output: mappedOutput,
      called: true,
      model_id: res.model_id,
      duration_ms,
      tokens_approx,
    };
  } catch (err) {
    incrementU4RoutingHintsFailed();
    const duration_ms = Date.now() - started;
    const reason = err instanceof Error ? err.message : 'CALL_FAILED';
    return {
      output: null,
      called: true,
      call_failed_reason: reason.slice(0, 64),
      duration_ms,
    };
  }
}
