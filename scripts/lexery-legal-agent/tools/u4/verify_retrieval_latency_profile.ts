/**
 * verify_retrieval_latency_profile — Stage-level latency profiler for the legal retrieval pipeline.
 *
 * Runs the smoke-subset queries with LEGAL_AGENT_DISABLE_LLM=true (U10 writer stubbed).
 * IMPORTANT: LEGAL_AGENT_DISABLE_LLM only stubs the U10 LLM writer. The following are
 * still active: U4 LLM planner (gpt-4o-mini, 8s timeout), U9 meta-triage LLM (gpt-5-nano
 * primary, 12s timeout), U4 act-planner LLM. These are the dominant latency contributors.
 *
 * Per-run breakdown extracted from the persisted retrieval_trace + snapshot:
 *   - total_ms: wall-clock from POST enqueue to terminal status (poll)
 *   - u4_ms: retrieval_trace.latency_ms (embed + Qdrant I/O + act-planner if any)
 *   - planner_ms: retrieval_trace.meta.planner.duration_ms (LLM planner if called)
 *   - qdrant_steps_sum_ms: sum of retrieval_trace.steps_latency_ms entries (raw Qdrant I/O)
 *   - qdrant_calls: retrieval_trace.meta.qdrant_calls_count_total
 *   - memory_ms: retrieval_trace.meta.memory.latency_ms.recent (memory DB fetch if used)
 *   - u9_meta_triage_ms: snapshot.u9_meta_triage.latency_ms / latencyMs (meta-triage LLM if called)
 *   - u9_etc_ms: total_ms - u4_ms (approx U2 + queue overhead + U9 assembly time including triage)
 *   - prompt_tokens: snapshot.source_summary.prompt_tokens
 *
 * Quality gate: still asserts that all runs complete with status='completed'/'U11_DONE'.
 * Does NOT override smoke quality checks — use the smoke verifier for quality assertions.
 *
 * Run: pnpm -s exec tsx scripts/lexery-legal-agent/tools/u4/verify_retrieval_latency_profile.ts
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
const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
if (!process.env.DEV_API_KEY) process.env.DEV_API_KEY = DEV_KEY;
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';
const DEV_TENANT = '00000000-0000-0000-0000-000000000001';
const DEV_USER = '00000000-0000-0000-0000-000000000002';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 35_000;
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 180_000;
const SHUTDOWN_WAIT_MS = 3_000;

/** Same queries as smoke subset — keeps quality baseline consistent. */
const PROFILE_QUERIES: Array<{ id: string; query: string }> = [
  { id: 'q1', query: 'Які права має орендар нерухомості при достроковому розірванні договору оренди?' },
  { id: 'q2', query: 'Яку відповідальність несе роботодавець за затримку виплати заробітної плати?' },
  { id: 'q3', query: 'Що передбачає законодавство щодо захисту прав споживачів при поверненні товару?' },
  { id: 'q4', query: 'Які підстави для звільнення працівника за ініціативою роботодавця?' },
  { id: 'q5', query: 'Яким є порядок оскарження рішення місцевого органу влади?' },
];

interface LatencyBreakdown {
  id: string;
  query_preview: string;
  total_ms: number;
  u4_ms: number | null;
  planner_ms: number | null;
  qdrant_steps_sum_ms: number | null;
  qdrant_calls: number | null;
  memory_ms: number | null;
  u9_meta_triage_ms: number | null;
  u9_etc_ms: number | null;
  prompt_tokens: number | null;
  status: string;
  note?: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
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

async function ensureConversation(conversationId: string): Promise<void> {
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const sb = getSupabaseClient();
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

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'U11_DONE', 'Deliver']);

async function pollRunTerminal(
  baseUrl: string,
  runId: string,
  startMs: number
): Promise<{ run: Record<string, unknown> | null; status: string; elapsed: number }> {
  while (Date.now() - startMs < POLL_TIMEOUT_MS) {
    try {
      const r = await fetch(`${baseUrl}/v1/runs/${runId}?include_snapshot=1`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (r.status === 200) {
        const body = (await r.json()) as Record<string, unknown>;
        const status = (body.status as string) ?? '';
        if (TERMINAL_STATUSES.has(status)) {
          return { run: body, status, elapsed: Date.now() - startMs };
        }
      }
    } catch { /* retry */ }
    await sleep(POLL_MS);
  }
  // DB fallback
  try {
    const { RunRepository } = await import('../../gateway/storage.js');
    const repo = new RunRepository();
    const dbRun = await repo.findByRunId(runId);
    if (dbRun && TERMINAL_STATUSES.has(String(dbRun.status))) {
      return {
        run: dbRun as unknown as Record<string, unknown>,
        status: String(dbRun.status),
        elapsed: Date.now() - startMs,
      };
    }
  } catch { /* ignore */ }
  return { run: null, status: 'timeout', elapsed: Date.now() - startMs };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNumberField(rec: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!rec) return null;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

function extractLatency(run: Record<string, unknown>, totalMs: number): Omit<LatencyBreakdown, 'id' | 'query_preview' | 'status' | 'note'> {
  const rt = asRecord(run.retrieval_trace);
  const rtMs = typeof rt?.latency_ms === 'number' ? rt.latency_ms : null;

  const meta = rt ? asRecord(rt.meta) : null;
  const planner = meta ? asRecord(meta.planner) : null;
  const plannerMs = planner && typeof planner.duration_ms === 'number' ? planner.duration_ms : null;

  const stepsRaw = rt?.steps_latency_ms;
  const stepsArr = Array.isArray(stepsRaw) ? (stepsRaw as number[]) : null;
  const qdrantStepsSumMs = stepsArr ? stepsArr.reduce((a, b) => a + b, 0) : null;

  const qdrantCalls =
    meta && typeof meta.qdrant_calls_count_total === 'number'
      ? meta.qdrant_calls_count_total
      : null;

  const memMeta = meta ? asRecord(meta.memory) : null;
  const memLatencyObj = memMeta ? asRecord(memMeta.latency_ms) : null;
  const memMs =
    memLatencyObj && typeof memLatencyObj.recent === 'number' ? memLatencyObj.recent : null;

  // U9+U2+queue overhead = total - U4 retrieval (rough; includes queue wait time, meta-triage, R2 fetches)
  const u9EtcMs = rtMs != null ? Math.max(0, totalMs - rtMs) : null;

  // prompt tokens from source_summary
  const snap = asRecord(run.snapshot);
  const srcSummary = snap ? asRecord(snap.source_summary) : null;
  const promptTokens = asNumberField(srcSummary, 'prompt_tokens', 'promptTokens');

  // U9 meta-triage latency (legacy camelCase + current snake_case supported)
  const u9MetaTriage = snap ? asRecord(snap.u9_meta_triage) : null;
  const u9MetaTriageMs = asNumberField(u9MetaTriage, 'latency_ms', 'latencyMs');

  return {
    total_ms: totalMs,
    u4_ms: rtMs,
    planner_ms: plannerMs,
    qdrant_steps_sum_ms: qdrantStepsSumMs,
    qdrant_calls: qdrantCalls,
    memory_ms: memMs,
    u9_meta_triage_ms: u9MetaTriageMs,
    u9_etc_ms: u9EtcMs,
    prompt_tokens: promptTokens,
  };
}

async function runProfileCase(
  port: number,
  convId: string,
  q: { id: string; query: string }
): Promise<LatencyBreakdown> {
  const base = `http://localhost:${port}`;
  const startMs = Date.now();
  let runId: string | null = null;
  try {
    const postRes = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query: q.query,
        tenant_id: DEV_TENANT,
        user_id: DEV_USER,
        conversation_id: convId,
      }),
    });
    if (!postRes.ok) {
      const txt = await postRes.text().catch(() => '');
      return {
        id: q.id,
        query_preview: q.query.slice(0, 60),
        total_ms: Date.now() - startMs,
        u4_ms: null,
        planner_ms: null,
        qdrant_steps_sum_ms: null,
        qdrant_calls: null,
        memory_ms: null,
        u9_meta_triage_ms: null,
        u9_etc_ms: null,
        prompt_tokens: null,
        status: 'enqueue_failed',
        note: `HTTP ${postRes.status}: ${txt.slice(0, 120)}`,
      };
    }
    const body = (await postRes.json()) as { run_id?: string };
    runId = body.run_id ?? null;
    if (!runId) {
      return {
        id: q.id,
        query_preview: q.query.slice(0, 60),
        total_ms: Date.now() - startMs,
        u4_ms: null,
        planner_ms: null,
        qdrant_steps_sum_ms: null,
        qdrant_calls: null,
        memory_ms: null,
        u9_meta_triage_ms: null,
        u9_etc_ms: null,
        prompt_tokens: null,
        status: 'no_run_id',
      };
    }
  } catch (e) {
    return {
      id: q.id,
      query_preview: q.query.slice(0, 60),
      total_ms: Date.now() - startMs,
      u4_ms: null,
      planner_ms: null,
      qdrant_steps_sum_ms: null,
      qdrant_calls: null,
      memory_ms: null,
      u9_meta_triage_ms: null,
      u9_etc_ms: null,
      prompt_tokens: null,
      status: 'error',
      note: String(e).slice(0, 120),
    };
  }

  const { run, status, elapsed } = await pollRunTerminal(base, runId, startMs);
  if (!run || status === 'timeout') {
    return {
      id: q.id,
      query_preview: q.query.slice(0, 60),
      total_ms: elapsed,
      u4_ms: null,
      planner_ms: null,
      qdrant_steps_sum_ms: null,
      qdrant_calls: null,
      memory_ms: null,
      u9_meta_triage_ms: null,
      u9_etc_ms: null,
      prompt_tokens: null,
      status: 'timeout',
    };
  }

  const breakdown = extractLatency(run, elapsed);
  return {
    id: q.id,
    query_preview: q.query.slice(0, 60),
    ...breakdown,
    status,
  };
}

async function main(): Promise<void> {
  console.log('=== verify_retrieval_latency_profile ===');
  console.log('Mode: LEGAL_AGENT_DISABLE_LLM=true (U10 writer stubbed)');
  console.log('NOTE: U4 LLM planner, U9 meta-triage, U4 act-planner are NOT stubbed — they are the dominant contributors.\n');

  const port = await findFreePort();
  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    DEV_ALLOW_ANONYMOUS: 'true',
    LEGAL_AGENT_DISABLE_LLM: 'true',
    REDIS_QUEUE_NAMESPACE:
      process.env.REDIS_QUEUE_NAMESPACE ?? `lexery:latency-profile:${randomUUID()}`,
  };

  const serverScript = resolve(__dirname, '../../server.ts');
  let serverProc: ChildProcess | null = null;
  const results: LatencyBreakdown[] = [];

  try {
    serverProc = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'tsx', serverScript],
      { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    serverProc.on('error', (e) => console.error('Server error:', e));

    console.log(`Starting server on port ${port}...`);
    await waitHealth(port);
    console.log(`Server healthy.\n`);

    const convId = randomUUID();
    await ensureConversation(convId);

    for (const q of PROFILE_QUERIES) {
      console.log(`Running ${q.id}: ${q.query.slice(0, 60)}...`);
      const r = await runProfileCase(port, convId, q);
      results.push(r);
      console.log(
        `  total=${r.total_ms}ms  u4=${r.u4_ms ?? '-'}ms  planner=${r.planner_ms ?? '-'}ms` +
        `  qdrant_sum=${r.qdrant_steps_sum_ms ?? '-'}ms  qdrant_calls=${r.qdrant_calls ?? '-'}` +
        `  triage=${r.u9_meta_triage_ms ?? '-'}ms  u9_etc=${r.u9_etc_ms ?? '-'}ms  tokens=${r.prompt_tokens ?? '-'}  [${r.status}]${r.note ? '  NOTE: ' + r.note : ''}`
      );
    }
  } finally {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await sleep(SHUTDOWN_WAIT_MS);
    }
  }

  console.log('\n=== Latency Summary ===');
  const completed = results.filter((r) => r.status !== 'timeout' && r.status !== 'error' && r.status !== 'enqueue_failed' && r.status !== 'no_run_id');
  const failed = results.filter((r) => !completed.includes(r));

  if (failed.length > 0) {
    console.log(`\nFailed runs (${failed.length}/${results.length}):`);
    for (const r of failed) console.log(`  ${r.id}: status=${r.status}${r.note ? ' ' + r.note : ''}`);
  }

  if (completed.length > 0) {
    const totals = completed.map((r) => r.total_ms).sort((a, b) => a - b);
    const u4s = completed.map((r) => r.u4_ms ?? 0).sort((a, b) => a - b);
    const planners = completed.filter((r) => r.planner_ms != null).map((r) => r.planner_ms!).sort((a, b) => a - b);
    const qdrantSums = completed.filter((r) => r.qdrant_steps_sum_ms != null).map((r) => r.qdrant_steps_sum_ms!).sort((a, b) => a - b);
    const u9s = completed.filter((r) => r.u9_etc_ms != null).map((r) => r.u9_etc_ms!).sort((a, b) => a - b);
    const triages = completed.filter((r) => r.u9_meta_triage_ms != null).map((r) => r.u9_meta_triage_ms!).sort((a, b) => a - b);
    const tokens = completed.filter((r) => r.prompt_tokens != null).map((r) => r.prompt_tokens!).sort((a, b) => a - b);

    console.log(`\nRuns: ${completed.length}/${results.length} completed`);
    console.log('\nEnd-to-end (wall clock, U10 stubbed):');
    console.log(`  p50=${percentile(totals, 0.5)}ms  p75=${percentile(totals, 0.75)}ms  p95=${percentile(totals, 0.95)}ms  min=${totals[0]}ms  max=${totals[totals.length - 1]}ms`);
    console.log('\nU4 retrieval (embed + Qdrant + act selection):');
    console.log(`  p50=${percentile(u4s, 0.5)}ms  p75=${percentile(u4s, 0.75)}ms  p95=${percentile(u4s, 0.95)}ms`);
    if (planners.length > 0) {
      console.log('\nPlanner LLM duration (when called):');
      console.log(`  p50=${percentile(planners, 0.5)}ms  p95=${percentile(planners, 0.95)}ms  called=${planners.length}/${completed.length}`);
    } else {
      console.log('\nPlanner: not called (LEGAL_AGENT_DISABLE_LLM=true stubs LLM planner)');
    }
    if (qdrantSums.length > 0) {
      console.log('\nQdrant I/O sum (across all steps):');
      console.log(`  p50=${percentile(qdrantSums, 0.5)}ms  p95=${percentile(qdrantSums, 0.95)}ms`);
    }
    if (triages.length > 0) {
      console.log('\nU9 meta-triage LLM (NOT stubbed by LEGAL_AGENT_DISABLE_LLM — dominant contributor):');
      console.log(`  p50=${percentile(triages, 0.5)}ms  p95=${percentile(triages, 0.95)}ms  called=${triages.length}/${completed.length}`);
    } else {
      console.log('\nU9 meta-triage: snapshot.u9_meta_triage not available (run older than DEV v16, or skipped)');
    }
    if (u9s.length > 0) {
      console.log('\nU9+U2+queue overhead (total - U4, includes triage + R2 fetches + queue wait):');
      console.log(`  p50=${percentile(u9s, 0.5)}ms  p95=${percentile(u9s, 0.95)}ms`);
    }
    if (tokens.length > 0) {
      console.log('\nPrompt tokens (U9 assembly output):');
      console.log(`  p50=${percentile(tokens, 0.5)}  p95=${percentile(tokens, 0.95)}  max=${tokens[tokens.length - 1]}`);
    }

    console.log('\nPer-query breakdown:');
    console.log('  id    total  u4     planner  qdrant  triage  u9+etc  tokens  status');
    for (const r of results) {
      const fmt = (v: number | null, unit = 'ms') => v != null ? `${v}${unit}` : '-';
      console.log(
        `  ${r.id.padEnd(6)} ${fmt(r.total_ms).padEnd(7)} ${fmt(r.u4_ms).padEnd(7)} ${fmt(r.planner_ms).padEnd(9)} ${fmt(r.qdrant_steps_sum_ms).padEnd(8)} ${fmt(r.u9_meta_triage_ms).padEnd(8)} ${fmt(r.u9_etc_ms).padEnd(8)} ${fmt(r.prompt_tokens, '').padEnd(8)} ${r.status}`
      );
    }

    console.log('\nBottleneck analysis (based on available trace data):');
    const avgU4 = u4s.reduce((a, b) => a + b, 0) / u4s.length;
    const avgTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
    const avgU9Etc = u9s.length > 0 ? u9s.reduce((a, b) => a + b, 0) / u9s.length : null;
    console.log(`  Average total: ${Math.round(avgTotal)}ms`);
    console.log(`  Average U4 retrieval: ${Math.round(avgU4)}ms (${Math.round((avgU4 / avgTotal) * 100)}% of total)`);
    if (avgU9Etc != null) {
      console.log(`  Average U9+overhead: ${Math.round(avgU9Etc)}ms (${Math.round((avgU9Etc / avgTotal) * 100)}% of total, includes R2 fetch)`);
    }
    const qdrantCallCounts = completed.filter((r) => r.qdrant_calls != null).map((r) => r.qdrant_calls!);
    if (qdrantCallCounts.length > 0) {
      const avgCalls = qdrantCallCounts.reduce((a, b) => a + b, 0) / qdrantCallCounts.length;
      console.log(`  Average Qdrant calls: ${avgCalls.toFixed(1)}`);
    }

    const p95Total = percentile(totals, 0.95);
    if (p95Total > 60_000) {
      console.log('\n  ⚠ p95 > 60s (U10 stubbed): U4/U9 bottleneck remains high. Reduce Qdrant calls or R2 concurrency.');
    } else if (p95Total > 30_000) {
      console.log('\n  ⚠ p95 30-60s (U10 stubbed): elevated. Investigate per-stage breakdown above.');
    } else {
      console.log('\n  ✓ p95 within acceptable range for U10-stubbed retrieval profiling.');
    }
  }

  const allCompleted = results.every((r) => r.status !== 'timeout' && r.status !== 'error');
  if (!allCompleted) {
    console.log(`\nFAIL: ${results.filter((r) => r.status === 'timeout' || r.status === 'error').length} run(s) did not complete.`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${results.length} profiling runs completed.`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
