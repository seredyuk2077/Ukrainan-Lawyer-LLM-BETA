/**
 * U4 Selective LLM Retrieval Planner — only when triggers (multi-goal, contract-like, etc.).
 * Returns JSON goals (goal_type, subquery, domain_hint, likely_acts, keywords, why). No article names.
 * Uses OpenRouter, small max_tokens, timeout; guardrails via semaphore + circuit breaker (U2).
 */
import type { EvidenceGoal, EvidenceGoalType } from './goals.js';
import { openRouterChat } from '../lib/openrouter.js';
import { config } from '../lib/config.js';

const GOAL_TYPES: EvidenceGoalType[] = [
  'definition',
  'liability',
  'procedure',
  'compliance_check',
  'reference_resolution',
];

const DOMAIN_HINTS =
  'Можливі домени/категорії: criminal, criminal_procedure, tax_customs, admin, civil, labor, compliance (не обов’язково з цього списку).';

export interface LlmPlannerInput {
  query: string;
  domainHint?: string;
  /** Truncate query for prompt to avoid token overflow */
  maxQueryChars?: number;
  /** Override max_tokens for tier 1 (cheap) vs tier 2 (full) */
  maxTokens?: number;
}

export interface LlmPlannerGoal {
  goal_type: string;
  subquery: string;
  domain_hint?: string;
  likely_acts?: string[];
  keywords?: string[];
  why?: string;
}

export interface LlmPlannerResult {
  goals: EvidenceGoal[];
  model_id: string;
  duration_ms: number;
  degraded?: boolean;
  reason_codes?: string[];
}

function buildPrompt(query: string, domainHint?: string): string {
  const q = query.slice(0, 3000).trim();
  const domainLine = domainHint ? `Домен із запиту: ${domainHint}.` : '';
  return `Ти — планувальник пошуку доказів у законодавстві. Розбий запит на 1–3 цілі пошуку (evidence goals). Для кожної цілі вкажи goal_type, subquery, domain_hint (опційно), likely_acts (аліаси/назви актів, не номери статей), keywords (опційно), why (коротко).

Типи цілей: ${GOAL_TYPES.join(', ')}.
${DOMAIN_HINTS}

Запит:
${q}
${domainLine}

Поверни один JSON об'єкт з полем "goals" — масив об'єктів з полями: goal_type, subquery, domain_hint (опційно), likely_acts (масив рядків, опційно), keywords (опційно), why (опційно). НЕ вказуй номери статей. Приклад:
{"goals":[{"goal_type":"definition","subquery":"що таке шахрайство","domain_hint":"criminal","keywords":["шахрайство","злочин"],"why":"визначення злочину"},{"goal_type":"procedure","subquery":"підслідність статті про шахрайство","domain_hint":"criminal_procedure","likely_acts":["КПК"],"why":"процесуальна юрисдикція"}]}`;
}

function parseGoalsFromContent(content: string): EvidenceGoal[] {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
  let parsed: { goals?: LlmPlannerGoal[] };
  try {
    parsed = JSON.parse(jsonStr) as { goals?: LlmPlannerGoal[] };
  } catch {
    throw new Error('LLM planner: invalid JSON');
  }
  const raw = Array.isArray(parsed.goals) ? parsed.goals : [];
  const goals: EvidenceGoal[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(raw.length, config.u4GoalsMax); i++) {
    const g = raw[i];
    if (!g || typeof g.subquery !== 'string' || g.subquery.length < 2) continue;
    const goalType = GOAL_TYPES.includes(g.goal_type as EvidenceGoalType)
      ? (g.goal_type as EvidenceGoalType)
      : 'definition';
    const id = `goal_${i}`;
    if (seen.has(id)) continue;
    seen.add(id);
    goals.push({
      id,
      goal_type: goalType,
      subquery: String(g.subquery).slice(0, 4000),
      domain_hint: typeof g.domain_hint === 'string' ? g.domain_hint : undefined,
      required_categories: Array.isArray(g.likely_acts) ? g.likely_acts.slice(0, 10) : undefined,
    });
  }
  if (goals.length === 0) throw new Error('LLM planner: no valid goals');
  return goals;
}

export async function callLlmRetrievalPlanner(input: LlmPlannerInput): Promise<LlmPlannerResult> {
  const { query, domainHint, maxQueryChars = 3000, maxTokens } = input;
  const prompt = buildPrompt(query.slice(0, maxQueryChars), domainHint);
  const started = Date.now();
  const reasonCodes: string[] = [];
  const effectiveMaxTokens = maxTokens ?? config.u4PlannerMaxTokens;

  try {
    const res = await openRouterChat(
      config.openRouterApiKey,
      {
        model: config.u4PlannerModelId,
        messages: [
          { role: 'system', content: 'Ти повертаєш лише один JSON об\'єкт без markdown та без коментарів.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: effectiveMaxTokens,
        caller: 'u4-llm-planner',
      },
      config.u4PlannerTimeoutSec
    );
    const duration_ms = Date.now() - started;
    const goals = parseGoalsFromContent(res.content);
    return {
      goals,
      model_id: res.model_id,
      duration_ms,
      reason_codes: reasonCodes.length ? reasonCodes : undefined,
    };
  } catch (err) {
    const duration_ms = Date.now() - started;
    if (err instanceof Error) reasonCodes.push(err.message.slice(0, 100));
    throw err;
  }
}
