#!/usr/bin/env node
/**
 * Real MM isolation verifier.
 *
 * Goals:
 * - Run concurrent real-AI conversations with large texts.
 * - Verify memory stays isolated across:
 *   1. same user, different chats
 *   2. different users, same tenant
 *   3. same user id, different tenant
 * - Verify worker materialization, summaries, and law-only cleanliness.
 * - Verify direct MM retrieval (`fetchRecentMemory`) never leaks foreign conversation/user/tenant data.
 *
 * Run:
 *   MM_OUTBOX_WORKER_ENABLED=true pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_isolation_real.ts
 */
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { shouldRetryRunPollFailure } from './verify_memory_e2e.js';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

process.env.LEGAL_AGENT_MODEL_ID ??= process.env.MM_TEST_MODEL_ID || 'openai/gpt-4o-mini';
process.env.PROMPT_COMPOSER_MODEL_COMPLEX_ID ??= process.env.LEGAL_AGENT_MODEL_ID;
process.env.PROMPT_COMPOSER_MODEL_SIMPLE_ID ??= 'openai/gpt-5-nano';

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
if (!process.env.DEV_API_KEY) process.env.DEV_API_KEY = DEV_KEY;
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';
if (process.env.MM_OUTBOX_WORKER_ENABLED === undefined) process.env.MM_OUTBOX_WORKER_ENABLED = 'true';
if (process.env.REDIS_QUEUE_NAMESPACE === undefined) {
  process.env.REDIS_QUEUE_NAMESPACE = `lexery:verify:mm-isolation:${randomUUID()}`;
}

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-000000000011';
const USER_A = '00000000-0000-0000-0000-000000000002';
const USER_B = '00000000-0000-0000-0000-000000000003';

const POLL_INTERVAL_MS = 1000;
const RUN_TIMEOUT_MS = 120_000;
const OUTBOX_POLL_INTERVAL_MS = 2500;
const OUTBOX_TIMEOUT_MS = 180_000;
const MATERIALIZATION_SETTLE_MS = 6500;

type ScenarioFacts = {
  codeword: string;
  color: string;
  dog: string;
  city: string;
  budget: string;
};

type Scenario = {
  name: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  facts: ScenarioFacts;
};

type TurnMetrics = {
  runId: string;
  status: string;
  memoryCount: number | null;
  lawCount: number | null;
  promptTokens: number | null;
  contextMode: string | null;
  useMemory: boolean | null;
  answerText: string;
};

type ScenarioResult = {
  scenario: Scenario;
  recallTurn: TurnMetrics;
  lawTurn: TurnMetrics;
  outboxDone: number;
  outboxFailed: number;
  outboxPending: number;
  outboxProcessing: number;
  memoryItemsCount: number;
  hasSummary: boolean;
  summaryText: string;
  directOwnFetchOk: boolean;
  directIsolationOk: boolean;
  answerIsolationOk: boolean;
  errors: string[];
};

function normalizeText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, variants: string[]): boolean {
  const normalized = normalizeText(text);
  return variants.some((variant) => normalized.includes(normalizeText(variant)));
}

function uniqueMarkers(facts: ScenarioFacts): string[] {
  return [facts.codeword, facts.color, facts.dog, facts.city];
}

function buildLargeLeaseContext(s: Scenario): string {
  const { codeword, color, dog, city, budget } = s.facts;
  return [
    `Це окрема розмова з кодовим словом ${codeword}.`,
    `Запам'ятай для цієї розмови: мій улюблений колір ${color}, собаку звати ${dog}, я живу в місті ${city}, мій бюджет ${budget}.`,
    'Нижче даю великий фактичний опис договору оренди, щоб перевірити довгий контекст і сумаризацію.',
    'Проєкт договору оренди офісу: строк 12 місяців, застава 2 місяці, штраф 5% за день прострочення, заборона суборенди без письмового дозволу, щомісячний огляд приміщення, обов’язкове страхування, комунальні платежі плюс адміністративний збір 10%, одностороннє розірвання лише після письмового попередження.',
    'Додаткові факти: орендодавець є ТОВ, договір підписується електронно, приміщення вже мало пожежу три роки тому, орендодавець вимагає банківську гарантію, а також хоче включити штраф за дострокове розірвання у розмірі трьох місячних платежів.',
    'Мені важливо, щоб у відповіді зараз були тільки ризики договору і короткий коментар щодо переговорної позиції, але персональні факти теж залишилися в пам’яті саме цієї розмови.',
  ].join(' ');
}

function buildLargeFinanceContext(s: Scenario): string {
  const { codeword, city, budget } = s.facts;
  return [
    `Продовжуємо цю саму справу ${codeword}.`,
    `Ще одна велика порція фактів: я планую працювати як фрілансер у місті ${city}, маю резервний фонд 52000 грн, щомісячний комфортний ліміт ${budget}, а також хочу уникати довгих судових спорів і дорогого страхування.`,
    'Орендодавець додав проєкт акта приймання-передачі, окрему форму допуску до приміщення, вимогу повідомляти про гостей, умову про заборону ремонту без письмової згоди та технічний додаток з описом електромережі, інтернет-лінії, системи пожежної сигналізації та доступу до серверної.',
    'Також у проєкті є умова про штраф 15 000 грн за будь-яке порушення внутрішніх правил будівлі, окрема компенсація за пошкодження майна, огляд приміщення кожні 30 днів, окрема фотофіксація стану майна, а також таблиця з переліком техніки, меблів і доступів.',
    'Потрібно коротко сказати, які документи підготувати і що я можу попросити змінити в договорі, але ці факти також мають залишитися прив’язаними лише до цього чату.',
  ].join(' ');
}

function buildTurns(s: Scenario): string[] {
  return [
    buildLargeLeaseContext(s),
    buildLargeFinanceContext(s),
    'Що ти вже пам’ятаєш саме про мене і цю справу? Назви кодове слово, собаку і місто.',
    'Поясни загально права орендаря при достроковому розірванні договору оренди за ЦКУ. Без згадки моїх персональних фактів.',
    'Коротко назви тільки факти з цієї розмови: кодове слово, колір, собака, місто. Не згадуй інші чати і не давай правовий аналіз.',
  ];
}

function secondaryFactHits(answerText: string, facts: ScenarioFacts): number {
  let hits = 0;
  if (containsAny(answerText, [facts.color])) hits++;
  if (containsAny(answerText, [facts.dog])) hits++;
  if (containsAny(answerText, [facts.city])) hits++;
  return hits;
}

function parseRunMetrics(run: Record<string, unknown>, answerText: string): TurnMetrics {
  const snapshot =
    run.snapshot && typeof run.snapshot === 'object' && !Array.isArray(run.snapshot)
      ? (run.snapshot as Record<string, unknown>)
      : null;
  const sourceSummary =
    snapshot?.source_summary &&
    typeof snapshot.source_summary === 'object' &&
    !Array.isArray(snapshot.source_summary)
      ? (snapshot.source_summary as Record<string, unknown>)
      : null;
  const searchPlan =
    run.search_plan && typeof run.search_plan === 'object' && !Array.isArray(run.search_plan)
      ? (run.search_plan as Record<string, unknown>)
      : null;
  const planSources =
    searchPlan?.plan &&
    typeof searchPlan.plan === 'object' &&
    !Array.isArray(searchPlan.plan) &&
    (searchPlan.plan as Record<string, unknown>).sources &&
    typeof (searchPlan.plan as Record<string, unknown>).sources === 'object'
      ? ((searchPlan.plan as Record<string, unknown>).sources as Record<string, unknown>)
      : searchPlan?.sources &&
          typeof searchPlan.sources === 'object' &&
          !Array.isArray(searchPlan.sources)
        ? (searchPlan.sources as Record<string, unknown>)
        : null;

  return {
    runId: String(run.run_id ?? ''),
    status: String(run.status ?? ''),
    memoryCount:
      typeof sourceSummary?.memory_count === 'number' ? sourceSummary.memory_count : null,
    lawCount: typeof sourceSummary?.law_count === 'number' ? sourceSummary.law_count : null,
    promptTokens:
      typeof sourceSummary?.prompt_tokens === 'number' ? sourceSummary.prompt_tokens : null,
    contextMode:
      typeof sourceSummary?.context_mode === 'string' ? sourceSummary.context_mode : null,
    useMemory:
      typeof planSources?.use_memory === 'boolean'
        ? planSources.use_memory
        : typeof sourceSummary?.context_mode === 'string'
          ? sourceSummary.context_mode === 'memory' || sourceSummary.context_mode === 'mixed'
          : null,
    answerText,
  };
}

async function ensureConversation(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  tenantId: string,
  userId: string,
  conversationId: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error: te } = await sb
    .from('tenants')
    .upsert({ id: tenantId, name: `Dev Tenant ${tenantId.slice(-4)}`, settings: {}, updated_at: now }, { onConflict: 'id' });
  if (te && te.code !== '23505') throw new Error(`tenants upsert: ${te.message}`);
  const { error: ce } = await sb
    .from('chat_sessions')
    .upsert({ id: conversationId, tenant_id: tenantId, user_id: userId, updated_at: now }, { onConflict: 'id' });
  if (ce && ce.code !== '23505') throw new Error(`chat_sessions upsert: ${ce.message}`);
}

async function pollRun(
  base: string,
  runId: string,
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < RUN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${base}/v1/runs/${runId}?include_snapshot=true`, { headers });
      if (!res.ok) {
        if (shouldRetryRunPollFailure(res.status)) continue;
        throw new Error(`GET /v1/runs/${runId} failed: ${res.status}`);
      }
      const run = (await res.json()) as Record<string, unknown>;
      const status = String(run.status ?? '');
      if (status === 'completed' || status === 'failed') return run;
    } catch (error) {
      if (shouldRetryRunPollFailure(undefined, error)) continue;
      throw error;
    }
  }
  throw new Error(`run ${runId} timeout after ${RUN_TIMEOUT_MS}ms`);
}

async function waitForOutboxConversationDrain(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  conversationId: string
): Promise<{ done: number; failed: number; pending: number; processing: number }> {
  const started = Date.now();
  while (Date.now() - started < OUTBOX_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, OUTBOX_POLL_INTERVAL_MS));
    const { data } = await sb
      .from('mm_outbox')
      .select('status')
      .eq('conversation_id', conversationId);
    const rows = (data ?? []) as Array<{ status: string }>;
    const done = rows.filter((row) => row.status === 'done').length;
    const failed = rows.filter((row) => row.status === 'failed').length;
    const pending = rows.filter((row) => row.status === 'pending').length;
    const processing = rows.filter((row) => row.status === 'processing').length;
    if (pending === 0 && processing === 0) {
      return { done, failed, pending, processing };
    }
  }
  const { data } = await sb
    .from('mm_outbox')
    .select('status')
    .eq('conversation_id', conversationId);
  const rows = (data ?? []) as Array<{ status: string }>;
  return {
    done: rows.filter((row) => row.status === 'done').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    pending: rows.filter((row) => row.status === 'pending').length,
    processing: rows.filter((row) => row.status === 'processing').length,
  };
}

async function recountOutboxConversation(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  conversationId: string
): Promise<{ done: number; failed: number; pending: number; processing: number }> {
  const { data } = await sb.from('mm_outbox').select('status').eq('conversation_id', conversationId);
  const rows = (data ?? []) as Array<{ status: string }>;
  return {
    done: rows.filter((row) => row.status === 'done').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    pending: rows.filter((row) => row.status === 'pending').length,
    processing: rows.filter((row) => row.status === 'processing').length,
  };
}

async function findAssistantAnswer(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  conversationId: string,
  runId: string
): Promise<string> {
  const { data, error } = await sb
    .from('messages')
    .select('role, content, metadata, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`messages query failed: ${error.message}`);
  const row = (data ?? []).find((message) => {
    const metadata =
      message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : null;
    return message.role === 'assistant' && metadata?.run_id === runId;
  });
  return String(row?.content ?? '');
}

async function runScenario(
  base: string,
  headers: Record<string, string>,
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  scenario: Scenario
): Promise<ScenarioResult> {
  const errors: string[] = [];
  const turns = buildTurns(scenario);
  const runs: TurnMetrics[] = [];

  await ensureConversation(sb, scenario.tenantId, scenario.userId, scenario.conversationId);

  for (let i = 0; i < turns.length; i++) {
    const postRes = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: turns[i],
        tenant_id: scenario.tenantId,
        user_id: scenario.userId,
        conversation_id: scenario.conversationId,
        dry_run: false,
      }),
    });
    if (postRes.status !== 202) {
      const text = await postRes.text();
      throw new Error(`${scenario.name}: POST /v1/runs ${postRes.status} ${text}`);
    }
    const body = (await postRes.json()) as { run_id?: string };
    if (!body.run_id) throw new Error(`${scenario.name}: missing run_id at turn ${i + 1}`);
    const run = await pollRun(base, body.run_id, { 'X-Dev-API-Key': DEV_KEY });
    const answerText = await findAssistantAnswer(sb, scenario.conversationId, body.run_id);
    runs.push(parseRunMetrics(run, answerText));
    if (i === 1) {
      await new Promise((r) => setTimeout(r, MATERIALIZATION_SETTLE_MS));
    }
  }

  await new Promise((r) => setTimeout(r, MATERIALIZATION_SETTLE_MS));
  let outbox = await waitForOutboxConversationDrain(sb, scenario.conversationId);
  if (outbox.failed === 0 && (outbox.pending > 0 || outbox.processing > 0 || outbox.done < turns.length)) {
    await new Promise((r) => setTimeout(r, MATERIALIZATION_SETTLE_MS));
    outbox = await recountOutboxConversation(sb, scenario.conversationId);
  }
  const { data: memoryRows } = await sb
    .from('mm_memory_items')
    .select('id')
    .eq('tenant_id', scenario.tenantId)
    .eq('user_id', scenario.userId)
    .eq('conversation_id', scenario.conversationId);
  const { data: summaryRows } = await sb
    .from('mm_summaries')
    .select('summary_text')
    .eq('tenant_id', scenario.tenantId)
    .eq('user_id', scenario.userId)
    .eq('conversation_id', scenario.conversationId)
    .limit(1);
  const summaryText = String(summaryRows?.[0]?.summary_text ?? '');

  const recallTurn = runs[2];
  const lawTurn = runs[3];
  const finalTurn = runs[4];

  if ((recallTurn.memoryCount ?? 0) < 1 || (recallTurn.lawCount ?? 0) !== 0) {
    errors.push(
      `${scenario.name}: recall turn did not use clean memory (memory=${String(recallTurn.memoryCount)} law=${String(recallTurn.lawCount)})`
    );
  }
  if (
    lawTurn.useMemory !== false ||
    (lawTurn.memoryCount ?? -1) !== 0 ||
    (lawTurn.lawCount ?? 0) < 1
  ) {
    errors.push(
      `${scenario.name}: law-only turn polluted (use_memory=${String(lawTurn.useMemory)} mem=${String(lawTurn.memoryCount)} law=${String(lawTurn.lawCount)})`
    );
  }
  if ((finalTurn.memoryCount ?? 0) < 1 || (finalTurn.lawCount ?? 0) !== 0) {
    errors.push(
      `${scenario.name}: final recall did not use clean memory (memory=${String(finalTurn.memoryCount)} law=${String(finalTurn.lawCount)})`
    );
  }

  const allOtherMarkers = SCENARIOS
    .filter((candidate) => candidate.name !== scenario.name)
    .flatMap((candidate) => uniqueMarkers(candidate.facts));
  const finalAnswer = finalTurn.answerText;
  const answerHasOwnCodeword = containsAny(finalAnswer, [scenario.facts.codeword]);
  const answerSecondaryHits = secondaryFactHits(finalAnswer, scenario.facts);
  const answerHasForeign = containsAny(finalAnswer, allOtherMarkers);
  const answerIsolationOk = answerHasOwnCodeword && answerSecondaryHits >= 2 && !answerHasForeign;
  if (!answerIsolationOk) {
    errors.push(
      `${scenario.name}: final answer isolation failed (own_codeword=${answerHasOwnCodeword} secondary_hits=${answerSecondaryHits} foreign=${answerHasForeign})`
    );
  }

  const { fetchRecentMemory } = await import('../../retrieval/memory-store.js');
  const ownFetch = await fetchRecentMemory({
    tenantId: scenario.tenantId,
    userId: scenario.userId,
    conversationId: scenario.conversationId,
    scopeMode: 'conversation_only',
    queryText: scenario.facts.codeword,
    runId: `verify-mm-isolation-own-${scenario.name}`,
    limit: 5,
  });
  const ownFetchText = [ownFetch.summaryText ?? '', ...ownFetch.refs.map((ref) => ref.content_preview ?? '')].join('\n');
  const directOwnFetchOk =
    ownFetch.refs.length > 0 &&
    ownFetch.scope_fallback_used !== true &&
    containsAny(ownFetchText, [scenario.facts.codeword]) &&
    !containsAny(ownFetchText, allOtherMarkers);
  if (!directOwnFetchOk) {
    errors.push(
      `${scenario.name}: own fetch isolation failed (refs=${ownFetch.refs.length} fallback=${String(ownFetch.scope_fallback_used)})`
    );
  }

  let directIsolationOk = true;
  for (const other of SCENARIOS.filter((candidate) => candidate.name !== scenario.name)) {
    const foreignFetch = await fetchRecentMemory({
      tenantId: scenario.tenantId,
      userId: scenario.userId,
      conversationId: scenario.conversationId,
      scopeMode: 'conversation_only',
      queryText: other.facts.codeword,
      runId: `verify-mm-isolation-foreign-${scenario.name}-${other.name}`,
      limit: 5,
    });
    const foreignFetchText = [
      foreignFetch.summaryText ?? '',
      ...foreignFetch.refs.map((ref) => ref.content_preview ?? ''),
    ].join('\n');
    const wrongScope = foreignFetch.refs.some((ref) => ref.scope_id && ref.scope_id !== scenario.conversationId);
    const foreignLeak = containsAny(foreignFetchText, uniqueMarkers(other.facts));
    if (foreignFetch.scope_fallback_used === true || wrongScope || foreignLeak) {
      directIsolationOk = false;
      errors.push(
        `${scenario.name}: foreign fetch leaked ${other.name} (fallback=${String(foreignFetch.scope_fallback_used)} wrong_scope=${wrongScope} foreign_leak=${foreignLeak})`
      );
    }
  }

  const hasSummary = summaryText.length > 0;
  if (!hasSummary) errors.push(`${scenario.name}: mm_summary missing`);
  if ((memoryRows ?? []).length < 2) {
    errors.push(`${scenario.name}: too few mm_memory_items (${(memoryRows ?? []).length})`);
  }
  if (outbox.failed > 0 || outbox.pending > 0 || outbox.processing > 0 || outbox.done < turns.length) {
    errors.push(
      `${scenario.name}: outbox not clean (done=${outbox.done} failed=${outbox.failed} pending=${outbox.pending} processing=${outbox.processing})`
    );
  }

  return {
    scenario,
    recallTurn,
    lawTurn,
    outboxDone: outbox.done,
    outboxFailed: outbox.failed,
    outboxPending: outbox.pending,
    outboxProcessing: outbox.processing,
    memoryItemsCount: (memoryRows ?? []).length,
    hasSummary,
    summaryText,
    directOwnFetchOk,
    directIsolationOk,
    answerIsolationOk,
    errors,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'same_user_chat_alpha',
    tenantId: TENANT_A,
    userId: USER_A,
    conversationId: randomUUID(),
    facts: {
      codeword: 'ALFA-731-KEDR',
      color: 'синій',
      dog: 'Рорі',
      city: 'Луцьк',
      budget: '18 500 грн',
    },
  },
  {
    name: 'same_user_chat_beta',
    tenantId: TENANT_A,
    userId: USER_A,
    conversationId: randomUUID(),
    facts: {
      codeword: 'BETA-448-LYMON',
      color: 'жовтий',
      dog: 'Топаз',
      city: 'Одеса',
      budget: '21 000 грн',
    },
  },
  {
    name: 'different_user_same_tenant',
    tenantId: TENANT_A,
    userId: USER_B,
    conversationId: randomUUID(),
    facts: {
      codeword: 'GAMMA-902-TREMBITA',
      color: 'червоний',
      dog: 'Нора',
      city: 'Харків',
      budget: '16 800 грн',
    },
  },
  {
    name: 'same_user_other_tenant',
    tenantId: TENANT_B,
    userId: USER_A,
    conversationId: randomUUID(),
    facts: {
      codeword: 'DELTA-155-SKELYA',
      color: 'зелений',
      dog: 'Боско',
      city: 'Чернівці',
      budget: '19 200 грн',
    },
  },
];

async function main(): Promise<void> {
  console.log('=== verify_memory_isolation_real ===');
  console.log('Real MM isolation QA: concurrent chats, large texts, worker-on, real model');
  console.log('Scenarios:', SCENARIOS.map((scenario) => scenario.name).join(', '));

  const { checkMmOutboxLeaseSchema } = await import('../../mm/outboxSchema.js');
  const schemaCheck = await checkMmOutboxLeaseSchema();
  if (!schemaCheck.ready) {
    console.error(
      `FAIL: ${schemaCheck.reason_code ?? 'MM_OUTBOX_SCHEMA_CHECK_FAILED'}: ${schemaCheck.error_message ?? 'mm_outbox lease schema not ready'}`
    );
    process.exit(1);
  }

  const { start } = await import('../../server.js');
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const sb = getSupabaseClient();

  const { port } = await start(0);
  const base = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Dev-API-Key': DEV_KEY,
  };

  const results = await Promise.all(
    SCENARIOS.map((scenario) => runScenario(base, headers, sb, scenario))
  );

  console.log('\n=== Isolation Results ===');
  let failed = false;
  for (const result of results) {
    console.log(`\n${result.scenario.name}`);
    console.log(`  tenant=${result.scenario.tenantId} user=${result.scenario.userId} conversation=${result.scenario.conversationId}`);
    console.log(
      `  outbox: done=${result.outboxDone} failed=${result.outboxFailed} pending=${result.outboxPending} processing=${result.outboxProcessing}`
    );
    console.log(
      `  memory_items=${result.memoryItemsCount} summary=${result.hasSummary} answer_isolation=${result.answerIsolationOk} direct_own_fetch=${result.directOwnFetchOk} direct_isolation=${result.directIsolationOk}`
    );
    console.log(
      `  recall_turn: memory=${String(result.recallTurn.memoryCount)} law=${String(result.recallTurn.lawCount)}`
    );
    console.log(
      `  law_turn: use_memory=${String(result.lawTurn.useMemory)} memory=${String(result.lawTurn.memoryCount)} law=${String(result.lawTurn.lawCount)}`
    );
    if (result.errors.length > 0) {
      failed = true;
      for (const error of result.errors) {
        console.error(`  ERROR: ${error}`);
      }
    }
  }

  if (failed) {
    console.error('\nFAIL: MM isolation QA detected contamination or worker/materialization issues.');
    process.exit(1);
  }

  console.log('\nPASS: MM real isolation QA passed.');
  console.log('Verified concurrently: same-user different chats, different users, and same user across tenants.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
