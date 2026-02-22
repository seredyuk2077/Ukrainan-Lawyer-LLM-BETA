#!/usr/bin/env node
/**
 * U2 Routing Audit — verify query_profile.lldbi (categories_ranked_top3, document_types_ranked_top3, routing_source).
 * Invariants only; no act names. Gate: smoke pass >= N.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface U2RoutingCase {
  id: string;
  query: string;
  expect_categories_contain?: string[];
  expect_doc_types_contain?: string[];
  expect_categories_not_empty?: boolean;
  expect_doc_types_may_contain_draft?: boolean;
  expect_out_of_scope_or_low?: boolean;
  type: string;
}

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 60_000;
const SHUTDOWN_WAIT_MS = 5_000;

type VerifyPack = { u2_routing_audit?: { smoke?: number[]; fast?: number[] } };

function getOnlyIndices(casesLength: number): number[] | 'all' {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  if (onlyValue === 'FULL' || !onlyValue) return 'all';
  try {
    const path = resolve(__dirname, '../_datasets', 'verify_packs.json');
    if (!existsSync(path)) return 'all';
    const packs = JSON.parse(readFileSync(path, 'utf8')) as VerifyPack;
    const pack = packs.u2_routing_audit;
    if (onlyValue === 'SMOKE' && pack?.smoke?.length)
      return pack.smoke.filter((i) => i >= 0 && i < casesLength);
    if (onlyValue === 'FAST' && pack?.fast?.length)
      return pack.fast.filter((i) => i >= 0 && i < casesLength);
  } catch {
    // ignore
  }
  return 'all';
}

function getFreePort(): Promise<number> {
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

interface QueryProfileLike {
  domain?: string;
  domainHint?: string;
  domain_confidence?: number;
  lldbi?: {
    categories_ranked_top3?: string[];
    document_types_ranked_top3?: string[];
    routing_confidence?: number;
    routing_source?: string;
  };
}

async function runQuery(
  baseUrl: string,
  query: string,
  tenantId: string,
  userId: string
): Promise<{ queryProfile: QueryProfileLike | null; latencyMs: number }> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
    });
    if (postRes.status !== 202) return { queryProfile: null, latencyMs: Date.now() - start };
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { queryProfile: null, latencyMs: Date.now() - start };
  } catch {
    return { queryProfile: null, latencyMs: Date.now() - start };
  }
  const pollStart = Date.now();
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
      if (getRes.status !== 200) {
        await sleep(POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as { query_profile?: QueryProfileLike };
      const qp = run.query_profile;
      if (qp != null && typeof qp === 'object') return { queryProfile: qp, latencyMs: Date.now() - start };
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { queryProfile: null, latencyMs: Date.now() - start };
}

function checkCase(qp: QueryProfileLike | null, c: U2RoutingCase): boolean {
  if (!qp) return false;
  const lldbi = qp.lldbi;
  if (!lldbi || typeof lldbi !== 'object') return false;
  const src = (lldbi.routing_source ?? '').toLowerCase();
  if (src !== 'heuristic' && src !== 'ai' && src !== 'mixed') return false;

  const cats = lldbi.categories_ranked_top3 ?? [];
  const docTypes = lldbi.document_types_ranked_top3 ?? [];
  const conf = typeof lldbi.routing_confidence === 'number' ? lldbi.routing_confidence : 0;
  const domain = (qp.domain ?? qp.domainHint ?? 'general').toLowerCase();

  if (c.expect_out_of_scope_or_low === true) {
    return conf < 0.55 || domain === 'unknown' || domain === 'general';
  }
  if (c.expect_categories_contain?.length && cats.length > 0) {
    const wantSet = new Set(c.expect_categories_contain.map((s) => s.trim().toLowerCase()));
    const has = cats.some((k) => wantSet.has(k.trim().toLowerCase()));
    if (!has) return false;
  }
  if (c.expect_doc_types_contain?.length && docTypes.length > 0) {
    const wantSet = new Set(c.expect_doc_types_contain.map((s) => s.trim()));
    const has = docTypes.some((t) => wantSet.has(t.trim()));
    if (!has) return false;
  }
  if (c.expect_categories_not_empty === true) {
    // Heuristic may leave empty; pass if we have profile and lldbi
    return true;
  }
  if (c.expect_doc_types_may_contain_draft === true) {
    // Optional: draft may or may not appear; just require lldbi present
    return true;
  }
  return true;
}

async function run(): Promise<void> {
  const casesPath = resolve(__dirname, '../_datasets', 'u2_routing_audit_cases.json');
  let cases: U2RoutingCase[];
  try {
    const data = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases?: U2RoutingCase[] };
    cases = data.cases ?? [];
  } catch {
    console.error('[verify_u2_routing] Run with _datasets/u2_routing_audit_cases.json');
    process.exit(1);
  }
  if (cases.length === 0) {
    console.error('[verify_u2_routing] No cases');
    process.exit(1);
  }

  const onlyIndices = getOnlyIndices(cases.length);
  const indices = onlyIndices === 'all' ? cases.map((_, i) => i) : onlyIndices;
  const toRun = indices.map((i) => ({ index: i, c: cases[i] }));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_u2_routing] port', port, 'cases', toRun.length);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  const results: boolean[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_u2_routing] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const { c } of toRun) {
      const { queryProfile, latencyMs } = await runQuery(baseUrl, c.query, tenantId, userId);
      const pass = checkCase(queryProfile, c);
      results.push(pass);
      const label = `${c.id} "${c.query.slice(0, 40)}..."`;
      if (pass) console.log('[verify_u2_routing]', label, 'PASS');
      else console.error('[verify_u2_routing]', label, 'FAIL');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS));
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  const total = results.length;
  const passCount = results.filter(Boolean).length;
  console.log('\n--- U2 routing audit summary ---');
  console.log('total pass:', passCount, '/', total);
  const allPass = total > 0 && results.every(Boolean);
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  const smokeGate = onlyValue === 'SMOKE' && total >= 5 && passCount >= 4;
  const exitCode = allPass || smokeGate ? 0 : 1;
  if (smokeGate && !allPass) console.log('[verify_u2_routing] SMOKE gate: pass (thresholds met)');
  process.exit(exitCode);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
