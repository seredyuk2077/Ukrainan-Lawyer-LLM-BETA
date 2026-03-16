#!/usr/bin/env node
/**
 * API acceptance verification for backend/Azure behavior.
 * Two modes: moderate (acceptance latency + near-100% 202), stress (gateway budget + 429 behavior).
 * Verifies: no synchronous coupling to U2 (acceptance only), no 5xx.
 *
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/load/api_acceptance_verify.ts
 * Env: API_ACCEPTANCE_MODE=moderate|stress (default moderate), N=concurrency, BRAIN_PORT, DEV_API_KEY.
 * moderate: N=10 default, expects ≥90% 202, p50 < 1s; 429 counted but not treated as acceptance failure.
 * stress: N=20 default, measures 429, no 5xx required.
 * Output: machine-readable JSON (accepted_202, throttled_429, status_5xx, p50, p95, queue_driver, run_context_driver).
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const MODE = process.env.API_ACCEPTANCE_MODE ?? 'moderate';
const N = parseInt(process.env.N ?? (MODE === 'stress' ? '20' : '10'), 10);
/** Moderate mode: neutral query to measure API/queue latency, not downstream law retrieval. Stress can use legal query. */
const DEFAULT_QUERY_MODERATE = process.env.API_ACCEPTANCE_QUERY ?? 'Коротке тестове запитання для перевірки API.';
const DEFAULT_QUERY_STRESS = process.env.API_ACCEPTANCE_QUERY ?? 'Acceptance stress ККУ ст. 115';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const SHUTDOWN_WAIT_MS = 5_000;

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error('Could not get port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(baseUrl: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const json = (await res.json()) as { status?: string };
        if (json.status === 'healthy') return true;
      }
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

interface Sample {
  status: number;
  latencyMs: number;
  run_id?: string;
}

async function onePost(baseUrl: string, i: number, query: string): Promise<Sample> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query: query.replace('${i}', String(i)),
        tenant_id: '00000000-0000-0000-0000-000000000001',
        user_id: '00000000-0000-0000-0000-000000000002',
      }),
    });
    const latencyMs = Date.now() - start;
    let json: { run_id?: string } = {};
    try {
      json = (await res.json()) as { run_id?: string };
    } catch {
      // 429/503 may return non-JSON
    }
    return { status: res.status, latencyMs, run_id: json.run_id };
  } catch (e) {
    const latencyMs = Date.now() - start;
    return { status: 0, latencyMs, run_id: undefined };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function shutdownServer(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (!child.kill) {
      resolve();
      return;
    }
    child.kill('SIGTERM');
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, SHUTDOWN_WAIT_MS);
    child.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

interface Report {
  ok: boolean;
  mode: string;
  health: boolean;
  n: number;
  accepted_202: number;
  throttled_429: number;
  non_202: number;
  status_5xx: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  acceptance_latency_sub_second: boolean;
  no_5xx: boolean;
  queue_driver: string;
  run_context_driver: string;
  message?: string;
}

async function main(): Promise<void> {
  const port = process.env.BRAIN_PORT ? parseInt(process.env.BRAIN_PORT, 10) : await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  if (!serverEnv.REDIS_QUEUE_NAMESPACE) {
    serverEnv.REDIS_QUEUE_NAMESPACE = `lexery:verify:api-acceptance:${randomUUID()}`;
  }
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    {
      env: serverEnv,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));
  child.on('error', (err) => {
    console.error('[api_acceptance_verify] Server spawn error:', err);
  });

  let healthOk = false;
  const samples: Sample[] = [];

  try {
    healthOk = await waitForHealth(baseUrl);
    if (!healthOk) {
      const report: Report = {
        ok: false,
        mode: MODE,
        health: false,
        n: N,
        accepted_202: 0,
        throttled_429: 0,
        non_202: N,
        status_5xx: 0,
        p50_latency_ms: 0,
        p95_latency_ms: 0,
        acceptance_latency_sub_second: false,
        no_5xx: true,
        queue_driver: process.env.QUEUE_DRIVER ?? 'inmemory',
        run_context_driver: process.env.RUN_CONTEXT_DRIVER ?? 'inmemory',
        message: 'Health check timeout',
      };
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    const queryTemplate = MODE === 'stress' ? `${DEFAULT_QUERY_STRESS} ${'${i}'}` : `${DEFAULT_QUERY_MODERATE}`;
    const latencies = await Promise.all(Array.from({ length: N }, (_, i) => onePost(baseUrl, i, queryTemplate)));
    samples.push(...latencies);
  } finally {
    await shutdownServer(child);
  }

  const accepted_202 = samples.filter((s) => s.status === 202).length;
  const throttled_429 = samples.filter((s) => s.status === 429).length;
  const non_202 = samples.filter((s) => s.status !== 202).length;
  const status_5xx = samples.filter((s) => s.status >= 500).length;
  const sortedLatency = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(sortedLatency, 50);
  const p95 = percentile(sortedLatency, 95);

  const acceptance_latency_sub_second = p50 < 1000;
  const no_5xx = status_5xx === 0;
  const accept_rate_ok = N > 0 && accepted_202 >= Math.max(1, Math.floor(N * 0.9));
  const ok = healthOk && no_5xx && acceptance_latency_sub_second && accept_rate_ok;

  const report: Report = {
    ok,
    mode: MODE,
    health: healthOk,
    n: N,
    accepted_202,
    throttled_429,
    non_202,
    status_5xx,
    p50_latency_ms: Math.round(p50),
    p95_latency_ms: Math.round(p95),
    acceptance_latency_sub_second,
    no_5xx,
    queue_driver: process.env.QUEUE_DRIVER ?? 'inmemory',
    run_context_driver: process.env.RUN_CONTEXT_DRIVER ?? 'inmemory',
    message: ok ? undefined : (no_5xx ? (acceptance_latency_sub_second ? (accept_rate_ok ? '' : 'Accept rate < 90%') : 'p50 latency >= 1s') : '5xx observed'),
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
