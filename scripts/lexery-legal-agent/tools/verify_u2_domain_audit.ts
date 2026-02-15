#!/usr/bin/env node
/**
 * U2 Domain Audit — verify query_profile.domain / domainHint / domain_confidence (SMOKE/FAST).
 * No act names; schema and invariant assertions only.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface U2DomainCase {
  id: string;
  query: string;
  expect_primary?: string;
  expect_primary_not_unknown?: boolean;
  expect_primary_unknown_or_low?: boolean;
  expect_confidence_min?: number;
  type: 'clean' | 'mixed' | 'out_of_domain';
}

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 60_000;
const SHUTDOWN_WAIT_MS = 5_000;

type VerifyPack = { u2_domain_audit?: { smoke?: number[]; fast?: number[] } };

function getOnlyIndices(casesLength: number): number[] | 'all' {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  if (onlyValue === 'FULL' || !onlyValue) return 'all';
  try {
    const path = resolve(__dirname, '_datasets', 'verify_packs.json');
    if (!existsSync(path)) return 'all';
    const packs = JSON.parse(readFileSync(path, 'utf8')) as VerifyPack;
    const pack = packs.u2_domain_audit;
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
      if (getRes.status !== 200) { await sleep(POLL_MS); continue; }
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

function legalDomainToTaxonomyKey(domain: string): string {
  const d = domain.trim().toLowerCase();
  if (d === 'criminal') return 'criminal';
  if (d === 'civil') return 'civil';
  if (d === 'labor') return 'labor_social';
  if (d === 'admin') return 'administrative';
  if (d === 'tax') return 'tax_customs';
  if (d === 'corporate') return 'corporate';
  return d || 'general';
}

function checkCase(qp: QueryProfileLike | null, c: U2DomainCase): boolean {
  if (!qp) return false;
  const primary = (qp.domainHint ?? legalDomainToTaxonomyKey(qp.domain ?? 'general')).trim().toLowerCase();
  const conf = typeof qp.domain_confidence === 'number' ? qp.domain_confidence : 0;

  if (c.expect_primary != null) {
    const want = c.expect_primary.trim().toLowerCase();
    if (primary !== want) return false;
    if (
      c.expect_confidence_min != null &&
      typeof qp.domain_confidence === 'number' &&
      conf < c.expect_confidence_min
    )
      return false;
    return true;
  }
  if (c.expect_primary_unknown_or_low === true) {
    return primary === 'unknown' || primary === 'general' || conf < 0.55;
  }
  if (c.expect_primary_not_unknown === true) {
    return primary.length > 0 && primary !== 'unknown';
  }
  if (c.expect_confidence_min != null) return conf >= c.expect_confidence_min;
  return true;
}

async function run(): Promise<void> {
  const casesPath = resolve(__dirname, '_datasets', 'u2_domain_audit_cases.json');
  let cases: U2DomainCase[];
  try {
    const data = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases?: U2DomainCase[] };
    cases = data.cases ?? [];
  } catch {
    console.error('[verify_u2_domain] Run with _datasets/u2_domain_audit_cases.json');
    process.exit(1);
  }
  if (cases.length === 0) {
    console.error('[verify_u2_domain] No cases');
    process.exit(1);
  }

  const onlyIndices = getOnlyIndices(cases.length);
  const indices = onlyIndices === 'all' ? cases.map((_, i) => i) : onlyIndices;
  const toRun = indices.map((i) => ({ index: i, c: cases[i] }));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_u2_domain] port', port, 'cases', toRun.length);

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
      console.error('[verify_u2_domain] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const { c } of toRun) {
      const { queryProfile, latencyMs } = await runQuery(baseUrl, c.query, tenantId, userId);
      const pass = checkCase(queryProfile, c);
      results.push(pass);
      const label = `${c.id} "${c.query.slice(0, 40)}..."`;
      if (pass) console.log('[verify_u2_domain]', label, 'PASS');
      else console.error('[verify_u2_domain]', label, 'FAIL');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS));
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  const total = results.length;
  const passCount = results.filter(Boolean).length;
  console.log('\n--- U2 domain audit summary ---');
  console.log('total pass:', passCount, '/', total);
  const allPass = total > 0 && results.every(Boolean);
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  const smokeGate = onlyValue === 'SMOKE' && total >= 5 && passCount >= 4;
  const exitCode = allPass || smokeGate ? 0 : 1;
  if (smokeGate && !allPass) console.log('[verify_u2_domain] SMOKE gate: pass (thresholds met)');
  process.exit(exitCode);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
