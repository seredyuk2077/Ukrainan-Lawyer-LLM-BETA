/**
 * U4 Always-on Query Rewriter (Phase 7) — budgeted, every run.
 * Enriches short/raw queries for retrieval; no word→act dictionaries; output strictly from LLDBI vocabulary.
 */
import { z } from 'zod';
import { openRouterChat } from '../lib/openrouter.js';
import { config } from '../lib/config.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';
import {
  incrementU4QueryRewriteCalled,
  incrementU4QueryRewriteFailed,
} from '../gateway/observability.js';
import type { LldbiVocabularyResult } from './lldbi-vocabulary.js';

const RUN_CONTEXT_KEY = 'u4_query_rewrite_result';
const RUN_CONTEXT_TTL_SEC = 3600;

const QueryRewriteOutputSchema = z.object({
  rewritten_query: z.string().min(1).max(2000),
  query_variants: z.array(z.string().max(500)).max(3).default([]),
  negative_terms: z.array(z.string().max(100)).max(6).default([]),
  categories_ranked_top3: z.array(z.string()).max(3).default([]),
  document_types_ranked_top3: z.array(z.string()).max(3).default([]),
  overall_confidence: z.number().min(0).max(1).default(0.5),
  missing_info_flags: z.array(z.string().max(100)).max(8).default([]),
  rationale_short: z.string().max(500).default(''),
});

export type QueryRewriteOutput = z.infer<typeof QueryRewriteOutputSchema>;

export type QueryRewriteInput = {
  original_query: string;
  goals_summary: Array<{ goal_id?: string; subquery?: string }>;
  domainHint?: string;
  lldbi?: {
    categories_ranked_top3?: string[];
    document_types_ranked_top3?: string[];
  } | null;
  taxonomy_snapshot_summary: string;
  lldbi_vocabulary: LldbiVocabularyResult;
  run_id?: string;
};

function filterToVocabulary(values: string[], allowlist: string[]): string[] {
  if (allowlist.length === 0) return [];
  const set = new Set(allowlist.map((s) => s.trim().toLowerCase()));
  return values.filter((v) => v && set.has(v.trim().toLowerCase()));
}

function buildPrompt(input: QueryRewriteInput): string {
  const q = input.original_query.slice(0, 2000).trim();
  const goalsLine =
    input.goals_summary.length > 0
      ? `Цілі (subquery): ${input.goals_summary.map((g) => (g.subquery ?? g.goal_id ?? '').slice(0, 120)).join('; ')}.`
      : 'Одна ціль.';
  const domainLine = input.domainHint ? `Domain hint: ${input.domainHint}.` : 'Domain hint не задано.';
  const lldbiLine =
    input.lldbi?.categories_ranked_top3?.length || input.lldbi?.document_types_ranked_top3?.length
      ? `LLDBI: categories_top3=${(input.lldbi.categories_ranked_top3 ?? []).join(', ')}, doc_types_top3=${(input.lldbi.document_types_ranked_top3 ?? []).join(', ')}.`
      : 'LLDBI hints порожні.';
  const allowedCategories = input.lldbi_vocabulary.categories.slice(0, 40).join(', ');
  const allowedDocTypes = input.lldbi_vocabulary.documentTypes.slice(0, 30).join(', ');

  return `Ти — асистент переформулювання запиту для пошуку в українському законодавстві. Запит користувача короткий або сирий, або довгий, детальний, або просто посилається на документ. Твоя задача: уточнити юридичну постановку (визначення, відповідальність, підслідність, порядок, строки і тд), додати нейтральні anchor-терміни (без назв конкретних актів), підсилити category/document_type hints узгоджено з vocabulary. Критично: додай синоніми та доменні еквіваленти (наприклад різні назви одного поняття: пальне ↔ нафтопродукт, бензин; АЗС ↔ автозаправна станція; мобілізація ↔ призов тощо), щоб покращити семантичний пошук — у rewritten_query або у query_variants. НЕ нав'язуй конкретний акт (rada_nreg). Поверни один JSON об'єкт без markdown.
ВАЖЛИВО: якщо запит містить явні посилання на статті закону (наприклад "ст. 121 КК України", "ст. 119 КК"), принаймні один з query_variants повинен описувати ЗМІСТ цієї статті (склад правопорушення, диспозицію, санкцію, елементи складу злочину) — а НЕ лише повторювати процесуальні обставини. Це критично для семантичного пошуку чанків матеріального права: "апеляційна скарга" знаходить КПК, а "умисне тяжке тілесне ушкодження що спричинило смерть" знаходить ккУ.

Поля виходу (обов'язково rewritten_query, решта опційно):
- rewritten_query: один рядок, збагачений запит для embedding/search (без фантазій), включаючи синоніми/еквіваленти де потрібно.
- query_variants: до 3 варіантів з альтернативними формулюваннями та синонімами (інші назви тих самих понять).
- negative_terms: до 6 слів/фраз, щоб прибирати загальний шум з пошуку.
- categories_ranked_top3: до 3 категорій ТІЛЬКИ з дозволеного списку нижче (якщо не впевнений — порожній масив).
- document_types_ranked_top3: до 3 типів документів ТІЛЬКИ з дозволеного списку нижче (якщо не впевнений — порожній масив).
- overall_confidence: 0-1 (низький для out-of-domain / космос, NASA тощо).
- missing_info_flags: до 8 рядків (що не вистачає; для out-of-domain можна "out_of_scope", "NO_STRONG_ACT_EVIDENCE").
- rationale_short: 1-2 речення (макс 500 символів).

Дозволені categories (тільки з цього списку): ${allowedCategories}
Дозволені document_types (тільки з цього списку): ${allowedDocTypes}

Запит: ${q}
${goalsLine}
${domainLine}
${lldbiLine}

Taxonomy snapshot: ${input.taxonomy_snapshot_summary.slice(0, 600)}

Return ONLY valid JSON. No markdown. No text. No comments.`;
}

const RETRY_SYSTEM =
  'Your previous output was invalid JSON. Return ONLY valid JSON matching the schema. No extra keys. No markdown.';

function extractJsonBestEffort(trimmed: string): { jsonStr: string; parse_mode: 'strict' | 'extract' } {
  let s = trimmed;
  const backtickMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (backtickMatch) s = backtickMatch[1].trim();
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace === 0 && lastBrace === s.length - 1) return { jsonStr: s, parse_mode: 'strict' };
  if (firstBrace >= 0 && lastBrace > firstBrace) return { jsonStr: s.slice(firstBrace, lastBrace + 1), parse_mode: 'extract' };
  return { jsonStr: s, parse_mode: 'extract' };
}

async function doOneCall(
  input: QueryRewriteInput,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
): Promise<{
  content: string;
  model_id?: string;
  parse_mode: 'strict' | 'extract';
  parseError?: boolean;
  schemaError?: boolean;
  output?: z.infer<typeof QueryRewriteOutputSchema>;
}> {
  const res = await openRouterChat(
    config.openRouterApiKey!,
    {
      model: config.u4QueryRewriteModel,
      messages,
      temperature: 0.1,
      max_tokens: config.u4QueryRewriteMaxTokens,
      caller: 'u4-query-rewrite',
    },
    config.u4QueryRewriteTimeoutSec
  );
  const trimmed = (res.content ?? '').trim();
  const { jsonStr, parse_mode } = extractJsonBestEffort(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { content: res.content ?? '', model_id: res.model_id, parse_mode, parseError: true };
  }
  const validated = QueryRewriteOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return { content: res.content ?? '', model_id: res.model_id, parse_mode, schemaError: true };
  }
  return { content: res.content ?? '', model_id: res.model_id, parse_mode, output: validated.data };
}

export type QueryRewriteCallResult = {
  output: QueryRewriteOutput | null;
  called: boolean;
  call_failed_reason?: string;
  model_id?: string;
  duration_ms?: number;
  attempts?: number;
  parse_mode?: 'strict' | 'extract';
};

export async function callQueryRewriter(input: QueryRewriteInput): Promise<QueryRewriteCallResult> {
  if (!config.u4QueryRewriteEnabled || !config.openRouterApiKey) {
    return { output: null, called: false };
  }

  const started = Date.now();
  incrementU4QueryRewriteCalled();

  const vocabulary = input.lldbi_vocabulary;
  const allowedCategories = vocabulary.categories;
  const allowedDocTypes = vocabulary.documentTypes;

  if (input.run_id) {
    const ctx = (await runContextGet<{ [RUN_CONTEXT_KEY]?: z.infer<typeof QueryRewriteOutputSchema> }>(input.run_id)) ?? null;
    const cached = ctx?.[RUN_CONTEXT_KEY];
    if (cached && typeof cached.rewritten_query === 'string' && cached.rewritten_query.length > 0) {
      const filtered: QueryRewriteOutput = {
        ...cached,
        categories_ranked_top3: filterToVocabulary(cached.categories_ranked_top3 ?? [], allowedCategories),
        document_types_ranked_top3: filterToVocabulary(cached.document_types_ranked_top3 ?? [], allowedDocTypes),
      };
      return {
        output: filtered,
        called: true,
        model_id: undefined,
        duration_ms: Date.now() - started,
        attempts: 0,
        parse_mode: 'strict',
      };
    }
  }

  try {
    const prompt = buildPrompt(input);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: 'Return ONLY valid JSON. No markdown. No text. No comments.' },
      { role: 'user', content: prompt },
    ];

    let result = await doOneCall(input, messages);
    let attempts = 1;
    if (result.parseError || result.schemaError) {
      messages.push({ role: 'assistant', content: result.content });
      messages.push({ role: 'user', content: RETRY_SYSTEM });
      result = await doOneCall(input, messages);
      attempts = 2;
    }

    if (result.parseError) {
      incrementU4QueryRewriteFailed();
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
      incrementU4QueryRewriteFailed();
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
    const filtered: QueryRewriteOutput = {
      ...output,
      categories_ranked_top3: filterToVocabulary(output.categories_ranked_top3, allowedCategories),
      document_types_ranked_top3: filterToVocabulary(output.document_types_ranked_top3, allowedDocTypes),
    };

    if (input.run_id) {
      const merged = (await runContextGet<Record<string, unknown>>(input.run_id)) ?? {};
      await runContextSet(input.run_id, { ...merged, [RUN_CONTEXT_KEY]: filtered } as Record<string, unknown>, RUN_CONTEXT_TTL_SEC);
    }

    return {
      output: filtered,
      called: true,
      model_id: result.model_id,
      duration_ms: Date.now() - started,
      attempts,
      parse_mode: result.parse_mode,
    };
  } catch (err) {
    incrementU4QueryRewriteFailed();
    const reason = err instanceof Error ? err.message : 'CALL_FAILED';
    const isTimeout = /timeout|ETIMEDOUT/i.test(reason);
    return {
      output: null,
      called: true,
      call_failed_reason: isTimeout ? 'TIMEOUT' : reason.slice(0, 64),
      duration_ms: Date.now() - started,
    };
  }
}
