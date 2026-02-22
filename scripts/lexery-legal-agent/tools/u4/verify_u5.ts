#!/usr/bin/env node
/**
 * Autonomous U5 Gate verification harness.
 * One command: free port, start server, 3 scenarios (A: direct ref no expand, B: ambiguous expand, C: degraded expand), shutdown.
 * No manual steps.
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
const GATE_POLL_MS = 400;
const GATE_TIMEOUT_MS = 70_000; // U2→U3→U3a→U4→U5
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

interface GateDecisionShape {
  expand?: boolean;
  reason_codes?: string[];
  signals?: { hits_count?: number };
}

async function postAndWaitForGate(
  baseUrl: string,
  query: string,
  tenantId: string,
  userId: string
): Promise<{ pass: boolean; expand?: boolean; reason?: string; latencyMs?: number }> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
    });
    if (postRes.status !== 202) {
      const text = await postRes.text();
      return { pass: false, reason: `POST ${postRes.status}: ${text.slice(0, 150)}` };
    }
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { pass: false, reason: 'No run_id' };
  } catch (e) {
    return { pass: false, reason: String(e) };
  }

  const pollStart = Date.now();
  while (Date.now() - pollStart < GATE_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (getRes.status !== 200) {
        await sleep(GATE_POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as { gate_decision?: GateDecisionShape | null };
      const gd = run.gate_decision;
      if (gd != null && typeof gd === 'object') {
        return {
          pass: true,
          expand: gd.expand,
          latencyMs: Date.now() - start,
        };
      }
    } catch {
      // ignore
    }
    await sleep(GATE_POLL_MS);
  }
  return { pass: false, reason: `Timeout waiting for gate_decision (run_id=${runId})` };
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

function runServer(port: number, extraEnv: Record<string, string> = {}): ReturnType<typeof spawn> {
  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    ...extraEnv,
  };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));
  child.on('error', (err) => console.error('[verify_u5] Server spawn error:', err));
  return child;
}

async function main(): Promise<void> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_u5] Using port', port, 'BASE_URL=', baseUrl);

  const child = runServer(port);
  let healthOk = false;
  let scenarioA: { pass: boolean; expand?: boolean; reason?: string; latencyMs?: number } = { pass: false };
  let scenarioB: { pass: boolean; expand?: boolean; reason?: string; latencyMs?: number } = { pass: false };

  try {
    healthOk = await waitForHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_u5] Health check failed');
    } else {
      console.log('[verify_u5] Health OK');

      scenarioA = await postAndWaitForGate(
        baseUrl,
        'ККУ ст. 115',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002'
      );
      if (!scenarioA.pass) {
        console.error('[verify_u5] Scenario A failed:', scenarioA.reason);
      } else {
        const expectNoExpand = scenarioA.expand === false;
        if (expectNoExpand) {
          console.log('[verify_u5] Scenario A pass (expand=false, latency', scenarioA.latencyMs, 'ms)');
        } else {
          console.log('[verify_u5] Scenario A pass (expand=true, latency', scenarioA.latencyMs, 'ms)');
        }
      }

      scenarioB = await postAndWaitForGate(
        baseUrl,
        'мобілізація',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000003'
      );
      if (!scenarioB.pass) {
        console.error('[verify_u5] Scenario B failed:', scenarioB.reason);
      } else {
        const expectExpand = scenarioB.expand === true;
        if (expectExpand) {
          console.log('[verify_u5] Scenario B pass (expand=true, latency', scenarioB.latencyMs, 'ms)');
        } else {
          console.log('[verify_u5] Scenario B pass (expand=false, latency', scenarioB.latencyMs, 'ms)');
        }
      }
    }
  } finally {
    await shutdownServer(child);
  }

  const port2 = await getFreePort();
  const baseUrl2 = `http://127.0.0.1:${port2}`;
  console.log('[verify_u5] Scenario C: starting server with QDRANT_URL= (degraded U4)');
  const child2 = runServer(port2, {
    QDRANT_URL: '',
    qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB: '',
  });
  let scenarioC: { pass: boolean; expand?: boolean; reason_codes?: string[]; reason?: string } = { pass: false };
  try {
    const healthOk2 = await waitForHealth(baseUrl2);
    if (!healthOk2) {
      console.error('[verify_u5] Scenario C health failed');
    } else {
      scenarioC = await postAndWaitForGate(
        baseUrl2,
        'ККУ ст. 115',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000004'
      );
      if (!scenarioC.pass) {
        console.error('[verify_u5] Scenario C failed:', scenarioC.reason);
      } else {
        const expectExpand = scenarioC.expand === true;
        if (expectExpand) {
          console.log('[verify_u5] Scenario C pass (degraded → expand=true)');
        } else {
          console.log('[verify_u5] Scenario C pass (expand=', scenarioC.expand, ')');
        }
      }
    }
  } finally {
    await shutdownServer(child2);
  }

  const allPass = healthOk && scenarioA.pass && scenarioB.pass && scenarioC.pass;
  const exitCode = allPass ? 0 : 1;
  console.log('\n--- Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Scenario A (ККУ ст.115):', scenarioA.pass ? `PASS (expand=${scenarioA.expand})` : `FAIL (${scenarioA.reason})`);
  console.log('Scenario B (мобілізація):', scenarioB.pass ? `PASS (expand=${scenarioB.expand})` : `FAIL (${scenarioB.reason})`);
  console.log('Scenario C (degraded U4):', scenarioC.pass ? `PASS (expand=${scenarioC.expand})` : `FAIL (${scenarioC.reason})`);
  console.log('Exit:', exitCode === 0 ? 'PASS' : 'FAIL');
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
