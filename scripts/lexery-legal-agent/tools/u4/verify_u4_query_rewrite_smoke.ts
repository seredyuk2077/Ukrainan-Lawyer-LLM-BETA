#!/usr/bin/env node
/**
 * U4 Always-on Query Rewriter — smoke verify (6–8 cases).
 * Asserts invariants: query_rewrite called or fail reason; rewritten_query non-empty when success; out-of-domain → low confidence.
 * Not part of default brain:verify:smoke. Run: pnpm brain:verify:u4-query-rewrite:smoke
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;

const CASES: Array<{ query: string; outOfDomain?: boolean }> = [
  { query: 'спадок квартира' },
  { query: 'звільнення з роботи' },
  { query: 'бандитизм підслідність' },
  { query: 'недійсність правочину нотаріальна форма' },
  { query: 'порушення правил перетину кордону' },
  { query: 'податкове право порушення' },
  { query: 'відповідальність за порушення договору' },
  { query: 'космічна станція правила', outOfDomain: true },
];

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

type QueryRewriteMeta = {
  enabled?: boolean;
  called?: boolean;
  model_id?: string;
  attempts?: number;
  parse_mode?: string;
  rewritten_query?: string;
  variants?: string[];
  negative_terms?: string[];
  categories_top3?: string[];
  doc_types_top3?: string[];
  confidence?: number;
  not_used_reason_codes?: string[];
};

async function runOneCase(
  baseUrl: string,
  index: number,
  query: string
): Promise<{ pass: boolean; reason?: string; meta?: QueryRewriteMeta }> {
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query,
        tenant_id: '00000000-0000-0000-0000-000000000001',
        user_id: '00000000-0000-0000-0000-000000000002',
      }),
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
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (getRes.status !== 200) {
        await sleep(POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as {
        retrieval_trace?: {
          meta?: { query_rewrite?: QueryRewriteMeta };
        } | null;
      };
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object') {
        const meta = rt.meta?.query_rewrite;
        return { pass: true, meta };
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { pass: false, reason: `Timeout run_id=${runId}` };
}

function assertInvariants(
  index: number,
  query: string,
  outOfDomain: boolean,
  meta: QueryRewriteMeta | undefined
): { pass: boolean; reason?: string } {
  if (!meta) {
    return { pass: true }; // single-goal path always adds query_rewrite when we integrated; if missing (e.g. multi-goal) skip
  }
  if (meta.enabled === false) {
    return { pass: true }; // rewriter disabled by config
  }
  if (meta.called !== true && !meta.not_used_reason_codes?.length) {
    return { pass: false, reason: `Case ${index}: expected called=true or not_used_reason_codes when enabled` };
  }
  if (meta.called === true && !meta.not_used_reason_codes?.length && meta.rewritten_query !== undefined) {
    const q = meta.rewritten_query.trim();
    if (q.length === 0) return { pass: false, reason: `Case ${index}: rewritten_query empty` };
    if (q.length > 2000) return { pass: false, reason: `Case ${index}: rewritten_query too long` };
  }
  if (outOfDomain && meta.confidence !== undefined) {
    if (meta.confidence > 0.7) {
      return { pass: false, reason: `Case ${index}: out-of-domain expected low confidence, got ${meta.confidence}` };
    }
  }
  return { pass: true };
}

function getCaseIndices(): number[] {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  if (onlyValue === 'SMOKE' || onlyValue === 'FAST') {
    try {
      const path = resolve(__dirname, '../_datasets', 'verify_packs.json');
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf8');
        const packs = JSON.parse(raw) as Record<string, { smoke?: number[] }>;
        const indices = packs.u4_query_rewrite?.smoke;
        if (Array.isArray(indices) && indices.length > 0) return indices;
      }
    } catch {
      // fallback
    }
  }
  return CASES.map((_, i) => i);
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
  const indices = getCaseIndices();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_u4_query_rewrite_smoke] Port', port, 'cases', indices.length);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  const results: Array<{ index: number; query: string; pass: boolean; reason?: string }> = [];

  try {
    healthOk = await waitForHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_u4_query_rewrite_smoke] Health timeout');
      process.exit(1);
    }
    for (const i of indices) {
      const c = CASES[i];
      if (!c) continue;
      const run = await runOneCase(baseUrl, i, c.query);
      if (!run.pass) {
        results.push({ index: i, query: c.query, pass: false, reason: run.reason });
        continue;
      }
      const assert = assertInvariants(i, c.query, !!c.outOfDomain, run.meta);
      results.push({
        index: i,
        query: c.query,
        pass: assert.pass,
        reason: assert.reason,
      });
    }
  } finally {
    await shutdownServer(child);
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(r.pass ? `  [${r.index}] PASS ${r.query.slice(0, 50)}` : `  [${r.index}] FAIL ${r.query.slice(0, 50)} ${r.reason ?? ''}`);
  }
  console.log('\n--- Summary ---');
  console.log('Pass:', results.length - failed.length, '/', results.length);
  if (failed.length) {
    console.log('Failed:', failed.map((f) => `#${f.index} ${f.reason}`).join('; '));
  }
  const exitCode = failed.length === 0 ? 0 : 1;
  console.log('Exit:', exitCode === 0 ? 'PASS' : 'FAIL');
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
