#!/usr/bin/env node
/**
 * Strong legal RAG verification with article/rank assertions.
 * Runs curated natural-language legal queries and checks whether the key norm
 * appears high enough in retrieval hits and selected_acts.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';
import {
  evaluateGoldenCase,
  type GoldenCase,
  type RetrievalTraceLike,
} from './rag_golden_eval.js';
import { RunRepository } from '../../gateway/storage.js';
import { getRetrievalTraceHitsForForensics } from '../../retrieval/retrieval-trace-r2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;
const runRepo = new RunRepository();

interface RunPayload {
  retrieval_trace?: RetrievalTraceLike | null;
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      server.close(() => (port ? resolvePort(port) : rejectPort(new Error('no port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(baseUrl: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok && (await r.json() as { status?: string })?.status === 'healthy') return true;
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

async function runQuery(
  baseUrl: string,
  query: string,
  tenantId: string,
  userId: string
): Promise<{ run: RunPayload | null; runId: string; latencyMs: number }> {
  const start = Date.now();
  let runId = '';
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
    });
    if (postRes.status !== 202) return { run: null, runId, latencyMs: Date.now() - start };
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { run: null, runId, latencyMs: Date.now() - start };
  } catch {
    return { run: null, runId, latencyMs: Date.now() - start };
  }

  const pollStart = Date.now();
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
      if (getRes.status !== 200) {
        await sleep(POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as RunPayload;
      const trace = run.retrieval_trace;
      if (trace?.meta?.hits_count != null || trace?.meta?.low_confidence === true) {
        return { run, runId, latencyMs: Date.now() - start };
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }

  return { run: null, runId, latencyMs: Date.now() - start };
}

async function loadTraceForEvaluation(
  runId: string,
  fallbackTrace: RetrievalTraceLike | null | undefined
): Promise<RetrievalTraceLike | null | undefined> {
  if (!runId) return fallbackTrace;
  const persisted = await runRepo.findByRunId(runId);
  if (!persisted?.retrieval_trace || typeof persisted.retrieval_trace !== 'object') return fallbackTrace;
  const persistedTrace = persisted.retrieval_trace as RetrievalTraceLike;
  const { hits } = await getRetrievalTraceHitsForForensics(
    persisted as { retrieval_trace?: { hits?: unknown[]; meta?: { full_trace_r2_key?: string } } | null }
  );
  return {
    ...persistedTrace,
    hits: hits as RetrievalTraceLike['hits'],
  };
}

async function main(): Promise<void> {
  const casesPath = resolve(__dirname, '../_datasets', 'rag_golden_cases.json');
  if (!existsSync(casesPath)) {
    console.error('[verify_rag_golden] Missing', casesPath);
    process.exit(1);
  }

  const allCases: GoldenCase[] = JSON.parse(readFileSync(casesPath, 'utf8'));
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toLowerCase();
  const cases =
    onlyValue === 'smoke'
      ? allCases.filter((c) => c.smoke === true)
      : onlyValue
        ? allCases.filter((c) => c.id === onlyValue)
        : allCases;

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_rag_golden] port', port, 'cases', cases.length, onlyValue ? `(--only=${onlyValue})` : '');

  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    LEGAL_AGENT_DISABLE_LLM: 'true',
    U10_DRY_RUN_KEEP_TRIAGE: 'true',
    U9_META_TRIAGE_ENABLED: 'false',
    MEMORY_RECENT_ENABLED: 'false',
    U5_STOP_AFTER_GATE: 'true',
    REDIS_QUEUE_NAMESPACE: `lexery:verify:rag-golden:${randomUUID()}`,
  };

  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  type ResultRow = {
    id: string;
    bucket?: string;
    priority?: 'high' | 'normal';
    runId?: string;
    pass: boolean;
    reasons: string[];
    failureCodes: string[];
    latencyMs: number;
    latencyBudgetMs?: number;
    qdrantCalls?: number;
    maxQdrantCalls?: number;
    lowConfidence: boolean;
    primaryRank?: number;
    selectedActsPresent: string[];
    expectedHitRanks: Record<string, number | null>;
  };

  const results: ResultRow[] = [];

  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_rag_golden] Health failed');
      process.exit(1);
    }

    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';

    for (const c of cases) {
      const { run, runId, latencyMs } = await runQuery(baseUrl, c.query, tenantId, userId);
      const evaluationTrace = await loadTraceForEvaluation(runId, run?.retrieval_trace);
      const evaluated = evaluateGoldenCase(c, evaluationTrace, {
        latency_ms: latencyMs,
        qdrant_calls_count_total: evaluationTrace?.meta?.qdrant_calls_count_total,
      });
      results.push({
        id: c.id,
        bucket: c.bucket,
        priority: c.priority,
        runId,
        pass: evaluated.pass,
        reasons: evaluated.reasons,
        failureCodes: evaluated.failure_codes,
        latencyMs,
        latencyBudgetMs: evaluated.metrics.latency_budget_ms,
        qdrantCalls: evaluated.metrics.qdrant_calls_count_total,
        maxQdrantCalls: evaluated.metrics.max_qdrant_calls,
        lowConfidence: evaluated.metrics.low_confidence,
        primaryRank: evaluated.metrics.primary_rank,
        selectedActsPresent: evaluated.metrics.selected_acts_present,
        expectedHitRanks: evaluated.metrics.expected_hit_ranks,
      });

      if (evaluated.pass) {
        console.log(
          '[verify_rag_golden]',
          c.id,
          'PASS',
          evaluated.metrics.primary_rank != null ? `primary_rank=${evaluated.metrics.primary_rank}` : ''
        );
      } else {
        console.error('[verify_rag_golden]', c.id, 'FAIL', evaluated.reasons.join('; '));
      }
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(SHUTDOWN_WAIT_MS).catch(() => undefined);
  }

  const passCount = results.filter((row) => row.pass).length;
  const failCount = results.length - passCount;
  const sortedLatencies = [...results.map((row) => row.latencyMs)].sort((a, b) => a - b);
  const p50Latency =
    sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length / 2)] ?? 0 : 0;
  const p95Latency =
    sortedLatencies.length > 0
      ? sortedLatencies[Math.min(Math.ceil(sortedLatencies.length * 0.95) - 1, sortedLatencies.length - 1)] ?? 0
      : 0;
  const sortedQdrant = results
    .map((row) => row.qdrantCalls ?? 0)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  const qdrantMedian =
    sortedQdrant.length > 0 ? sortedQdrant[Math.floor(sortedQdrant.length / 2)] ?? 0 : 0;
  const qdrantP95 =
    sortedQdrant.length > 0
      ? sortedQdrant[Math.min(Math.ceil(sortedQdrant.length * 0.95) - 1, sortedQdrant.length - 1)] ?? 0
      : 0;
  const failureCodeCounts: Record<string, number> = {};
  for (const row of results) {
    for (const code of row.failureCodes) {
      failureCodeCounts[code] = (failureCodeCounts[code] ?? 0) + 1;
    }
  }
  const bucketSummary = Object.entries(
    results.reduce<Record<string, { total: number; pass: number }>>((acc, row) => {
      const bucket = row.bucket ?? 'uncategorized';
      const current = acc[bucket] ?? { total: 0, pass: 0 };
      current.total += 1;
      if (row.pass) current.pass += 1;
      acc[bucket] = current;
      return acc;
    }, {})
  ).map(([bucket, summary]) => ({
    bucket,
    total: summary.total,
    pass: summary.pass,
    fail: summary.total - summary.pass,
  }));

  console.log('\n--- Golden Summary ---');
  console.log('pass:', passCount, '/', results.length);
  console.log('fail:', failCount);
  console.log('latency p50 ms:', p50Latency);
  console.log('latency p95 ms:', p95Latency);
  console.log('qdrant_calls median:', qdrantMedian);
  console.log('qdrant_calls p95:', qdrantP95);
  if (Object.keys(failureCodeCounts).length > 0) {
    console.log(
      'failure codes:',
      Object.entries(failureCodeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => `${code}=${count}`)
        .join(', ')
    );
  }

  const outDir = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_reports');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const reportPath = resolve(outDir, 'rag_golden_results.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        total: results.length,
        pass: passCount,
        fail: failCount,
        latency_p50_ms: p50Latency,
        latency_p95_ms: p95Latency,
        qdrant_calls_median: qdrantMedian,
        qdrant_calls_p95: qdrantP95,
        failure_code_counts: failureCodeCounts,
        bucket_summary: bucketSummary,
        results,
      },
      null,
      2
    )
  );
  console.log('[verify_rag_golden] report:', reportPath);

  if (failCount > 0) process.exit(1);
}

main().catch((error) => {
  console.error('[verify_rag_golden] fatal:', error);
  process.exit(1);
});
