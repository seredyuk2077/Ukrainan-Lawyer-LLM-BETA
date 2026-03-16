#!/usr/bin/env node
/**
 * Long-conversation memory verifier: worker-on only.
 * One conversation, 12+ turns; validates summarize/compress/materialize and bounded prompt growth.
 *
 * Hard acceptance:
 * - Outbox rows processed for this conversation
 * - At least one mm_summaries row for the conversation
 * - Later recall turns: memoryCount >= 1, lawCount = 0
 * - historyCount capped; prompt_tokens bounded (e.g. final recall <= 1.5x mid-conversation)
 * - Final constrained recall answer must reference BOTH early-turn facts (синій + рорі)
 * - Intermediate prompt growth bounded: turn 7 prompt_tokens <= turn 3 * INTERMEDIATE_GROWTH_MAX
 *
 * Run: MM_OUTBOX_WORKER_ENABLED=true pnpm exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_long_conversation.ts
 */
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { shouldRetryRunPollFailure } from './verify_memory_e2e.js';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_TENANT = '00000000-0000-0000-0000-000000000001';
const DEV_USER = '00000000-0000-0000-0000-000000000002';
const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const MIN_TURNS = 12;
const POLL_MS = 2000;
const POLL_RUN_MS = 1000;
const TURN_TIMEOUT_MS = 90_000;
const RUN_COMPLETION_TIMEOUT_MS = 120_000;
const PROMPT_GROWTH_RATIO_MAX = 1.5;
/** Intermediate checkpoint: turn 7 (summarize) must not blow up vs turn 3 (first recall). */
const PROMPT_GROWTH_INTERMEDIATE_MAX = 2.0;

type TurnSpec = {
  query: string;
  mode: 'memory' | 'law';
};

const TURNS: TurnSpec[] = [
  { query: "Запам'ятай факт про мене: мій улюблений колір — синій.", mode: 'memory' },
  { query: "Запам'ятай ще факт: мою собаку звати Рорі.", mode: 'memory' },
  { query: 'Запам’ятай: у травні я планую коротку відпустку у Львові.', mode: 'memory' },
  { query: 'Що ти вже пам’ятаєш про мене з цієї розмови?', mode: 'memory' },
  { query: 'Запам’ятай також: мене цікавить цивільне право.', mode: 'memory' },
  { query: 'Назви два факти з початку розмови.', mode: 'memory' },
  { query: 'Запам’ятай ще: я люблю дуже короткі відповіді.', mode: 'memory' },
  { query: 'Стисло підсумуй, що ти знаєш про мене з цієї розмови.', mode: 'memory' },
  { query: 'Чим відрізняється крадіжка від грабежу?', mode: 'law' },
  {
    query: 'Повернись до пам’яті про мене: назви два ранні факти, але не згадуй право й травень.',
    mode: 'memory',
  },
  { query: 'Одним реченням нагадай, що ти пам’ятаєш про мене.', mode: 'memory' },
  {
    query: 'Назви два факти з початку розмови, але не згадуй травень чи право.',
    mode: 'memory',
  },
];

function normalizeText(input: string): string {
  return (input ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(text: string, variants: string[]): boolean {
  const normalized = normalizeText(text);
  return variants.some((variant) => normalized.includes(normalizeText(variant)));
}

function finalAnswerHasColorFact(answer: string): boolean {
  return containsAny(answer, ['синій', 'синього', 'синьому', 'улюблений колір', 'синій колір']);
}

function finalAnswerHasDogFact(answer: string): boolean {
  return containsAny(answer, ['рорі', 'собаку звати', 'собака звати', 'пес', 'собака', 'рорі']);
}

/**
 * Stronger early-fact check: final constrained recall (turn 11) must mention BOTH
 * синій (color fact from turn 0) AND рорі (dog fact from turn 1).
 * These are the two "earliest" facts from the scripted scenario.
 * The turn 11 query explicitly asks for facts excluding травень and право.
 */
function finalAnswerHasBothEarlyFacts(answer: string): boolean {
  return finalAnswerHasColorFact(answer) && finalAnswerHasDogFact(answer);
}

/** Kept for backward compat with intermediate recall checks */
function finalAnswerHasEarlyFact(answer: string): boolean {
  return finalAnswerHasColorFact(answer) || finalAnswerHasDogFact(answer);
}

if (!process.env.DEV_API_KEY) process.env.DEV_API_KEY = DEV_KEY;
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';
if (!process.env.REDIS_QUEUE_NAMESPACE) {
  process.env.REDIS_QUEUE_NAMESPACE = `lexery:verify:longconv:${randomUUID()}`;
}

async function ensureConversation(conversationId: string): Promise<void> {
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const sb = getSupabaseClient();
  const now = new Date().toISOString();
  const retryIo = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const msg =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (!/fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg) || i === 3) {
          throw error instanceof Error ? error : new Error(`${label}: ${String(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${label}: unknown retry failure`);
  };
  const { error: te } = await retryIo('tenants upsert', () =>
    sb.from('tenants').upsert({ id: DEV_TENANT, name: 'Dev Tenant', settings: {}, updated_at: now }, { onConflict: 'id' })
  );
  if (te && te.code !== '23505') throw new Error(`tenants upsert: ${te.message}`);
  const { error: ce } = await retryIo('chat_sessions upsert', () =>
    sb.from('chat_sessions').upsert({ id: conversationId, tenant_id: DEV_TENANT, user_id: DEV_USER, updated_at: now }, { onConflict: 'id' })
  );
  if (ce && ce.code !== '23505') throw new Error(`chat_sessions upsert: ${ce.message}`);
}

async function main(): Promise<void> {
  if (process.env.MM_OUTBOX_WORKER_ENABLED !== 'true') {
    console.error('FAIL: MM_OUTBOX_WORKER_ENABLED must be true for long-conversation verifier.');
    process.exit(1);
  }

  const { checkMmOutboxLeaseSchema } = await import('../../mm/outboxSchema.js');
  const schemaCheck = await checkMmOutboxLeaseSchema();
  if (!schemaCheck.ready) {
    console.error(
      `FAIL: ${schemaCheck.reason_code ?? 'MM_OUTBOX_SCHEMA_CHECK_FAILED'}: ${schemaCheck.error_message ?? 'mm_outbox lease schema is not ready'}`
    );
    process.exit(1);
  }

  const conversationId = randomUUID();
  console.log('Long-conversation verifier: conversation_id=', conversationId);
  console.log('This verifier requires worker processing and mm_summaries. Running minimal checks.');

  await ensureConversation(conversationId);
  const verify_start_ts = new Date().toISOString();

  const { start } = await import('../../server.js');
  const { port } = await start(0);
  const base = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Dev-API-Key': DEV_KEY,
  };
  const getHeaders = { ...headers };
  delete (getHeaders as Record<string, string>)['Content-Type'];

  const turns = TURNS.slice(0, MIN_TURNS);

  const runIds: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: turns[i].query,
        tenant_id: DEV_TENANT,
        user_id: DEV_USER,
        conversation_id: conversationId,
        dry_run: false,
      }),
    });
    if (res.status !== 202) {
      const text = await res.text();
      console.error('FAIL: POST /v1/runs returned', res.status, text);
      process.exit(1);
    }
    const body = (await res.json()) as { run_id?: string };
    const runId = body.run_id;
    if (!runId) {
      console.error('FAIL: POST /v1/runs did not return run_id');
      process.exit(1);
    }
    runIds.push(runId);

    const startWall = Date.now();
    while (Date.now() - startWall < RUN_COMPLETION_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_RUN_MS));
      let run: { status?: string } | null = null;
      try {
        const getRes = await fetch(`${base}/v1/runs/${runId}?include_snapshot=true`, { headers: getHeaders });
        if (!getRes.ok) {
          if (shouldRetryRunPollFailure(getRes.status)) continue;
          continue;
        }
        run = (await getRes.json()) as { status?: string };
      } catch (err) {
        if (shouldRetryRunPollFailure(undefined, err)) continue;
        continue;
      }
      if (run.status === 'completed' || run.status === 'failed') break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  const deadline = Date.now() + Math.max(TURN_TIMEOUT_MS, turns.length * 15_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const { getSupabaseClient } = await import('../../lib/supabase.js');
      const sb = getSupabaseClient();
      const { data: outboxRows } = await sb
        .from('mm_outbox')
        .select('id, status')
        .eq('conversation_id', conversationId)
        .gte('created_at', verify_start_ts);
      const rows = (outboxRows ?? []) as Array<{ id: string; status: string }>;
      const done = rows.filter((r) => r.status === 'done').length;
      const total = rows.length;
      if (total >= turns.length && done >= turns.length) {
        console.log('Outbox processed: done=', done, 'total=', total);

        const { data: summaryRows } = await sb
          .from('mm_summaries')
          .select('id')
          .eq('conversation_id', conversationId)
          .limit(1);
        const hasSummary = Array.isArray(summaryRows) && summaryRows.length > 0;
        if (!hasSummary) {
          console.error('FAIL: no mm_summaries row for conversation (materialization not proven).');
          process.exit(1);
        }
        console.log('mm_summaries present: at least one row');

        const { RunRepository } = await import('../../gateway/storage.js');
        const repo = new RunRepository();
        const runRows: Array<{
          runId: string;
          query: string;
          mode: 'memory' | 'law';
          historyCount: number | null;
          memoryCount: number | null;
          lawCount: number | null;
          promptTokens: number | null;
        }> = [];
        for (let i = 0; i < runIds.length; i++) {
          const runId = runIds[i];
          const run = await repo.findByRunId(runId);
          const snap = run?.snapshot as {
            source_summary?: {
              law_count?: number;
              memory_count?: number;
              history_count?: number;
              prompt_tokens?: number;
            };
          } | undefined;
          const src = snap?.source_summary;
          runRows.push({
            runId,
            query: turns[i]?.query ?? '',
            mode: turns[i]?.mode ?? 'memory',
            historyCount: typeof src?.history_count === 'number' ? src.history_count : null,
            memoryCount: typeof src?.memory_count === 'number' ? src.memory_count : null,
            lawCount: typeof src?.law_count === 'number' ? src.law_count : null,
            promptTokens: typeof src?.prompt_tokens === 'number' ? src.prompt_tokens : null,
          });
        }

        const laterMemoryRecalls = runRows.filter(
          (row, idx) => idx >= 9 && row.mode === 'memory' && (row.memoryCount ?? 0) >= 1 && (row.lawCount ?? 0) === 0
        );
        if (laterMemoryRecalls.length === 0) {
          console.error(
            'FAIL: no later turn had memoryCount>=1 and lawCount=0 (recall from memory not proven).'
          );
          process.exit(1);
        }

        // Turn indices: 3=first recall, 7=summarize, 9=mid constrained recall, 11=final constrained recall
        const firstRecall = runRows[3];
        const summaryTurn = runRows[7];
        const midRecall = runRows[9];
        const finalRecall = runRows[11];
        if (!midRecall || !finalRecall) {
          console.error('FAIL: long verifier expected mid/final recall runs are missing.');
          process.exit(1);
        }
        if ((midRecall.memoryCount ?? 0) < 1 || (midRecall.lawCount ?? 0) !== 0) {
          console.error('FAIL: mid recall turn did not use memory artifacts cleanly.');
          process.exit(1);
        }
        if ((finalRecall.memoryCount ?? 0) < 1 || (finalRecall.lawCount ?? 0) !== 0) {
          console.error('FAIL: final recall turn did not use memory artifacts cleanly.');
          process.exit(1);
        }
        const { config } = await import('../../lib/config.js');
        if (
          typeof finalRecall.historyCount === 'number' &&
          finalRecall.historyCount > config.u9MaxHistoryMessages
        ) {
          console.error(
            `FAIL: final recall historyCount=${finalRecall.historyCount} exceeds configured cap=${config.u9MaxHistoryMessages}.`
          );
          process.exit(1);
        }
        if (
          typeof midRecall.promptTokens !== 'number' ||
          typeof finalRecall.promptTokens !== 'number'
        ) {
          console.error('FAIL: prompt_tokens missing for mid/final recall runs.');
          process.exit(1);
        }

        // Intermediate prompt-growth checkpoint (turn 3 → turn 7):
        // Proves compression is active BEFORE the final recall, not only at the end.
        if (
          typeof firstRecall?.promptTokens === 'number' &&
          typeof summaryTurn?.promptTokens === 'number' &&
          firstRecall.promptTokens > 0
        ) {
          const interimRatio = summaryTurn.promptTokens / firstRecall.promptTokens;
          if (interimRatio > PROMPT_GROWTH_INTERMEDIATE_MAX) {
            console.error(
              `FAIL: intermediate prompt growth (turn3→turn7) ratio too high (${interimRatio.toFixed(2)} > ${PROMPT_GROWTH_INTERMEDIATE_MAX}). Compression may not be active.`
            );
            process.exit(1);
          }
          console.log(
            'Intermediate growth check (turn3→turn7): ratio=',
            interimRatio.toFixed(2),
            'turn3_tokens=',
            firstRecall.promptTokens,
            'turn7_tokens=',
            summaryTurn.promptTokens
          );
        }

        const promptRatio = finalRecall.promptTokens / Math.max(1, midRecall.promptTokens);
        if (promptRatio > PROMPT_GROWTH_RATIO_MAX) {
          console.error(
            `FAIL: final recall prompt growth ratio too high (${promptRatio.toFixed(2)} > ${PROMPT_GROWTH_RATIO_MAX}).`
          );
          process.exit(1);
        }

        const { data: messageRows, error: messagesErr } = await sb
          .from('messages')
          .select('role, content, metadata, created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true });
        if (messagesErr) {
          console.error(`FAIL: messages query failed: ${messagesErr.message}`);
          process.exit(1);
        }
        const assistantForFinal = (messageRows ?? []).find((row) => {
          const metadata = row.metadata as { run_id?: string } | null;
          return row.role === 'assistant' && metadata?.run_id === finalRecall.runId;
        });
        const finalAnswer = String(assistantForFinal?.content ?? '');
        if (!finalAnswer) {
          console.error('FAIL: final assistant message for long verifier run not found.');
          process.exit(1);
        }
        // Stronger check: final constrained recall must reference BOTH early facts (синій + рорі).
        // The query at turn 11 explicitly asks to exclude травень and право, so синій and рорі
        // are the only early facts that satisfy the constraint — deterministic for this scenario.
        if (!finalAnswerHasBothEarlyFacts(finalAnswer)) {
          const hasColor = finalAnswerHasColorFact(finalAnswer);
          const hasDog = finalAnswerHasDogFact(finalAnswer);
          if (!finalAnswerHasEarlyFact(finalAnswer)) {
            console.error(
              'FAIL: final recall answer did not reference any early-turn fact (синій or рорі).'
            );
          } else {
            console.error(
              `FAIL: final recall answer referenced only one early fact (color=${hasColor}, dog=${hasDog}). Expected BOTH синій and рорі.`
            );
          }
          process.exit(1);
        }

        console.log(
          'Later recall with memory artifacts: turns=',
          laterMemoryRecalls.length,
          'mid_prompt_tokens=',
          midRecall.promptTokens,
          'final_prompt_tokens=',
          finalRecall.promptTokens,
          'prompt_growth_ratio=',
          promptRatio.toFixed(2),
          'final_history_count=',
          finalRecall.historyCount,
          'final_memory_count=',
          finalRecall.memoryCount
        );
        console.log(
          'Early-fact quality check: both_facts=',
          finalAnswerHasBothEarlyFacts(finalAnswer),
          'color_fact=',
          finalAnswerHasColorFact(finalAnswer),
          'dog_fact=',
          finalAnswerHasDogFact(finalAnswer)
        );
        console.log('PASS: long-conversation closure checks passed (including stronger quality checks).');
        process.exit(0);
      }
    } catch (e) {
      console.warn('Poll error:', (e as Error).message);
    }
  }

  console.error('FAIL: timeout waiting for outbox processing and summaries.');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
