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
import { config as loadEnv } from 'dotenv';
import { evaluateGoldenCase, type GoldenCase, type RetrievalTraceLike } from './rag_golden_eval.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;

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
): Promise<{ run: RunPayload | null; latencyMs: number }> {
  const start = Date.now();
  let runId = '';
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
    });
    if (postRes.status !== 202) return { run: null, latencyMs: Date.now() - start };
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { run: null, latencyMs: Date.now() - start };
  } catch {
    return { run: null, latencyMs: Date.now() - start };
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
        return { run, latencyMs: Date.now() - start };
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }

  return { run: null, latencyMs: Date.now() - start };
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
      ? allCases.slice(0, 3)
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
    U10_DRY_RUN_KEEP_TRIAGE: 'true',
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
    pass: boolean;
    reasons: string[];
    latencyMs: number;
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
      const { run, latencyMs } = await runQuery(baseUrl, c.query, tenantId, userId);
      const evaluated = evaluateGoldenCase(c, run?.retrieval_trace);
      results.push({
        id: c.id,
        pass: evaluated.pass,
        reasons: evaluated.reasons,
        latencyMs,
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
  const p50Latency =
    results.length > 0
      ? [...results.map((row) => row.latencyMs)].sort((a, b) => a - b)[Math.floor(results.length / 2)]
      : 0;

  console.log('\n--- Golden Summary ---');
  console.log('pass:', passCount, '/', results.length);
  console.log('fail:', failCount);
  console.log('latency p50 ms:', p50Latency);

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
