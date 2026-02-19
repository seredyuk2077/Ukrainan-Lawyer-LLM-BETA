#!/usr/bin/env tsx
/**
 * E2E Stress Test — 50 concurrent requests від різних користувачів.
 *
 * Імітує реальне продакшн навантаження:
 *  - 50 різних запитів (з task9 + повтори до 50)
 *  - Кожен від унікального user_id (різні юзери)
 *  - POST /v1/runs → polling GET /v1/runs/:id до retrieval_trace готовий
 *  - Вимірює E2E latency (від POST до ready), success rate, 429s
 *
 * Запуск (в окремих терміналах):
 *   Terminal 1: MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120 DEV_ALLOW_ANONYMOUS=true pnpm brain:dev
 *   Terminal 2: pnpm brain:stress
 *
 * Або через npm script: pnpm brain:stress:e2e
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = process.env.BRAIN_BASE_URL ?? process.env.BRAIN_URL ?? 'http://localhost:3081';
const DEV_API_KEY = process.env.DEV_API_KEY ?? '';
// Фіксований tenant (одна організація), різні user per request
const TENANT_ID = process.env.LOADTEST_TENANT_ID ?? randomUUID();
const CONCURRENCY = parseInt(process.env.STRESS_CONCURRENCY ?? '50', 10);

// Poll settings
const POLL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 2000;
// 5 хвилин — для 50 concurrent (LLM + Qdrant серіалізуються під навантаженням)
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS ?? '300000', 10);

// ── Task9 queries ─────────────────────────────────────────────────────────────
const task9Path = resolve(__dirname, '_datasets', 'task9_query.txt');
const task9Text = readFileSync(task9Path, 'utf8');
const rawQueries = task9Text
  .split(/^Задача \d+\./gm)
  .filter((q) => q.trim().length > 80)
  .map((q) => q.trim().replace(/\s+/g, ' ').slice(0, 600));

// Якщо queries < CONCURRENCY — дублюємо (різні users, різні run_id)
const queries: string[] = [];
for (let i = 0; i < CONCURRENCY; i++) {
  queries.push(rawQueries[i % rawQueries.length]);
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface RunResult {
  user_idx: number;
  query_preview: string;
  run_id?: string;
  status: 'ok' | 'fail' | 'timeout' | 'rate_limited';
  e2e_latency_ms: number;
  post_latency_ms: number;
  u2_latency_ms?: number;   // until query_profile
  u4_latency_ms?: number;   // until retrieval_trace (E2E)
  selected_acts_count?: number;
  has_retrieval_trace: boolean;
  has_query_profile: boolean;
  low_confidence?: boolean;
  qdrant_calls?: number;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// Pre-generate UUIDs for each virtual user (stable per test run)
const USER_IDS: string[] = Array.from({ length: CONCURRENCY }, () => randomUUID());

// ── Core: POST /v1/runs ───────────────────────────────────────────────────────
async function postRun(query: string, userId: string): Promise<{ run_id: string; latency_ms: number }> {
  const body: Record<string, unknown> = {
    query,
    tenant_id: TENANT_ID,
    user_id: userId,
    allow_anonymous: true,   // підтримка DEV_ALLOW_ANONYMOUS без DEV_API_KEY
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (DEV_API_KEY) headers['X-Dev-API-Key'] = DEV_API_KEY;

  const start = performance.now();
  const res = await fetch(`${BASE_URL}/v1/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const latency_ms = Math.round(performance.now() - start);

  if (res.status === 429) {
    const txt = await res.text().catch(() => '');
    throw Object.assign(new Error(`429 rate/concurrent: ${txt.slice(0, 80)}`), { status: 429 });
  }
  if (res.status !== 202) {
    const txt = await res.text().catch(() => '');
    throw new Error(`POST ${res.status}: ${txt.slice(0, 120)}`);
  }
  const json = (await res.json()) as { run_id?: string };
  if (!json.run_id) throw new Error('no run_id in response');
  return { run_id: json.run_id, latency_ms };
}

// ── Core: Poll GET /v1/runs/:id until retrieval_trace ────────────────────────
interface PollResult {
  has_retrieval_trace: boolean;
  has_query_profile: boolean;
  u2_latency_ms?: number;   // time until query_profile appeared
  u4_latency_ms?: number;   // time until retrieval_trace appeared
  low_confidence?: boolean;
  selected_acts_count?: number;
  qdrant_calls?: number;
  timed_out: boolean;
}

async function pollUntilDone(run_id: string, userId: string): Promise<PollResult> {
  const headers: Record<string, string> = {
    // DEV_ALLOW_ANONYMOUS: pass tenant/user via headers for GET (no body)
    'x-tenant-id': TENANT_ID,
    'x-user-id': userId,
  };
  if (DEV_API_KEY) headers['X-Dev-API-Key'] = DEV_API_KEY;

  const pollStart = performance.now();
  let interval = POLL_INTERVAL_MS;
  let u2MarkedMs: number | undefined;

  while (performance.now() - pollStart < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval + 150, POLL_MAX_INTERVAL_MS);

    try {
      const res = await fetch(`${BASE_URL}/v1/runs/${run_id}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 200) continue;

      const run = await res.json() as {
        query_profile?: { domain?: string };
        retrieval_trace?: {
          selected_acts?: Array<{ rada_nreg: string }>;
          low_confidence?: boolean;
          meta?: { qdrant_calls_count_total?: number };
        };
      };

      const nowMs = Math.round(performance.now() - pollStart);
      if (run.query_profile && !u2MarkedMs) u2MarkedMs = nowMs;

      if (run.retrieval_trace) {
        return {
          has_retrieval_trace: true,
          has_query_profile: !!run.query_profile,
          u2_latency_ms: u2MarkedMs,
          u4_latency_ms: nowMs,
          low_confidence: run.retrieval_trace.low_confidence,
          selected_acts_count: run.retrieval_trace.selected_acts?.length,
          qdrant_calls: run.retrieval_trace.meta?.qdrant_calls_count_total,
          timed_out: false,
        };
      }
    } catch {
      // transient poll error — retry
    }
  }

  return {
    has_retrieval_trace: false,
    has_query_profile: u2MarkedMs !== undefined,
    u2_latency_ms: u2MarkedMs,
    timed_out: true,
  };
}

// ── Single user run ───────────────────────────────────────────────────────────
async function runOne(idx: number, query: string): Promise<RunResult> {
  const userId = USER_IDS[idx] ?? randomUUID();
  const queryPreview = query.slice(0, 70).replace(/\n/g, ' ');
  const e2eStart = performance.now();

  try {
    // 1. POST
    const { run_id, latency_ms: postMs } = await postRun(query, userId);

    // 2. Poll until retrieval_trace
    const poll = await pollUntilDone(run_id, userId);
    const e2eMs = Math.round(performance.now() - e2eStart);

    return {
      user_idx: idx,
      query_preview: queryPreview,
      run_id,
      status: poll.timed_out ? 'timeout' : 'ok',
      e2e_latency_ms: e2eMs,
      post_latency_ms: postMs,
      u2_latency_ms: poll.u2_latency_ms !== undefined ? postMs + poll.u2_latency_ms : undefined,
      u4_latency_ms: poll.u4_latency_ms !== undefined ? postMs + poll.u4_latency_ms : undefined,
      has_retrieval_trace: poll.has_retrieval_trace,
      has_query_profile: poll.has_query_profile,
      low_confidence: poll.low_confidence,
      selected_acts_count: poll.selected_acts_count,
      qdrant_calls: poll.qdrant_calls,
    };
  } catch (err: unknown) {
    const e = err as Error & { status?: number };
    return {
      user_idx: idx,
      query_preview: queryPreview,
      status: e.status === 429 ? 'rate_limited' : 'fail',
      e2e_latency_ms: Math.round(performance.now() - e2eStart),
      post_latency_ms: 0,
      poll_latency_ms: 0,
      has_retrieval_trace: false,
      has_query_profile: false,
      error: e.message?.slice(0, 150),
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('🔥  LEXERY RAG — E2E STRESS TEST');
  console.log('='.repeat(60));
  console.log(`Server:       ${BASE_URL}`);
  console.log(`Concurrency:  ${CONCURRENCY} users`);
  console.log(`Queries:      ${rawQueries.length} unique (від task9)`);
  console.log(`Auth:         ${DEV_API_KEY ? 'X-Dev-API-Key' : 'DEV_ALLOW_ANONYMOUS (allow_anonymous=true in body)'}`);
  console.log(`Tenant ID:    ${TENANT_ID}`);
  console.log(`Poll timeout: ${POLL_TIMEOUT_MS / 1000}s per run (override: POLL_TIMEOUT_MS=<ms>)`);
  console.log('='.repeat(60));

  // Health check
  try {
    const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
    console.log('✅  Server healthy\n');
  } catch (err: unknown) {
    const e = err as Error;
    console.error(`❌  Server not responding at ${BASE_URL}: ${e.message}`);
    console.error('    Запустіть сервер: MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120 DEV_ALLOW_ANONYMOUS=true pnpm brain:dev');
    process.exit(1);
  }

  console.log(`🚀  Запускаємо ${CONCURRENCY} одночасних запитів від різних users...\n`);
  const wallStart = performance.now();

  // All 50 concurrent — справжня одночасність
  const results = await Promise.all(queries.map((q, i) => runOne(i, q)));

  const wallMs = Math.round(performance.now() - wallStart);

  // ── Analytics ─────────────────────────────────────────────────────────────
  const ok = results.filter((r) => r.status === 'ok');
  const timeouts = results.filter((r) => r.status === 'timeout');
  const rateLimited = results.filter((r) => r.status === 'rate_limited');
  const failed = results.filter((r) => r.status === 'fail');

  const e2eLatencies = ok.map((r) => r.e2e_latency_ms).sort((a, b) => a - b);
  const postLatencies = ok.map((r) => r.post_latency_ms).sort((a, b) => a - b);
  const u2Latencies = ok.filter((r) => r.u2_latency_ms).map((r) => r.u2_latency_ms!).sort((a, b) => a - b);
  const u4Latencies = ok.filter((r) => r.u4_latency_ms).map((r) => r.u4_latency_ms!).sort((a, b) => a - b);

  const p50 = percentile(e2eLatencies, 50);
  const p90 = percentile(e2eLatencies, 90);
  const p95 = percentile(e2eLatencies, 95);
  const p99 = percentile(e2eLatencies, 99);
  const avgE2e = e2eLatencies.length ? Math.round(e2eLatencies.reduce((a, b) => a + b, 0) / e2eLatencies.length) : 0;
  const minE2e = e2eLatencies[0] ?? 0;
  const maxE2e = e2eLatencies[e2eLatencies.length - 1] ?? 0;

  const lowConfCount = ok.filter((r) => r.low_confidence).length;
  const avgQdrant = ok.filter((r) => r.qdrant_calls).reduce((s, r) => s + (r.qdrant_calls ?? 0), 0) / (ok.filter((r) => r.qdrant_calls).length || 1);
  const successRate = (ok.length / CONCURRENCY) * 100;
  const throughput = (CONCURRENCY / (wallMs / 1000)).toFixed(2);

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('📊  РЕЗУЛЬТАТИ STRESS TEST');
  console.log('='.repeat(60));
  console.log(`\nЗагальний час (wall-clock):  ${wallMs}ms`);
  console.log(`Throughput:                  ${throughput} req/s (concurrent)\n`);

  console.log('─── Статус ───────────────────────────────────────────────');
  console.log(`✅  OK (retrieval_trace):    ${ok.length} / ${CONCURRENCY} (${successRate.toFixed(1)}%)`);
  console.log(`⏱️   Timeout (>${POLL_TIMEOUT_MS / 1000}s):     ${timeouts.length}`);
  console.log(`🔴  429 Rate Limited:        ${rateLimited.length}`);
  console.log(`❌  Failed (error):          ${failed.length}`);
  console.log(`⚠️   Low confidence:          ${lowConfCount} / ${ok.length} (${ok.length ? ((lowConfCount / ok.length) * 100).toFixed(1) : 0}%)`);

  if (e2eLatencies.length > 0) {
    console.log('\n─── E2E Latency (POST → retrieval_trace ready) ───────────');
    console.log(`  p50:  ${p50}ms`);
    console.log(`  p90:  ${p90}ms`);
    console.log(`  p95:  ${p95}ms`);
    console.log(`  p99:  ${p99}ms`);
    console.log(`  avg:  ${avgE2e}ms`);
    console.log(`  min:  ${minE2e}ms`);
    console.log(`  max:  ${maxE2e}ms`);
  }

  if (postLatencies.length > 0) {
    console.log('\n─── POST /v1/runs latency (прийом запиту) ────────────────');
    console.log(`  p50: ${percentile(postLatencies, 50)}ms`);
    console.log(`  p95: ${percentile(postLatencies, 95)}ms`);
  }

  if (u2Latencies.length > 0) {
    console.log('\n─── U2 latency (POST → query_profile) ────────────────────');
    console.log(`  p50: ${percentile(u2Latencies, 50)}ms`);
    console.log(`  p90: ${percentile(u2Latencies, 90)}ms`);
    console.log(`  p95: ${percentile(u2Latencies, 95)}ms`);
    console.log(`  max: ${u2Latencies[u2Latencies.length - 1]}ms`);
  }

  if (u4Latencies.length > 0) {
    console.log('\n─── U4 latency (POST → retrieval_trace) ──────────────────');
    console.log(`  p50: ${percentile(u4Latencies, 50)}ms`);
    console.log(`  p90: ${percentile(u4Latencies, 90)}ms`);
    console.log(`  p95: ${percentile(u4Latencies, 95)}ms`);
    console.log(`  max: ${u4Latencies[u4Latencies.length - 1]}ms`);
  }

  console.log(`\n─── RAG pipeline stats ────────────────────────────────────`);
  console.log(`  Avg Qdrant calls/req:  ${avgQdrant.toFixed(1)}`);

  // Failures detail
  if (rateLimited.length > 0) {
    console.log(`\n⚠️  Rate limited requests — підніміть MAX_CONCURRENT_RUNS і RUNS_PER_MINUTE`);
  }
  if (timeouts.length > 0) {
    console.log(`\n⏱️  Timeouts (${timeouts.length}):`);
    timeouts.slice(0, 3).forEach((r) => console.log(`    User ${r.user_idx}: ${r.query_preview}`));
  }
  if (failed.length > 0) {
    console.log(`\n❌  Errors (${failed.length}):`);
    const byType: Record<string, number> = {};
    failed.forEach((r) => {
      const k = (r.error ?? 'unknown').slice(0, 50);
      byType[k] = (byType[k] ?? 0) + 1;
    });
    Object.entries(byType).forEach(([k, v]) => console.log(`    ${v}x ${k}`));
  }

  // ── Pass/Fail ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  const passSuccessRate = successRate >= 90; // 90%+ OK під 50 concurrent
  const passP95 = p95 <= 180_000;           // E2E p95 ≤ 180s (3 хв) під 50 concurrent
  const passNo429 = rateLimited.length === 0;

  if (passSuccessRate && passP95 && passNo429) {
    console.log('✅  STRESS TEST PASSED');
  } else {
    console.log('⚠️  STRESS TEST NEEDS ATTENTION:');
    if (!passSuccessRate) console.log(`    - Success rate ${successRate.toFixed(1)}% < 90%`);
    if (!passP95) console.log(`    - p95 E2E latency ${p95}ms > 180000ms (3 хв)`);
    if (p95 > 60_000 && p95 <= 180_000) console.log(`    ⚠️  p95 ${p95}ms > 60s — under load розгляньте concurrency optimization`);
    if (!passNo429) console.log(`    - ${rateLimited.length} rate-limited requests (підніміть MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120)`);
  }
  console.log('='.repeat(60));

  // ── Save JSON summary ─────────────────────────────────────────────────────
  const summary = {
    timestamp: new Date().toISOString(),
    concurrency: CONCURRENCY,
    wall_time_ms: wallMs,
    throughput_rps: parseFloat(throughput),
    results: {
      ok: ok.length,
      timeout: timeouts.length,
      rate_limited: rateLimited.length,
      failed: failed.length,
    },
    success_rate_pct: parseFloat(successRate.toFixed(1)),
    e2e_latency_ms: { p50, p90, p95, p99, avg: avgE2e, min: minE2e, max: maxE2e },
    post_latency_ms: {
      p50: percentile(postLatencies, 50),
      p95: percentile(postLatencies, 95),
    },
    u2_latency_ms: u2Latencies.length ? {
      p50: percentile(u2Latencies, 50),
      p90: percentile(u2Latencies, 90),
      p95: percentile(u2Latencies, 95),
      max: u2Latencies[u2Latencies.length - 1],
    } : null,
    u4_latency_ms: u4Latencies.length ? {
      p50: percentile(u4Latencies, 50),
      p90: percentile(u4Latencies, 90),
      p95: percentile(u4Latencies, 95),
      max: u4Latencies[u4Latencies.length - 1],
    } : null,
    low_confidence_count: lowConfCount,
    avg_qdrant_calls: parseFloat(avgQdrant.toFixed(1)),
    pass: passSuccessRate && passP95 && passNo429,
  };
  const outFile = resolve(__dirname, '_reports', `stress_e2e_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\nJSON: ${outFile}`);

  if (!passSuccessRate || !passNo429) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
