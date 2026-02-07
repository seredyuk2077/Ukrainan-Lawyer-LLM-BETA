#!/usr/bin/env node
/**
 * Autonomous U3 verification harness (Wave 1–2).
 * One command: find free port, start server, health check, smoke POST→U4 stub, run brain:u3:test, shutdown.
 * Exit 0 = all pass, 1 = any fail (CI-ready).
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
const SMOKE_POLL_MS = 300;
const SMOKE_TIMEOUT_MS = 30_000;
const SHUTDOWN_WAIT_MS = 5_000;
const U3_TEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

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

async function smokeRun(baseUrl: string): Promise<{ pass: boolean; latencyMs: number; reason?: string }> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query: 'ККУ ст. 115',
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
      };
      const qp = run.query_profile;
      const sp = run.search_plan;
      const hasPlan = !!sp?.plan;
      const hasSteps = Array.isArray(sp?.steps) && sp.steps.length > 0;
      const nextStep = sp?.next_step === 'U4';
      if (qp && hasPlan && hasSteps && nextStep) {
        return { pass: true, latencyMs: Date.now() - start };
      }
    } catch {
      // ignore
    }
    await sleep(SMOKE_POLL_MS);
  }
  return {
    pass: false,
    latencyMs: Date.now() - start,
    reason: `Timeout waiting for search_plan.steps and next_step=U4 (run_id=${runId})`,
  };
}

function runU3Test(baseUrl: string): Promise<{ pass: boolean; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['brain:u3:test'],
      {
        env: {
          ...process.env,
          BRAIN_BASE_URL: baseUrl,
          BRAIN_URL: baseUrl,
          DEV_API_KEY: DEV_KEY,
        },
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => {
      stdout += c;
      process.stdout.write(c);
    });
    child.stderr?.on('data', (c) => {
      stderr += c;
      process.stderr.write(c);
    });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ pass: false, code: -1 });
    }, U3_TEST_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      const ok = code === 0 && !signal;
      resolve({ pass: ok, code: code ?? -1 });
    });
    child.on('error', () => resolve({ pass: false, code: -1 }));
  });
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
  console.log('[verify_u3] Using port', port, 'BASE_URL=', baseUrl);

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
    console.error('[verify_u3] Server spawn error:', err);
  });

  let healthOk = false;
  let smokeResult: { pass: boolean; latencyMs: number; reason?: string } = { pass: false, latencyMs: 0 };
  let u3Result: { pass: boolean; code: number } = { pass: false, code: -1 };

  try {
    healthOk = await waitForHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_u3] Health check failed (timeout', HEALTH_TIMEOUT_MS, 'ms)');
    } else {
      console.log('[verify_u3] Health OK');
      smokeResult = await smokeRun(baseUrl);
      if (!smokeResult.pass) {
        console.error('[verify_u3] Smoke failed:', smokeResult.reason);
      } else {
        console.log('[verify_u3] Smoke pass, latency', smokeResult.latencyMs, 'ms');
      }
      u3Result = await runU3Test(baseUrl);
      if (!u3Result.pass) {
        console.error('[verify_u3] brain:u3:test failed, code=', u3Result.code);
      } else {
        console.log('[verify_u3] brain:u3:test pass');
      }
    }
  } finally {
    await shutdownServer(child);
  }

  const exitCode = healthOk && smokeResult.pass && u3Result.pass ? 0 : 1;
  console.log('\n--- Summary ---');
  console.log('Port:', port);
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Smoke:', smokeResult.pass ? `PASS (${smokeResult.latencyMs}ms)` : `FAIL (${smokeResult.reason ?? 'unknown'})`);
  console.log('u3:test:', u3Result.pass ? 'PASS' : `FAIL (code=${u3Result.code})`);
  console.log('Exit:', exitCode === 0 ? 'PASS' : 'FAIL');
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
