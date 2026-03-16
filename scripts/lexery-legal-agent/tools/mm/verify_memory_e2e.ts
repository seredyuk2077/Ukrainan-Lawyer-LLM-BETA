#!/usr/bin/env node
/**
 * Memory E2E verification: one conversation_id, multiple memory-intent runs.
 * Verifies messages persisted, outbox path, and collects 5-run metrics table.
 *
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_e2e.ts
 * Env: DEV_API_KEY, OPENROUTER_API_KEY_BRAIN or OPENROUTER_API_KEY_ONLINE for real LLM.
 */
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

const MEMORY_E2E_QUERIES = [
  "Що ти пам'ятаєш про мої попередні запити?",
  'Коротко в 3 пунктах згадай лише останні 3 запити в цій розмові',
  'На основі цієї розмови коротко скажи, який у мене зараз головний фокус',
  'З урахуванням того, що ми вже обговорювали, коротко порівняй крадіжку і грабіж за КК України',
  'Чим відрізняється крадіжка від грабежу?',
];

const DEV_TENANT = '00000000-0000-0000-0000-000000000001';
const DEV_USER = '00000000-0000-0000-0000-000000000002';
const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
if (!process.env.DEV_API_KEY) process.env.DEV_API_KEY = DEV_KEY;
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';
if (!process.env.REDIS_QUEUE_NAMESPACE) {
  process.env.REDIS_QUEUE_NAMESPACE = `lexery:verify:mm:${randomUUID()}`;
}
const MIXED_MODE_LAW_MAX_SNIPPETS = Math.max(4, Math.min(20, parseInt(process.env.MIXED_MODE_LAW_MAX_SNIPPETS || '8', 10)));
const LAW_MODE_PROMPT_TOKENS_CEILING = 3200;

export function shouldRetryRunPollFailure(status?: number, error?: unknown): boolean {
  if (typeof status === 'number') {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }
  if (!error) return false;
  if (error instanceof Error) {
    const msg = `${error.name}: ${error.message}`;
    if (/fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg)) return true;
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const causeErr = cause as NodeJS.ErrnoException;
      const causeCode = typeof causeErr.code === 'string' ? causeErr.code : '';
      if (causeCode === 'ECONNRESET' || causeCode === 'ETIMEDOUT' || causeCode === 'UND_ERR_CONNECT_TIMEOUT') {
        return true;
      }
    }
  }
  if (typeof error !== 'object') return false;
  const err = error as NodeJS.ErrnoException;
  const code = typeof err.code === 'string' ? err.code : '';
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT';
}

function shouldRetryVerifierIoError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'string') return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(error);
  if (error instanceof Error) {
    const msg = `${error.name}: ${error.message}`;
    return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg);
  }
  if (typeof error === 'object') {
    const err = error as NodeJS.ErrnoException;
    const code = typeof err.code === 'string' ? err.code : '';
    return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT';
  }
  return false;
}

async function retryVerifierIo<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetryVerifierIoError(error) || i === attempts - 1) {
        throw error instanceof Error ? error : new Error(`${label}: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: unknown retry failure`);
}

async function ensureConversation(conversationId: string): Promise<void> {
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const sb = getSupabaseClient();
  const now = new Date().toISOString();
  const { error: te } = await retryVerifierIo('tenants upsert', () =>
    sb.from('tenants').upsert({ id: DEV_TENANT, name: 'Dev Tenant', settings: {}, updated_at: now }, { onConflict: 'id' })
  );
  if (te && te.code !== '23505') throw new Error(`tenants upsert: ${te.message}`);
  const { error: ce } = await retryVerifierIo('chat_sessions upsert', () =>
    sb.from('chat_sessions').upsert({ id: conversationId, tenant_id: DEV_TENANT, user_id: DEV_USER, updated_at: now }, { onConflict: 'id' })
  );
  if (ce && ce.code !== '23505') throw new Error(`chat_sessions upsert: ${ce.message}`);
}

export interface MemoryE2ERunRow {
  run_id: string;
  query: string;
  /** Where counts came from: source_summary (authoritative), assembled_fallback, or unknown. */
  metrics_source: 'source_summary' | 'assembled_fallback' | 'unknown';
  context_mode: string | null;
  use_memory: boolean;
  use_lldbi: boolean;
  historyCount: number | null;
  memoryCount: number | null;
  lawCount: number | null;
  prompt_tokens: number | null;
  triage_used: boolean | null;
  memory_scope_mode?: string | null;
  memory_fallback_used?: boolean | null;
  /** Fields that were null/unavailable (never fake 0). */
  unknown_fields?: string[];
  /** From search_plan.plan.reason_codes or search_plan.reasons; used to fail on CONTEXT_MODE_UNRESOLVED. */
  search_plan_reason_codes?: string[];
  verdict: string;
}

export interface MemoryE2EReport {
  conversation_id: string;
  runs: MemoryE2ERunRow[];
  messages_count: number | null;
  outbox_inserted: boolean | null;
  outbox_done_count?: number;
  outbox_expected_count?: number;
  outbox_pending_or_processing_at_deadline?: number;
  materialization_ok?: boolean;
  /** When worker_on and outbox inserted but not all current-run rows done in time — cannot claim acceptance. */
  materialization_not_observed?: boolean;
  /** When worker_on and mm_outbox schema check failed; worker cannot process. */
  outbox_lease_schema_missing?: boolean;
  /** Reason code from schema check: MM_OUTBOX_LEASE_SCHEMA_MISSING | MM_OUTBOX_SCHEMA_CHECK_FAILED. */
  outbox_schema_reason_code?: string;
  acceptance_pure_memory_no_law_ok: boolean;
  /** First 3 runs each have context_mode=memory, use_memory=true, use_lldbi=false. */
  acceptance_pure_memory_routing_ok: boolean;
  acceptance_mixed_routing_ok: boolean;
  /** Mixed run has at least one law snippet (no false green without evidence). */
  acceptance_mixed_law_presence_ok: boolean;
  /** Law run has at least one law snippet. */
  acceptance_law_law_presence_ok: boolean;
  acceptance_mixed_law_budget_ok: boolean | null;
  /** No run used CONTEXT_MODE_UNRESOLVED route. */
  acceptance_no_context_mode_unresolved: boolean;
  acceptance_law_count_ok: boolean;
  /** Hard gate: mixed run prompt_tokens non-null and <= ceiling. */
  acceptance_mixed_prompt_tokens_ok: boolean;
  /** Hard gate: law run prompt_tokens non-null and <= ceiling. */
  acceptance_law_prompt_tokens_ok: boolean;
  /** Hard gate: law run use_memory=false and memoryCount=0. */
  acceptance_plan_assembly_memory_consistency_ok: boolean;
  /** Diagnostic only (p50 across 5 runs). */
  acceptance_prompt_tokens_p50_ok: boolean | null;
  metrics_available: boolean;
}

/** Exported for unit tests: law presence and CONTEXT_MODE_UNRESOLVED acceptance from run rows. */
export function computeLawPresenceAndUnresolvedAcceptance(runs: MemoryE2ERunRow[]): {
  acceptance_mixed_law_presence_ok: boolean;
  acceptance_law_law_presence_ok: boolean;
  acceptance_no_context_mode_unresolved: boolean;
} {
  const mixedRun = runs[3];
  const lawRun = runs[4];
  return {
    acceptance_mixed_law_presence_ok: mixedRun != null && (mixedRun.lawCount ?? 0) >= 1,
    acceptance_law_law_presence_ok: lawRun != null && (lawRun.lawCount ?? 0) >= 1,
    acceptance_no_context_mode_unresolved: !runs.some((r) =>
      r.search_plan_reason_codes?.includes('CONTEXT_MODE_UNRESOLVED')
    ),
  };
}

async function runMemoryE2E(conversationId: string): Promise<MemoryE2EReport> {
  const verify_start_ts = new Date().toISOString();
  await ensureConversation(conversationId);
  const { start } = await import('../../server.js');
  const { port } = await start(0);
  const base = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Dev-API-Key': DEV_KEY,
  };
  const getHeaders = { ...headers };
  delete (getHeaders as Record<string, string>)['Content-Type'];

  const runs: MemoryE2ERunRow[] = [];

  for (const query of MEMORY_E2E_QUERIES) {
    const created = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        tenant_id: DEV_TENANT,
        user_id: DEV_USER,
        conversation_id: conversationId,
        dry_run: false,
      }),
    });
    if (!created.ok) {
      const text = await created.text();
      throw new Error(`POST /v1/runs failed: ${created.status} ${text}`);
    }
    const { run_id } = (await created.json()) as { run_id: string };
    const startWall = Date.now();
    let run: Record<string, unknown> | null = null;
    while (Date.now() - startWall < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const getRes = await fetch(`${base}/v1/runs/${run_id}?include_snapshot=true`, { headers: getHeaders });
        if (!getRes.ok) {
          if (shouldRetryRunPollFailure(getRes.status)) continue;
          throw new Error(`GET /v1/runs/:id failed: ${getRes.status}`);
        }
        run = (await getRes.json()) as Record<string, unknown>;
      } catch (err) {
        if (shouldRetryRunPollFailure(undefined, err)) continue;
        throw err;
      }
      const status = run?.status as string;
      if (status === 'completed' || status === 'failed') break;
    }
    if (!run || ((run.status as string) !== 'completed' && (run.status as string) !== 'failed')) {
      runs.push({
        run_id,
        query,
        metrics_source: 'unknown',
        context_mode: null,
        use_memory: false,
        use_lldbi: false,
        historyCount: null,
        memoryCount: null,
        lawCount: null,
        prompt_tokens: null,
        triage_used: null,
        unknown_fields: ['historyCount', 'memoryCount', 'lawCount', 'context_mode', 'prompt_tokens', 'triage_used'],
        verdict: 'timeout',
      });
      continue;
    }

    const qp = run.query_profile as { routing_flags?: { context_mode?: string } } | undefined;
    const sp = run.search_plan as
      | { sources?: { use_memory?: boolean; use_lldbi?: boolean }; plan?: { sources?: { use_memory?: boolean; use_lldbi?: boolean } } }
      | undefined;
    const llm = run.llm_result as { usage?: { prompt_tokens?: number }; triage_used?: boolean } | undefined;

    let historyCount: number | null = null;
    let memoryCount: number | null = null;
    let lawCount: number | null = null;
    let context_mode: string | null = qp?.routing_flags?.context_mode ?? null;
    let prompt_tokens: number | null = llm?.usage?.prompt_tokens ?? null;
    let triage_used: boolean | null = llm?.triage_used ?? null;
    let memory_scope_mode: string | null | undefined;
    let memory_fallback_used: boolean | null | undefined;
    let metrics_source: 'source_summary' | 'assembled_fallback' | 'unknown' = 'unknown';
    const unknown_fields: string[] = [];
    try {
      const { RunRepository } = await import('../../gateway/storage.js');
      const repo = new RunRepository();
      const dbRun = await repo.findByRunId(run_id);
      const snapshot = dbRun?.snapshot as {
        source_summary?: {
          context_mode?: string | null;
          history_count?: number | null;
          memory_count?: number | null;
          law_count?: number | null;
          prompt_tokens?: number | null;
          triage_used?: boolean | null;
          memory_scope_mode?: string | null;
          memory_fallback_used?: boolean | null;
        };
        u10_selection?: {
          triage_used?: boolean | null;
        };
      } | undefined;
      const src = snapshot?.source_summary;
      const snapshotTriageUsed = snapshot?.u10_selection?.triage_used;
      if (src && typeof src === 'object') {
        metrics_source = 'source_summary';
        if (typeof src.history_count === 'number') historyCount = src.history_count;
        else if (src.history_count === null) historyCount = null;
        else unknown_fields.push('history_count');
        if (typeof src.memory_count === 'number') memoryCount = src.memory_count;
        else if (src.memory_count === null) memoryCount = null;
        else unknown_fields.push('memory_count');
        if (typeof src.law_count === 'number') lawCount = src.law_count;
        else if (src.law_count === null) lawCount = null;
        else unknown_fields.push('law_count');
        if (src.context_mode !== undefined) context_mode = src.context_mode ?? null;
        else unknown_fields.push('context_mode');
        if (typeof src.prompt_tokens === 'number') prompt_tokens = src.prompt_tokens;
        else if (src.prompt_tokens === null) prompt_tokens = null;
        else unknown_fields.push('prompt_tokens');
        if (typeof src.triage_used === 'boolean') triage_used = src.triage_used;
        else if (src.triage_used === null) triage_used = null;
        else if (typeof snapshotTriageUsed === 'boolean' || snapshotTriageUsed === null) triage_used = snapshotTriageUsed ?? null;
        else unknown_fields.push('triage_used');
        memory_scope_mode = src.memory_scope_mode ?? undefined;
        memory_fallback_used = src.memory_fallback_used ?? undefined;
      } else {
        memory_scope_mode = undefined;
        memory_fallback_used = undefined;
        const assembled = dbRun?.assembled_prompt as {
          sources?: { lawCount?: number; memoryCount?: number; historyCount?: number };
          meta?: { sources?: { lawCount?: number; memoryCount?: number; historyCount?: number } };
        } | undefined;
        const meta = assembled?.sources ?? assembled?.meta?.sources;
        if (meta && typeof meta === 'object') {
          metrics_source = 'assembled_fallback';
          historyCount = typeof meta.historyCount === 'number' ? meta.historyCount : null;
          memoryCount = typeof meta.memoryCount === 'number' ? meta.memoryCount : null;
          lawCount = typeof meta.lawCount === 'number' ? meta.lawCount : null;
          if (historyCount === null) unknown_fields.push('historyCount');
          if (memoryCount === null) unknown_fields.push('memoryCount');
          if (lawCount === null) unknown_fields.push('lawCount');
        } else {
          unknown_fields.push('historyCount', 'memoryCount', 'lawCount');
        }
      }
    } catch {
      unknown_fields.push('historyCount', 'memoryCount', 'lawCount', 'context_mode', 'prompt_tokens', 'triage_used');
    }

    const spAudit = run.search_plan as { plan?: { reason_codes?: string[] }; reasons?: string[] } | undefined;
    const search_plan_reason_codes: string[] | undefined = Array.isArray(spAudit?.plan?.reason_codes)
      ? spAudit.plan.reason_codes
      : Array.isArray(spAudit?.reasons)
        ? spAudit.reasons
        : undefined;

    runs.push({
      run_id,
      query,
      metrics_source,
      context_mode,
      use_memory: sp?.plan?.sources?.use_memory ?? sp?.sources?.use_memory ?? false,
      use_lldbi: sp?.plan?.sources?.use_lldbi ?? sp?.sources?.use_lldbi ?? false,
      historyCount,
      memoryCount,
      lawCount,
      prompt_tokens,
      triage_used,
      memory_scope_mode,
      memory_fallback_used,
      unknown_fields: unknown_fields.length ? unknown_fields : undefined,
      search_plan_reason_codes: search_plan_reason_codes?.length ? search_plan_reason_codes : undefined,
      verdict: run.status as string,
    });
  }

  let messages_count: number | null = null;
  let outbox_inserted: boolean | null = null;
  try {
    const { RunRepository } = await import('../../gateway/storage.js');
    const { getSupabaseClient } = await import('../../lib/supabase.js');
    const repo = new RunRepository();
    const msgList = await repo.listConversationMessages(conversationId, 50);
    messages_count = msgList?.length ?? null;
    const sb = getSupabaseClient();
    const { data: outboxRows } = await sb.from('mm_outbox').select('id').eq('conversation_id', conversationId).limit(1);
    outbox_inserted = Array.isArray(outboxRows) && outboxRows.length > 0;
  } catch {
    // optional
  }

  const memoryIntentRuns = runs.filter((_r, i) => i < 4);
  const pureMemoryRuns = runs.slice(0, 3);
  const mixedRun = runs[3];
  const pureMemoryLawCounts = pureMemoryRuns.map((r) => r.lawCount);
  const allPureMemoryLawCountsAvailable = pureMemoryLawCounts.every((c) => c !== null && c !== undefined);
  const acceptance_pure_memory_no_law_ok =
    allPureMemoryLawCountsAvailable && pureMemoryRuns.every((r) => (r.lawCount ?? -1) === 0);
  const acceptance_pure_memory_routing_ok = pureMemoryRuns.every(
    (r) => r.context_mode === 'memory' && r.use_memory === true && r.use_lldbi === false
  );
  const acceptance_mixed_routing_ok =
    mixedRun != null &&
    mixedRun.context_mode === 'mixed' &&
    mixedRun.use_memory === true &&
    mixedRun.use_lldbi === true;
  const lawRun = runs[4];
  const acceptance_mixed_law_presence_ok =
    mixedRun != null && (mixedRun.lawCount ?? 0) >= 1;
  const acceptance_law_law_presence_ok =
    lawRun != null && (lawRun.lawCount ?? 0) >= 1;
  const acceptance_no_context_mode_unresolved = !runs.some(
    (r) => r.search_plan_reason_codes?.includes('CONTEXT_MODE_UNRESOLVED')
  );
  const acceptance_mixed_law_budget_ok =
    mixedRun?.lawCount != null ? mixedRun.lawCount <= MIXED_MODE_LAW_MAX_SNIPPETS : null;
  const acceptance_law_run_budget_ok =
    lawRun?.lawCount != null ? lawRun.lawCount <= MIXED_MODE_LAW_MAX_SNIPPETS : null;
  const acceptance_mixed_prompt_tokens_ok =
    mixedRun?.prompt_tokens != null && mixedRun.prompt_tokens <= LAW_MODE_PROMPT_TOKENS_CEILING;
  const acceptance_law_prompt_tokens_ok =
    lawRun?.prompt_tokens != null && lawRun.prompt_tokens <= LAW_MODE_PROMPT_TOKENS_CEILING;
  const acceptance_plan_assembly_memory_consistency_ok =
    lawRun != null && lawRun.use_memory === false && (lawRun.memoryCount ?? 0) === 0;
  const acceptance_law_count_ok =
    acceptance_pure_memory_no_law_ok &&
    acceptance_mixed_law_presence_ok &&
    acceptance_law_law_presence_ok &&
    acceptance_mixed_law_budget_ok === true &&
    acceptance_law_run_budget_ok === true &&
    acceptance_mixed_prompt_tokens_ok &&
    acceptance_law_prompt_tokens_ok &&
    acceptance_plan_assembly_memory_consistency_ok &&
    acceptance_no_context_mode_unresolved;
  const tokens = runs.map((r) => r.prompt_tokens).filter((t): t is number => t != null);
  const p50 = tokens.length ? tokens.sort((a, b) => a - b)[Math.floor(tokens.length * 0.5)] : null;
  const acceptance_prompt_tokens_p50_ok = p50 != null ? p50 <= 3000 : null;
  const metrics_available = memoryIntentRuns.every(
    (r) => r.lawCount !== null && r.memoryCount !== null && r.historyCount !== null
  );

  let outbox_done_count: number | undefined;
  let materialization_ok: boolean | undefined;
  let outbox_expected_count: number | undefined;
  let outbox_pending_or_processing_at_deadline: number | undefined;
  const workerOn = process.env.MM_OUTBOX_WORKER_ENABLED === 'true';
  let outbox_lease_schema_missing: boolean | undefined;
  let outbox_schema_reason_code: string | undefined;
  if (workerOn && outbox_inserted) {
    const { checkMmOutboxLeaseSchema } = await import('../../mm/outboxSchema.js');
    const { getSupabaseClient } = await import('../../lib/supabase.js');
    const schemaCheck = await checkMmOutboxLeaseSchema();
    if (!schemaCheck.ready) {
      outbox_lease_schema_missing = true;
      outbox_schema_reason_code = schemaCheck.reason_code;
      materialization_ok = false;
      outbox_done_count = 0;
      const sb = getSupabaseClient();
      const { data: outboxRows } = await sb
        .from('mm_outbox')
        .select('id')
        .eq('conversation_id', conversationId)
        .gte('created_at', verify_start_ts);
      outbox_expected_count = Array.isArray(outboxRows) ? outboxRows.length : MEMORY_E2E_QUERIES.length;
    }
    if (!outbox_lease_schema_missing) {
    const sb = getSupabaseClient();
    const deadline = Date.now() + 45_000;
    const pollMs = 2_000;
    while (Date.now() < deadline) {
      const { data: currentRows } = await sb
        .from('mm_outbox')
        .select('id, status')
        .eq('conversation_id', conversationId)
        .gte('created_at', verify_start_ts);
      const rows = (currentRows ?? []) as Array<{ id: string; status: string }>;
      const expected_count = rows.length;
      if (expected_count > 0) {
        const doneCount = rows.filter((r) => r.status === 'done').length;
        const pendingOrProc = rows.filter((r) => r.status === 'pending' || r.status === 'processing').length;
        if (pendingOrProc === 0 && doneCount === expected_count) {
          outbox_done_count = doneCount;
          outbox_expected_count = expected_count;
          materialization_ok = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (materialization_ok === undefined) {
      const { data: finalRows } = await sb
        .from('mm_outbox')
        .select('id, status')
        .eq('conversation_id', conversationId)
        .gte('created_at', verify_start_ts);
      const final = (finalRows ?? []) as Array<{ id: string; status: string }>;
      outbox_expected_count = final.length;
      outbox_done_count = final.filter((r) => r.status === 'done').length;
      outbox_pending_or_processing_at_deadline = final.filter(
        (r) => r.status === 'pending' || r.status === 'processing'
      ).length;
      materialization_ok = false;
    }
    }
  }

  const materialization_not_observed = workerOn && outbox_inserted === true && materialization_ok === false && !outbox_lease_schema_missing;

  return {
    conversation_id: conversationId,
    runs,
    messages_count,
    outbox_inserted,
    outbox_done_count,
    outbox_expected_count,
    outbox_pending_or_processing_at_deadline,
    materialization_ok,
    materialization_not_observed: materialization_not_observed || undefined,
    outbox_lease_schema_missing: outbox_lease_schema_missing || undefined,
    outbox_schema_reason_code: outbox_schema_reason_code || undefined,
    acceptance_pure_memory_no_law_ok,
    acceptance_pure_memory_routing_ok,
    acceptance_mixed_routing_ok,
    acceptance_mixed_law_presence_ok,
    acceptance_law_law_presence_ok,
    acceptance_no_context_mode_unresolved,
    acceptance_mixed_law_budget_ok,
    acceptance_law_count_ok,
    acceptance_mixed_prompt_tokens_ok,
    acceptance_law_prompt_tokens_ok,
    acceptance_plan_assembly_memory_consistency_ok,
    acceptance_prompt_tokens_p50_ok,
    metrics_available,
  };
}

async function main(): Promise<void> {
  const conversationId = randomUUID();
  console.log('Memory E2E: conversation_id=', conversationId);
  const report = await runMemoryE2E(conversationId);
  console.log(JSON.stringify(report, null, 2));
  console.log('\n--- 5 runs table ---');
  console.log('run_id|query|metrics_source|context_mode|memory_scope_mode|use_memory|use_lldbi|historyCount|memoryCount|lawCount|prompt_tokens|triage_used|unknown_fields|verdict');
  for (const r of report.runs) {
    console.log(
      [
        r.run_id,
        r.query.slice(0, 40),
        r.metrics_source,
        r.context_mode,
        r.memory_scope_mode ?? '',
        r.use_memory,
        r.use_lldbi,
        r.historyCount,
        r.memoryCount,
        r.lawCount,
        r.prompt_tokens ?? '',
        r.triage_used ?? '',
        r.unknown_fields?.join(';') ?? '',
        r.verdict,
      ].join('|')
    );
  }
  if (report.materialization_ok !== undefined) {
    console.log(
      'Worker-on: outbox_done_count=',
      report.outbox_done_count,
      'outbox_expected_count=',
      report.outbox_expected_count,
      'materialization_ok=',
      report.materialization_ok
    );
  }
  if (report.outbox_lease_schema_missing) {
    const code = report.outbox_schema_reason_code ?? 'MM_OUTBOX_SCHEMA_CHECK_FAILED';
    console.error(`FAIL: ${code} — mm_outbox schema check failed (run migration 20260306100000_mm_outbox_lease.sql for lease columns). Worker cannot process.`);
    process.exit(1);
  }
  if (report.materialization_not_observed) {
    console.error(
      'FAIL: worker_on but not all current-run outbox rows done (outbox_expected=',
      report.outbox_expected_count,
      'done=',
      report.outbox_done_count,
      'pending_or_processing=',
      report.outbox_pending_or_processing_at_deadline,
      ').'
    );
    process.exit(1);
  }
  console.log('\nMetrics available (no false 0):', report.metrics_available);
  console.log('Acceptance pure memory lawCount=0 in 3/3:', report.acceptance_pure_memory_no_law_ok);
  console.log('Acceptance mixed routing uses memory+law:', report.acceptance_mixed_routing_ok);
  console.log('Acceptance mixed law presence (lawCount>=1):', report.acceptance_mixed_law_presence_ok);
  console.log('Acceptance law law presence (lawCount>=1):', report.acceptance_law_law_presence_ok);
  console.log('Acceptance no CONTEXT_MODE_UNRESOLVED:', report.acceptance_no_context_mode_unresolved);
  console.log(`Acceptance mixed lawCount<=${MIXED_MODE_LAW_MAX_SNIPPETS}:`, report.acceptance_mixed_law_budget_ok);
  console.log(`Acceptance mixed prompt_tokens<=${LAW_MODE_PROMPT_TOKENS_CEILING}:`, report.acceptance_mixed_prompt_tokens_ok);
  console.log(`Acceptance law prompt_tokens<=${LAW_MODE_PROMPT_TOKENS_CEILING}:`, report.acceptance_law_prompt_tokens_ok);
  console.log('Acceptance law use_memory=false & memoryCount=0:', report.acceptance_plan_assembly_memory_consistency_ok);
  console.log('Diagnostic p50 prompt_tokens:', report.acceptance_prompt_tokens_p50_ok);
  if (!report.metrics_available) {
    console.error('FAIL: Cannot claim acceptance — some run metrics were unavailable (null).');
    process.exit(1);
  }
  if (!report.acceptance_pure_memory_no_law_ok) {
    console.error('FAIL: pure memory queries still pulled law context.');
    process.exit(1);
  }
  if (!report.acceptance_pure_memory_routing_ok) {
    console.error('FAIL: first 3 runs must each have context_mode=memory, use_memory=true, use_lldbi=false.');
    process.exit(1);
  }
  if (!report.acceptance_mixed_routing_ok) {
    console.error('FAIL: mixed query did not stay on memory+law route.');
    process.exit(1);
  }
  if (!report.acceptance_mixed_law_presence_ok) {
    console.error('FAIL: mixed run must have lawCount>=1 (actual law evidence required).');
    process.exit(1);
  }
  if (!report.acceptance_law_law_presence_ok) {
    console.error('FAIL: law run must have lawCount>=1 (actual law evidence required).');
    process.exit(1);
  }
  if (!report.acceptance_no_context_mode_unresolved) {
    console.error('FAIL: at least one run used CONTEXT_MODE_UNRESOLVED route; cannot count as clean acceptance.');
    process.exit(1);
  }
  if (report.acceptance_mixed_law_budget_ok === false) {
    console.error('FAIL: mixed query exceeded law snippet budget.');
    process.exit(1);
  }
  if (!report.acceptance_mixed_prompt_tokens_ok) {
    console.error('FAIL: mixed run prompt_tokens null or exceed ceiling.');
    process.exit(1);
  }
  if (!report.acceptance_law_prompt_tokens_ok) {
    console.error('FAIL: law run prompt_tokens null or exceed ceiling.');
    process.exit(1);
  }
  if (!report.acceptance_plan_assembly_memory_consistency_ok) {
    console.error('FAIL: law run must have use_memory=false and memoryCount=0.');
    process.exit(1);
  }
  if (report.acceptance_law_count_ok === false) {
    console.error('FAIL: law run acceptance (budget or prompt_tokens or plan consistency) failed.');
    process.exit(1);
  }
  process.exit(0);
}

const isEntry = typeof process !== 'undefined' && process.argv[1] != null && /verify_memory_e2e\.(ts|js)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
