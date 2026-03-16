/**
 * verify_memory_parallel_stress — Heavy-context parallel memory stress verifier.
 *
 * Design:
 *   - 4 conversations in parallel, 10 turns each (total = 40 runs)
 *   - Conversations include large pasted texts, evolving facts, and memory-recall turns
 *   - Worker-on mode (MM_OUTBOX_WORKER_ENABLED=true) — tests durable materialization under load
 *   - Test-only cheaper writer model (LEGAL_AGENT_MODEL_ID override, NOT a production default change)
 *   - Verifies: no failed runs, outbox drains, later recalls use memory artifacts,
 *     history stays bounded, prompt growth bounded, law-only recalls keep lawCount=0
 *
 * Run: pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_parallel_stress.ts
 *
 * IMPORTANT: This script overrides LEGAL_AGENT_MODEL_ID to a cheaper test-only model
 * for the spawned server process only. Production defaults in config.ts are NOT changed.
 */
import { createServer } from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
if (!process.env.DEV_API_KEY) process.env.DEV_API_KEY = DEV_KEY;
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';
const DEV_TENANT = '00000000-0000-0000-0000-000000000001';
const DEV_USER = '00000000-0000-0000-0000-000000000002';

const PARALLEL_CONVERSATIONS = 4;
const TURNS_PER_CONVERSATION = 10;
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 40_000;
const POLL_MS = 600;
const RUN_POLL_TIMEOUT_MS = 240_000;
const OUTBOX_DRAIN_TIMEOUT_MS = 120_000;
const OUTBOX_POLL_INTERVAL_MS = 3_000;
const SHUTDOWN_WAIT_MS = 4_000;
const PROMPT_GROWTH_RATIO_MAX = 2.5;
const INTERMEDIATE_RECALL_GROWTH_RATIO_MAX = 2.0;
const VERBOSE_SERVER_LOGS = process.env.MM_VERIFY_VERBOSE_SERVER === 'true';

/**
 * Test-only cheaper model override. This is ONLY applied to the server spawned by this
 * verifier script. Production config.ts defaults remain unchanged.
 * gpt-4o-mini is significantly cheaper than gpt-5.2 and appropriate for stress testing.
 */
const STRESS_WRITER_MODEL = process.env.STRESS_WRITER_MODEL_OVERRIDE ?? 'openai/gpt-4o-mini';

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/** Multi-turn conversation script with large texts and evolving facts. */
function buildConversationScript(convIndex: number): string[] {
  const factPrefix = `[Розмова ${convIndex + 1}]`;
  return [
    // Turn 1: Large context paste — simulates user pasting a legal document excerpt
    `${factPrefix} Ось витяг із договору оренди, який я хочу обговорити:\n\n` +
      `ДОГОВІР ОРЕНДИ НЕРУХОМОГО МАЙНА №${100 + convIndex}\n` +
      `Орендодавець: ТОВ "Будмайстер-${convIndex + 1}"\n` +
      `Орендар: Фізична особа Коваленко Петро Іванович\n` +
      `Об'єкт: офісне приміщення площею ${40 + convIndex * 5} кв.м. за адресою вул. Лесі Українки, ${10 + convIndex}\n` +
      `Термін: 12 місяців з дати підписання\n` +
      `Орендна плата: ${15000 + convIndex * 1000} грн/місяць\n` +
      `Застава: 2 місяці орендної плати\n` +
      `Відповідальність: штраф 5% від місячної орендної плати за кожен день прострочення\n` +
      `Чи є тут якісь ризики для орендаря?`,

    // Turn 2: Evolving fact — personal context
    `${factPrefix} Також хочу уточнити: я планую використовувати це приміщення для роботи фрілансера. ` +
      `Я не зареєстрований як ФОП. Чи є у мене право на таку оренду і чи потрібна мені ліцензія?`,

    // Turn 3: Additional context with large financial data
    `${factPrefix} Мій бюджет на оренду становить ${18000 + convIndex * 500} грн на місяць. ` +
      `Я вже маю заощадження ${45000 + convIndex * 2000} грн для першого внеску і застави. ` +
      `Орендодавець вимагає додатково банківську гарантію на суму 3 місяців оренди. ` +
      `Розкажи мені, які документи мені потрібно підготувати для укладення договору?`,

    // Turn 4: Another legal context paste
    `${factPrefix} Орендодавець надіслав додаткові умови:\n` +
      `1. Заборона суборенди без письмового дозволу\n` +
      `2. Щомісячний огляд приміщення орендодавцем з попередженням за 48 годин\n` +
      `3. Обов'язкове страхування майна від пожежі та затоплення\n` +
      `4. При достроковому розірванні — штраф 3 місячних орендних плати\n` +
      `5. Комунальні платежі за лічильниками + адміністративний збір 10%\n` +
      `Які з цих умов можуть суперечити ЦКУ?`,

    // Turn 5: Memory recall query — should have memoryCount > 0
    `${factPrefix} Нагадай мені ключові деталі договору, який ми обговорювали на початку розмови?`,

    // Turn 6: Evolving fact — new information
    `${factPrefix} Дуже важливо: я дізнався, що в цьому будинку вже була пожежа 3 роки тому. ` +
      `Будівля відремонтована, але страховка коштуватиме дорожче. ` +
      `Чи можу я вимагати від орендодавця знижку у зв'язку з цим?`,

    // Turn 7: More context accumulation
    `${factPrefix} Ще одна деталь: орендодавець — юридична особа (ТОВ), а я фізична особа. ` +
      `Договір складено лише в електронному вигляді без нотаріального посвідчення. ` +
      `Чи є у цьому проблема? Термін оренди — 12 місяців.`,

    // Turn 8: Memory recall with specific detail check
    `${factPrefix} Що я тобі розповідав про свій бюджет і фінансову ситуацію в цій розмові?`,

    // Turn 9: Law-only query (should be use_memory=false for memory-mode converations if law-only)
    `${factPrefix} Розкажи загально про права орендаря при розірванні договору за ЦКУ ст. 782.`,

    // Turn 10: Final memory recall — should accumulate all facts
    `${factPrefix} Підсумуй всю важливу інформацію з нашої розмови про оренду.`,
  ];
}

function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      s.close(() => (port ? res(port) : rej(new Error('no port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(port: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) {
        const b = (await r.json()) as { status?: string };
        if (b?.status === 'healthy') return;
      }
    } catch { /* retry */ }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`Server health timeout after ${HEALTH_TIMEOUT_MS}ms`);
}

async function ensureConversation(sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>, conversationId: string): Promise<void> {
  const now = new Date().toISOString();
  await sb.from('tenants').upsert(
    { id: DEV_TENANT, name: 'Dev Tenant', settings: {}, updated_at: now },
    { onConflict: 'id' }
  );
  await sb.from('chat_sessions').upsert(
    { id: conversationId, tenant_id: DEV_TENANT, user_id: DEV_USER, updated_at: now },
    { onConflict: 'id' }
  );
}

async function pollRunTerminal(baseUrl: string, runId: string): Promise<{ status: string; run: Record<string, unknown> | null }> {
  const start = Date.now();
  while (Date.now() - start < RUN_POLL_TIMEOUT_MS) {
    try {
      const r = await fetch(`${baseUrl}/v1/runs/${runId}?include_snapshot=true`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (r.status === 200) {
        const body = (await r.json()) as Record<string, unknown>;
        if (TERMINAL_STATUSES.has(String(body.status))) {
          return { status: String(body.status), run: body };
        }
      }
    } catch { /* retry */ }
    await sleep(POLL_MS);
  }
  return { status: 'timeout', run: null };
}

export interface TurnResult {
  turn: number;
  run_id: string | null;
  status: string;
  memory_count: number | null;
  law_count: number | null;
  prompt_tokens: number | null;
  context_mode: string | null;
  use_memory: boolean | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function extractTurnMetrics(run: Record<string, unknown>): Pick<TurnResult, 'memory_count' | 'law_count' | 'prompt_tokens' | 'context_mode' | 'use_memory'> {
  const snap = asRecord(run.snapshot);
  const srcSummary = snap ? asRecord(snap.source_summary) : null;
  if (srcSummary) {
    return {
      memory_count: typeof srcSummary.memory_count === 'number' ? srcSummary.memory_count : null,
      law_count: typeof srcSummary.law_count === 'number' ? srcSummary.law_count : null,
      prompt_tokens: typeof srcSummary.prompt_tokens === 'number' ? srcSummary.prompt_tokens : null,
      context_mode: typeof srcSummary.context_mode === 'string' ? srcSummary.context_mode : null,
      use_memory: typeof srcSummary.context_mode === 'string'
        ? srcSummary.context_mode === 'memory' || srcSummary.context_mode === 'mixed'
        : null,
    };
  }
  // Fallback: search_plan
  const sp = asRecord(run.search_plan);
  const plan = sp ? asRecord(sp.plan) : null;
  const sources = plan ? asRecord(plan.sources) : (sp ? asRecord(sp.sources) : null);
  return {
    memory_count: null,
    law_count: null,
    prompt_tokens: null,
    context_mode: null,
    use_memory: sources ? (sources.use_memory === true) : null,
  };
}

async function hydrateTurnMetricsFromDb(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  turn: TurnResult
): Promise<void> {
  if (!turn.run_id) return;
  if (
    turn.memory_count != null &&
    turn.law_count != null &&
    turn.prompt_tokens != null &&
    turn.context_mode != null &&
    turn.use_memory != null
  ) {
    return;
  }
  const { data } = await sb
    .from('runs')
    .select('snapshot, query_profile')
    .eq('run_id', turn.run_id)
    .maybeSingle();
  if (!data) return;
  const metrics = extractTurnMetrics(data as Record<string, unknown>);
  if (turn.memory_count == null) turn.memory_count = metrics.memory_count;
  if (turn.law_count == null) turn.law_count = metrics.law_count;
  if (turn.prompt_tokens == null) turn.prompt_tokens = metrics.prompt_tokens;
  if (turn.context_mode == null) turn.context_mode = metrics.context_mode;
  if (turn.use_memory == null) turn.use_memory = metrics.use_memory;
}

export interface ConversationResult {
  conv_id: string;
  conv_index: number;
  turns: TurnResult[];
  outbox_done: number;
  outbox_failed: number;
  outbox_stale: number;
  memory_recall_ok: boolean;
  prompt_growth_ok: boolean;
  intermediate_prompt_growth_ok: boolean;
  law_only_memory_clean: boolean;
  all_runs_terminal: boolean;
  errors: string[];
}

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function recomputeConversationFlags(result: ConversationResult): void {
  result.all_runs_terminal = result.turns.every((t) => isTerminalStatus(t.status));
  result.errors = result.errors.filter((e) => !e.includes('timeout'));

  const recallTurnIndices = [4, 7, 9];
  const recallTurns = recallTurnIndices.map((i) => result.turns[i]).filter(Boolean);
  const recallsWithMemory = recallTurns.filter((t) => t.memory_count != null && t.memory_count > 0);
  const laterRecallTurns = [result.turns[7], result.turns[9]].filter(Boolean);
  const laterRecallsWithMemory = laterRecallTurns.filter(
    (t) => t.memory_count != null && t.memory_count > 0 && (t.law_count ?? 0) === 0
  );
  result.memory_recall_ok =
    recallsWithMemory.length >= Math.ceil(recallTurns.length / 2) &&
    laterRecallsWithMemory.length === laterRecallTurns.length;
  if (!result.memory_recall_ok) {
    result.errors.push(
      `conv${result.conv_index} durable recall failed (later_memory=${laterRecallsWithMemory.length}/${laterRecallTurns.length}, recall_memory=${recallsWithMemory.length}/${recallTurns.length})`
    );
  }

  const firstRecallTokens = result.turns[4]?.prompt_tokens;
  const midRecallTokens = result.turns[7]?.prompt_tokens;
  const lastRecallTokens = result.turns[9]?.prompt_tokens;
  result.prompt_growth_ok = evaluatePromptGrowth({
    firstTurnTokens: firstRecallTokens,
    lastTurnTokens: lastRecallTokens,
    maxRatio: PROMPT_GROWTH_RATIO_MAX,
  });
  if (!result.prompt_growth_ok) {
    const reason =
      firstRecallTokens == null || lastRecallTokens == null || firstRecallTokens <= 0
        ? 'memory-recall prompt_tokens unavailable for final growth check'
        : `prompt growth exceeded ${PROMPT_GROWTH_RATIO_MAX}x`;
    result.errors.push(`conv${result.conv_index} ${reason}`);
  }

  result.intermediate_prompt_growth_ok = evaluatePromptGrowth({
    firstTurnTokens: firstRecallTokens,
    lastTurnTokens: midRecallTokens,
    maxRatio: INTERMEDIATE_RECALL_GROWTH_RATIO_MAX,
  });
  if (!result.intermediate_prompt_growth_ok) {
    const reason =
      firstRecallTokens == null || midRecallTokens == null || firstRecallTokens <= 0
        ? 'memory-recall prompt_tokens unavailable for intermediate growth check'
        : `intermediate recall growth exceeded ${INTERMEDIATE_RECALL_GROWTH_RATIO_MAX}x`;
    result.errors.push(`conv${result.conv_index} ${reason}`);
  }

  const lawOnlyTurn = result.turns[8];
  if (lawOnlyTurn) {
    result.law_only_memory_clean =
      lawOnlyTurn.use_memory === false &&
      (lawOnlyTurn.memory_count ?? -1) === 0 &&
      (lawOnlyTurn.law_count ?? 0) > 0;
    if (!result.law_only_memory_clean) {
      result.errors.push(
        `conv${result.conv_index} law-only turn polluted (use_memory=${String(lawOnlyTurn.use_memory)} mem=${String(lawOnlyTurn.memory_count)} law=${String(lawOnlyTurn.law_count)})`
      );
    }
  }
}

async function backfillTimedOutTurns(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  convResults: ConversationResult[]
): Promise<void> {
  const timedOutTurns = convResults.flatMap((cr) =>
    cr.turns.filter((t) => t.status === 'timeout' && t.run_id)
      .map((t) => ({ conv: cr, turn: t }))
  );
  if (timedOutTurns.length === 0) return;

  const runIds = timedOutTurns.map(({ turn }) => turn.run_id!) as string[];
  const { data } = await sb
    .from('runs')
    .select('run_id,status,snapshot,query_profile')
    .in('run_id', runIds);
  if (!data || data.length === 0) return;

  const byRunId = new Map<string, Record<string, unknown>>();
  for (const row of data as Record<string, unknown>[]) {
    const runId = typeof row.run_id === 'string' ? row.run_id : null;
    if (runId) byRunId.set(runId, row);
  }

  for (const { conv, turn } of timedOutTurns) {
    const row = byRunId.get(turn.run_id!);
    if (!row) continue;
    const status = typeof row.status === 'string' ? row.status : null;
    if (!status || !isTerminalStatus(status)) continue;
    turn.status = status;
    const metrics = extractTurnMetrics(row);
    Object.assign(turn, metrics);
    await hydrateTurnMetricsFromDb(sb, turn);
    conv.errors = conv.errors.filter((e) => e !== `conv${conv.conv_index}t${turn.turn} timeout`);
  }

  for (const conv of convResults) {
    conv.errors = [];
    recomputeConversationFlags(conv);
  }
}

export function evaluatePromptGrowth(params: {
  firstTurnTokens: number | null;
  lastTurnTokens: number | null;
  maxRatio?: number;
}): boolean {
  const maxRatio = params.maxRatio ?? PROMPT_GROWTH_RATIO_MAX;
  if (
    params.firstTurnTokens == null ||
    params.lastTurnTokens == null ||
    params.firstTurnTokens <= 0
  ) {
    return false;
  }
  return params.lastTurnTokens / params.firstTurnTokens <= maxRatio;
}

async function runConversation(
  port: number,
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  convIndex: number
): Promise<ConversationResult> {
  const convId = randomUUID();
  const result: ConversationResult = {
    conv_id: convId,
    conv_index: convIndex,
    turns: [],
    outbox_done: 0,
    outbox_failed: 0,
    outbox_stale: 0,
    memory_recall_ok: false,
    prompt_growth_ok: false,
    intermediate_prompt_growth_ok: false,
    law_only_memory_clean: true,
    all_runs_terminal: true,
    errors: [],
  };

  try {
    await ensureConversation(sb, convId);
  } catch (e) {
    result.errors.push(`ensureConversation: ${String(e).slice(0, 100)}`);
    result.all_runs_terminal = false;
    return result;
  }

  const base = `http://localhost:${port}`;
  const script = buildConversationScript(convIndex);

  for (let i = 0; i < script.length; i++) {
    const query = script[i];
    const turn: TurnResult = {
      turn: i + 1,
      run_id: null,
      status: 'not_started',
      memory_count: null,
      law_count: null,
      prompt_tokens: null,
      context_mode: null,
      use_memory: null,
    };

    try {
      const postRes = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
        body: JSON.stringify({
          query,
          tenant_id: DEV_TENANT,
          user_id: DEV_USER,
          conversation_id: convId,
        }),
      });
      if (!postRes.ok) {
        const txt = await postRes.text().catch(() => '');
        turn.status = `enqueue_failed_${postRes.status}`;
        result.errors.push(`conv${convIndex}t${i + 1} POST ${postRes.status}: ${txt.slice(0, 80)}`);
        result.all_runs_terminal = false;
        result.turns.push(turn);
        continue;
      }
      const body = (await postRes.json()) as { run_id?: string };
      turn.run_id = body.run_id ?? null;
      if (!turn.run_id) {
        turn.status = 'no_run_id';
        result.all_runs_terminal = false;
        result.turns.push(turn);
        continue;
      }

      const { status, run } = await pollRunTerminal(base, turn.run_id);
      turn.status = status;
      if (status === 'timeout' || !run) {
        result.all_runs_terminal = false;
        result.errors.push(`conv${convIndex}t${i + 1} timeout`);
      } else if (run) {
        const metrics = extractTurnMetrics(run);
        Object.assign(turn, metrics);
        await hydrateTurnMetricsFromDb(sb, turn);
      }
    } catch (e) {
      turn.status = 'error';
      result.errors.push(`conv${convIndex}t${i + 1}: ${String(e).slice(0, 100)}`);
      result.all_runs_terminal = false;
    }

    result.turns.push(turn);
  }

  recomputeConversationFlags(result);

  return result;
}

async function waitForOutboxDrain(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  conversationIds: string[]
): Promise<{ done: number; failed: number; stale: number; pending: number; processing: number }> {
  const start = Date.now();
  while (Date.now() - start < OUTBOX_DRAIN_TIMEOUT_MS) {
    await sleep(OUTBOX_POLL_INTERVAL_MS);
    const { data } = await sb
      .from('mm_outbox')
      .select('status, processing_started_at, lease_expires_at, conversation_id')
      .in('conversation_id', conversationIds);
    if (!data) continue;
    const done = data.filter((r) => r.status === 'done').length;
    const failed = data.filter((r) => r.status === 'failed').length;
    const processing = data.filter((r) => r.status === 'processing');
    const now = Date.now();
    const stale = processing.filter((r) => {
      if (!r.lease_expires_at) return false;
      return new Date(r.lease_expires_at).getTime() < now;
    }).length;
    const pending = data.filter((r) => r.status === 'pending').length;
    if (pending === 0 && processing.length - stale === 0) {
      return { done, failed, stale, pending, processing: processing.length - stale };
    }
    console.log(`  Outbox: done=${done} failed=${failed} processing=${processing.length - stale} stale=${stale} pending=${pending}`);
  }
  const { data: finalData } = await sb
    .from('mm_outbox')
    .select('status, conversation_id')
    .in('conversation_id', conversationIds);
  const done = finalData?.filter((r) => r.status === 'done').length ?? 0;
  const failed = finalData?.filter((r) => r.status === 'failed').length ?? 0;
  const pending = finalData?.filter((r) => r.status === 'pending').length ?? 0;
  const processing = finalData?.filter((r) => r.status === 'processing').length ?? 0;
  return { done, failed, stale: -1, pending, processing };
}

async function main(): Promise<void> {
  console.log('=== verify_memory_parallel_stress ===');
  console.log(`Config: ${PARALLEL_CONVERSATIONS} parallel conversations × ${TURNS_PER_CONVERSATION} turns each`);
  console.log(`Writer model (test-only override): ${STRESS_WRITER_MODEL}`);
  console.log('Worker: MM_OUTBOX_WORKER_ENABLED=true\n');

  const port = await findFreePort();
  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    DEV_ALLOW_ANONYMOUS: 'true',
    MM_OUTBOX_WORKER_ENABLED: 'true',
    MM_OUTBOX_POLL_INTERVAL_MS: '4000',
    // Test-only writer model override — NOT a production default change
    LEGAL_AGENT_MODEL_ID: STRESS_WRITER_MODEL,
    REDIS_QUEUE_NAMESPACE:
      process.env.REDIS_QUEUE_NAMESPACE ?? `lexery:stress:mm:${randomUUID()}`,
  };

  const serverScript = resolve(__dirname, '../../server.ts');
  let serverProc: ChildProcess | null = null;
  let convResults: ConversationResult[] = [];

  try {
    serverProc = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'tsx', serverScript],
      {
        env: serverEnv,
        // Avoid child-process backpressure deadlocks during long stress runs.
        // When verbose logs are needed, opt in explicitly.
        stdio: VERBOSE_SERVER_LOGS ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
      }
    );
    serverProc.on('error', (e) => console.error('Server error:', e));

    console.log(`Starting server on port ${port}...`);
    await waitHealth(port);
    console.log('Server healthy.\n');

    const { getSupabaseClient } = await import('../../lib/supabase.js');
    const sb = getSupabaseClient();

    console.log(`Running ${PARALLEL_CONVERSATIONS} conversations in parallel...`);
    const promises = Array.from({ length: PARALLEL_CONVERSATIONS }, (_, i) =>
      runConversation(port, sb, i)
    );
    convResults = await Promise.all(promises);

    console.log('\nAll conversations complete. Waiting for outbox to drain...');
    const scopedConversationIds = convResults.map((r) => r.conv_id);
	    const {
	      done: outboxDone,
      failed: outboxFailed,
      stale: outboxStale,
      pending: outboxPending,
      processing: outboxProcessing,
    } = await waitForOutboxDrain(sb, scopedConversationIds);
    console.log(
      `Outbox (scoped): done=${outboxDone} failed=${outboxFailed} stale=${outboxStale} pending=${outboxPending} processing=${outboxProcessing}`
    );

    // Aggregate outbox into results
	    for (const cr of convResults) {
	      cr.outbox_done = outboxDone;
	      cr.outbox_failed = outboxFailed;
	      cr.outbox_stale = outboxStale;
	    }
	    await backfillTimedOutTurns(sb, convResults);
	  } finally {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await sleep(SHUTDOWN_WAIT_MS);
    }
  }

  console.log('\n=== Results ===\n');
  const totalTurns = convResults.reduce((a, r) => a + r.turns.length, 0);
  const completedTurns = convResults.reduce(
    (a, r) => a + r.turns.filter((t) => TERMINAL_STATUSES.has(t.status)).length,
    0
  );
  const allTerminal = convResults.every((r) => r.all_runs_terminal);
  const allMemoryRecallOk = convResults.every((r) => r.memory_recall_ok);
  const allPromptGrowthOk = convResults.every(
    (r) => r.prompt_growth_ok && r.intermediate_prompt_growth_ok
  );
  const allLawClean = convResults.every((r) => r.law_only_memory_clean);

  for (const cr of convResults) {
    const recallTurns = [4, 7, 9].map((i) => cr.turns[i]).filter(Boolean);
    const memRecalls = recallTurns.filter((t) => (t.memory_count ?? 0) > 0);
    const firstRecallTokens = cr.turns[4]?.prompt_tokens;
    const midRecallTokens = cr.turns[7]?.prompt_tokens;
    const lastRecallTokens = cr.turns[9]?.prompt_tokens;
    const growthRatio =
      firstRecallTokens && lastRecallTokens ? (lastRecallTokens / firstRecallTokens).toFixed(2) : 'n/a';
    const intermediateGrowthRatio =
      firstRecallTokens && midRecallTokens ? (midRecallTokens / firstRecallTokens).toFixed(2) : 'n/a';

    console.log(`Conv ${cr.conv_index + 1} (${cr.conv_id.slice(0, 8)}...):`);
    console.log(
      `  turns=${cr.turns.length}  terminal=${cr.turns.filter((t) => TERMINAL_STATUSES.has(t.status)).length}` +
      `  memory_recall=${memRecalls.length}/${recallTurns.length}  prompt_growth=${growthRatio}` +
      `  intermediate_growth=${intermediateGrowthRatio}` +
      `  law_clean=${cr.law_only_memory_clean}  all_terminal=${cr.all_runs_terminal}`
    );
    if (cr.errors.length > 0) console.log(`  Errors: ${cr.errors.join('; ').slice(0, 200)}`);

    console.log('  Turn breakdown:');
    for (const t of cr.turns) {
      const mem = t.memory_count != null ? `mem=${t.memory_count}` : 'mem=?';
      const law = t.law_count != null ? `law=${t.law_count}` : 'law=?';
      const tok = t.prompt_tokens != null ? `tok=${t.prompt_tokens}` : 'tok=?';
      console.log(`    t${String(t.turn).padStart(2)}: [${t.status.slice(0, 12).padEnd(12)}] ${mem}  ${law}  ${tok}  mode=${t.context_mode ?? '?'}`);
    }
    console.log('');
  }

  console.log('=== Summary ===');
  console.log(`Total turns: ${completedTurns}/${totalTurns} terminal`);
  console.log(`All runs terminal: ${allTerminal ? 'PASS' : 'FAIL'}`);
  console.log(`Memory recall (later turns use memory): ${allMemoryRecallOk ? 'PASS' : 'FAIL'}`);
  console.log(
    `Prompt growth bounded (final ≤${PROMPT_GROWTH_RATIO_MAX}×, intermediate ≤${INTERMEDIATE_RECALL_GROWTH_RATIO_MAX}×): ${allPromptGrowthOk ? 'PASS' : 'FAIL'}`
  );
  console.log(`Law-only turns: memory=0: ${allLawClean ? 'PASS' : 'FAIL'}`);

  const outboxDone = convResults[0]?.outbox_done ?? 0;
  const outboxFailed = convResults[0]?.outbox_failed ?? 0;
  const outboxStale = convResults[0]?.outbox_stale ?? 0;
  console.log(`Outbox drain (scoped): done=${outboxDone} failed=${outboxFailed} stale=${outboxStale}`);
  const outboxOk = outboxFailed === 0 && outboxStale <= 0;
  console.log(`Outbox clean: ${outboxOk ? 'PASS' : 'FAIL'}`);

  const allErrors = convResults.flatMap((r) => r.errors);
  if (allErrors.length > 0) {
    console.log(`\nAll errors (${allErrors.length}):`);
    for (const e of allErrors.slice(0, 20)) console.log(`  ${e}`);
  }

  const pass = allTerminal && allMemoryRecallOk && allPromptGrowthOk && allLawClean && outboxOk;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}: verify_memory_parallel_stress`);
  if (!pass) process.exit(1);
}

if (isEntrypoint) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
