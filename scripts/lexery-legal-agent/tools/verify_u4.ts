#!/usr/bin/env node
/**
 * Autonomous U4 verification harness (Wave 3).
 * One command: free port, start server, health, smoke POST→poll until retrieval_trace present (or degraded), shutdown.
 * PASS when retrieval_trace != null (hits or degraded_sources.lldbi=true); no manual steps.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const SMOKE_POLL_MS = 400;
const SMOKE_TIMEOUT_MS = 60_000; // U4 may need embedding + Qdrant
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

async function smokeRun(baseUrl: string): Promise<{ pass: boolean; latencyMs: number; degraded?: boolean; reason?: string }> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query: 'ККУ ст. 115 умисне вбивство',
        tenant_id: '00000000-0000-0000-0000-000000000001',
        user_id: '00000000-0000-0000-0000-000000000002',
      }),
    });
    if (postRes.status !== 202) {
      const text = await postRes.text();
      return { pass: false, latencyMs: Date.now() - start, reason: `POST ${postRes.status}: ${text.slice(0, 200)}` };
    }
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { pass: false, latencyMs: Date.now() - start, reason: 'No run_id in response' };
  } catch (e) {
    return { pass: false, latencyMs: Date.now() - start, reason: String(e) };
  }

  const pollStart = Date.now();
  while (Date.now() - pollStart < SMOKE_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (getRes.status !== 200) {
        await sleep(SMOKE_POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as {
        query_profile?: unknown;
        search_plan?: { plan?: unknown; steps?: unknown[]; next_step?: string };
        retrieval_trace?: { version?: number; hits?: unknown[]; degraded_sources?: { lldbi?: boolean } } | null;
      };
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object') {
        const degraded = !!rt.degraded_sources?.lldbi;
        return { pass: true, latencyMs: Date.now() - start, degraded };
      }
    } catch {
      // ignore
    }
    await sleep(SMOKE_POLL_MS);
  }
  return {
    pass: false,
    latencyMs: Date.now() - start,
    reason: `Timeout waiting for retrieval_trace (run_id=${runId})`,
  };
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

async function main(): Promise<void> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_u4] Using port', port, 'BASE_URL=', baseUrl);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
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
    console.error('[verify_u4] Server spawn error:', err);
  });

  let healthOk = false;
  let smokeResult: { pass: boolean; latencyMs: number; degraded?: boolean; reason?: string } = { pass: false, latencyMs: 0 };

  try {
    healthOk = await waitForHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_u4] Health check failed (timeout', HEALTH_TIMEOUT_MS, 'ms)');
    } else {
      console.log('[verify_u4] Health OK');
      smokeResult = await smokeRun(baseUrl);
      if (!smokeResult.pass) {
        console.error('[verify_u4] Smoke failed:', smokeResult.reason);
      } else {
        console.log(
          '[verify_u4] Smoke pass, latency',
          smokeResult.latencyMs,
          'ms',
          smokeResult.degraded ? '(degraded LLDBI)' : ''
        );
      }
    }
  } finally {
    await shutdownServer(child);
  }

  const exitCode = healthOk && smokeResult.pass ? 0 : 1;
  console.log('\n--- Summary ---');
  console.log('Port:', port);
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log(
    'Smoke:',
    smokeResult.pass
      ? `PASS (${smokeResult.latencyMs}ms${smokeResult.degraded ? ', degraded' : ''})`
      : `FAIL (${smokeResult.reason ?? 'unknown'})`
  );
  console.log('Exit:', exitCode === 0 ? 'PASS' : 'FAIL');
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
