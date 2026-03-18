/**
 * U4 Act Retrieval Planner — LLM-first act routing (budgeted, tiered).
 * Chooses act families / act candidates per goal from taxonomy snapshot; does NOT invent acts.
 */
import { z } from 'zod';
import { openRouterChat } from '../lib/openrouter.js';
import { config } from '../lib/config.js';
import type { EvidenceGoal } from './goals.js';

const ActFamilySchema = z.object({
  family: z.string(),
  confidence: z.number().min(0).max(1),
  rationale_short: z.string().max(120).optional(),
});

const ActCandidateSchema = z.object({
  rada_nreg: z.string().optional(),
  title_hint: z.string().max(200).optional(),
  family: z.string().optional(),
  confidence: z.number().min(0).max(1),
  rationale_short: z.string().max(120).optional(),
});

const GoalPlanSchema = z.object({
  goal_id: z.string(),
  goal_text: z.string(),
  act_families: z.array(ActFamilySchema).max(5).default([]),
  act_candidates: z.array(ActCandidateSchema).max(8).default([]),
  query_variants: z.array(z.string().max(500)).max(2).default([]),
  negative_terms: z.array(z.string().max(100)).max(3).default([]),
});

const GlobalPlanSchema = z.object({
  overall_confidence: z.number().min(0).max(1),
  missing_info_flags: z.array(z.string().max(80)).max(5).default([]),
});

export const ActPlannerOutputSchema = z.object({
  goals: z.array(GoalPlanSchema),
  global: GlobalPlanSchema,
});

export type ActPlannerOutput = z.infer<typeof ActPlannerOutputSchema>;
export type ActPlannerGoalPlan = z.infer<typeof GoalPlanSchema>;

export interface TaxonomySnapshotSummary {
  top_aliases: string[];
  top_categories: string[];
  acts: Array<{ rada_nreg: string; title: string; category?: string | null }>;
}

export interface ActPlannerInput {
  query: string;
  goals: EvidenceGoal[];
  domainHint?: string;
  taxonomy_snapshot_summary: TaxonomySnapshotSummary;
  max_acts_total: number;
  max_acts_per_goal: number;
  allow_multi_act: boolean;
  /** Tier 1 = shorter prompt/tokens, tier 2 = full */
  tier: 1 | 2;
}

function buildPrompt(input: ActPlannerInput): string {
  const { query, goals, domainHint, taxonomy_snapshot_summary, max_acts_per_goal, allow_multi_act, tier } = input;
  const q = query.slice(0, 2000).trim();
  const domainLine = domainHint ? `Домен із запиту: ${domainHint}.` : '';
  const actsList =
    taxonomy_snapshot_summary.acts.length > 0
      ? taxonomy_snapshot_summary.acts
          .slice(0, 25)
          .map((a) => `  - ${a.rada_nreg}: ${(a.title ?? '').slice(0, 80)} (${a.category ?? '?'})`)
          .join('\n')
      : '  (немає актів з taxonomy — використовуй лише act_families)';
  const aliasesLine =
    taxonomy_snapshot_summary.top_aliases.length > 0
      ? `Аліаси/ключові слова: ${taxonomy_snapshot_summary.top_aliases.slice(0, 15).join(', ')}.`
      : '';
  const goalsJson = goals.map((g) => ({ goal_id: g.id, goal_text: g.subquery.slice(0, 400), domain_hint: g.domain_hint }));

  return `Ти — планувальник вибору актів для пошуку доказів у законодавстві. Твоя задача: для кожної цілі (goal) визначити, які АКТИ або СІМ'Ї АКТІВ потрібні для відповіді. Ти НЕ вигадуєш акти — обираєш лише з наведеного списку або вказуєш сім'ю (criminal, criminal_procedure, civil, civil_procedure, administrative_offenses, tax_customs, labor_social, constitutional, anti_corruption, finance_banking тощо).

Запит користувача:
${q}
${domainLine}
${aliasesLine}

Доступні акти (rada_nreg, title, category):
${actsList}

Цілі пошуку (goals):
${JSON.stringify(goalsJson, null, 2)}

Правила:
- Для кожної цілі вкажи act_families (1–3 сімей) та/або act_candidates (обирай rada_nreg з списку вище).
- Якщо відповідного акту немає в списку — вкажи лише act_families та confidence < 0.7.
- query_variants: 0–2 альтернативні формулювання для пошуку (коротко).
- negative_terms: 0–3 терміни, які знижують релевантність.
- global.overall_confidence: 0–1; missing_info_flags — що не вистачає для впевченості.
- max act_candidates на ціль: ${max_acts_per_goal}. allow_multi_act: ${allow_multi_act}.

Поверни один JSON об'єкт без markdown:
{"goals":[{"goal_id":"goal_0","goal_text":"...","act_families":[{"family":"criminal","confidence":0.9,"rationale_short":"..."}],"act_candidates":[{"rada_nreg":"...","family":"criminal","confidence":0.85,"rationale_short":"..."}],"query_variants":[],"negative_terms":[]}],"global":{"overall_confidence":0.8,"missing_info_flags":[]}}`;
}

export type ActPlannerTier = 0 | 1 | 2;

export interface ActPlannerTierInput {
  goalsCount: number;
  taxonomyActCount: number;
  aliasHitCount: number;
  categoryHintCount: number;
  documentTypeHintCount: number;
  queryLength: number;
  hasContractLikeFlag: boolean;
}

/**
 * Decide act planner tier from goal split and cheap signals (no LLM).
 * tier 0: no call; tier 1: single-goal only when taxonomy/hints are genuinely weak; tier 2: multi-goal.
 */
export function selectActPlannerTier(input: ActPlannerTierInput): ActPlannerTier {
  const {
    goalsCount,
    taxonomyActCount,
    aliasHitCount,
    categoryHintCount,
    documentTypeHintCount,
    queryLength,
    hasContractLikeFlag,
  } = input;
  if (!config.u4ActPlannerEnabled) return 0;
  if (goalsCount > 1) return 2;
  if (hasContractLikeFlag) return 1;
  const hasTaxonomySignal =
    taxonomyActCount > 0 ||
    aliasHitCount > 0 ||
    categoryHintCount > 0 ||
    documentTypeHintCount > 0;
  if (!hasTaxonomySignal) return 1;
  const isUltraShort = queryLength < 12;
  const weakSingleSignal =
    taxonomyActCount <= 1 &&
    aliasHitCount === 0 &&
    categoryHintCount === 0 &&
    documentTypeHintCount === 0;
  if (isUltraShort && weakSingleSignal) return 1;
  return 0;
}

export async function callActPlanner(input: ActPlannerInput): Promise<ActPlannerOutput> {
  const prompt = buildPrompt(input);
  const tier = input.tier;
  const maxTokens = tier === 1 ? config.u4ActPlannerMaxTokensTier1 : config.u4ActPlannerMaxTokensTier2;
  const started = Date.now();

  const res = await openRouterChat(
    config.openRouterApiKey,
    {
      model: config.u4ActPlannerModel,
      messages: [
        { role: 'system', content: 'Ти повертаєш лише один JSON об\'єкт без markdown та без коментарів.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      caller: 'u4-act-planner',
    },
    config.u4ActPlannerTimeoutSec
  );

  const jsonMatch = res.content.trim().match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : res.content.trim();
  const parsed = JSON.parse(jsonStr) as unknown;
  const out = ActPlannerOutputSchema.parse(parsed);
  return out;
}
