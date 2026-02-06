#!/usr/bin/env node
/**
 * U2 load test — 50+ concurrent runs, poll until query_profile ready.
 * Run: pnpm brain:u2:loadtest [--concurrency=50] [--requests=50] (loads .env for DEV_API_KEY).
 * Server must be on BRAIN_URL (default http://localhost:3081). For 50/50: start server with MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120.
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

const BASE = process.env.BRAIN_URL || 'http://localhost:3081';
const DEV_KEY = process.env.DEV_API_KEY || 'dev-key-change-me';

const POLL_INTERVAL_MS = 200;
const POLL_MAX_INTERVAL_MS = 800;
/** Under 50 concurrent, U2 may take longer; 45s allows completion. */
const POLL_TIMEOUT_MS = 45000;

function parseArgs(): { concurrency: number; requests: number; mode: string } {
  let concurrency = 50;
  let requests = 50;
  let mode = 'hybrid';
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--concurrency=')) concurrency = Math.max(1, parseInt(arg.split('=')[1], 10) || 50);
    if (arg.startsWith('--requests=')) requests = Math.max(1, parseInt(arg.split('=')[1], 10) || 50);
    if (arg.startsWith('--mode=')) mode = arg.split('=')[1] || 'hybrid';
  }
  return { concurrency, requests, mode };
}

async function pollUntilQueryProfile(runId: string): Promise<{
  hasProfile: boolean;
  latencyMs: number;
  classifierMode?: 'llm' | 'rules' | 'degraded';
}> {
  const start = Date.now();
  let interval = POLL_INTERVAL_MS;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const getRes = await fetch(`${BASE}/v1/runs/${runId}`, {
      headers: { 'X-Dev-API-Key': DEV_KEY },
    });
    if (getRes.status !== 200) {
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval + 80, POLL_MAX_INTERVAL_MS);
      continue;
    }
    const run = (await getRes.json()) as {
      query_profile?: { intent?: string; meta?: { classifier_mode?: 'llm' | 'rules' | 'degraded' } };
    };
    const qp = run.query_profile;
    if (qp && (qp.intent !== undefined || qp.meta?.classifier_mode !== undefined)) {
      return {
        hasProfile: true,
        latencyMs: Date.now() - start,
        classifierMode: qp.meta?.classifier_mode,
      };
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval + 80, POLL_MAX_INTERVAL_MS);
  }
  return { hasProfile: false, latencyMs: Date.now() - start };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

async function main() {
  const { concurrency, requests, mode } = parseArgs();
  console.log('U2 load test:', { BASE, concurrency, requests, mode });
  console.log('');

  const tenantId =
    process.env.LOADTEST_TENANT_ID ||
    `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
  const userId = tenantId;
  const queries = Array.from({ length: requests }, (_, i) => `Load test query #${i + 1} — ст. 1 ККУ що таке?`);

  const results: {
    runId: string;
    success: boolean;
    latencyMs: number;
    classifierMode?: 'llm' | 'rules' | 'degraded';
    error?: string;
  }[] = [];

  const runOne = async (query: string, index: number): Promise<void> => {
    try {
      const res = await fetch(`${BASE}/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dev-API-Key': DEV_KEY,
        },
        body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
      });
      if (res.status !== 202) {
        const text = await res.text();
        const errLabel = res.status === 429 ? '429_rate_or_concurrent' : `POST ${res.status}`;
        results.push({ runId: '', success: false, latencyMs: 0, error: `${errLabel}: ${text.slice(0, 80)}` });
        return;
      }
      const json = (await res.json()) as { run_id?: string };
      const runId = json.run_id;
      if (!runId) {
        results.push({ runId: '', success: false, latencyMs: 0, error: 'no run_id' });
        return;
      }
      const { hasProfile, latencyMs, classifierMode } = await pollUntilQueryProfile(runId);
      results.push({ runId, success: hasProfile, latencyMs, classifierMode });
    } catch (e) {
      results.push({
        runId: '',
        success: false,
        latencyMs: 0,
        error: (e as Error).message,
      });
    }
  };

  const startTotal = Date.now();
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    await Promise.all(batch.map((q, j) => runOne(q, i + j)));
  }
  const totalMs = Date.now() - startTotal;

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const latencies = succeeded.map((r) => r.latencyMs).sort((a, b) => a - b);
  const byMode: Record<string, number> = { llm: 0, rules: 0, degraded: 0 };
  for (const r of succeeded) {
    if (r.classifierMode) byMode[r.classifierMode] = (byMode[r.classifierMode] || 0) + 1;
  }
  const errorsByType: Record<string, number> = {};
  let count429 = 0;
  for (const r of failed) {
    const key = (r.error || 'unknown').slice(0, 40);
    errorsByType[key] = (errorsByType[key] || 0) + 1;
    if (r.error?.startsWith('429_rate_or_concurrent')) count429++;
  }

  console.log('--- Load test summary ---');
  console.log('Success rate:', succeeded.length, '/', results.length, `(${((100 * succeeded.length) / results.length).toFixed(1)}%)`);
  if (count429 > 0) {
    console.log('429 count:', count429, '(rate/concurrent limit hit — set MAX_CONCURRENT_RUNS and RUNS_PER_MINUTE higher for this load)');
  }
  console.log('Total wall time (ms):', totalMs);
  if (latencies.length > 0) {
    console.log('U2 latency (ms) — median:', percentile(latencies, 50), ', p95:', percentile(latencies, 95));
  }
  console.log('Classifier mode — llm:', byMode.llm, ', rules:', byMode.rules, ', degraded:', byMode.degraded);
  if (Object.keys(errorsByType).length > 0) {
    console.log('Errors by type:', errorsByType);
  }
  if (failed.length > 0) {
    if (count429 === failed.length) {
      console.log('\nTip: Start server with MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120, then run: pnpm brain:u2:loadtest --concurrency=50 --requests=50');
    }
    process.exit(1);
  }
  console.log('All runs completed with valid query_profile.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
