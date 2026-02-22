#!/usr/bin/env node
/**
 * Edge-case verify: diverse one-off queries (civil/criminal, multiact, out-of-domain, short/long).
 * Asserts: no crash, response shape; optional domain/hits/low_confidence. Report to _reports/.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface EdgeCase {
  id: string;
  query: string;
  /** expect domain in this list (optional) */
  expectDomainOneOf?: string[];
  /** expect low_confidence true (e.g. gibberish) */
  expectLowConfidence?: boolean;
  /** expect at least one selected act (optional) */
  expectHasSelectedAct?: boolean;
  /** human-readable category for report */
  category: string;
}

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 70_000;
const SHUTDOWN_WAIT_MS = 5_000;

const EDGE_CASES: EdgeCase[] = [
  { id: 'civil_damage', query: 'Чи можу стягнути відшкодування за отруєння?', expectDomainOneOf: ['civil', 'general'], category: 'civil' },
  { id: 'criminal_guilt', query: 'Який вид вини за отруту передбачає ККУ?', expectDomainOneOf: ['criminal', 'general'], category: 'criminal' },
  { id: 'kku_explicit', query: 'ККУ ст. 115 умисне вбивство', expectHasSelectedAct: true, category: 'explicit_act' },
  { id: 'cpk_explicit', query: 'ЦПК ст. 121 подача позову', expectHasSelectedAct: true, category: 'explicit_act' },
  { id: 'short_act', query: 'КАС', expectHasSelectedAct: true, category: 'short_act' },
  { id: 'gibberish', query: 'абсурд xyz неіснуючий термін 12345 qwerty', expectLowConfidence: true, category: 'out_of_domain' },
  { id: 'multigoal', query: 'Що таке шахрайство і чия по підслідності ця стаття?', expectHasSelectedAct: true, category: 'multigoal' },
  { id: 'moz_2559', query: 'МОЗ №2559 про затвердження форм', expectDomainOneOf: ['general', 'admin', 'healthcare', 'health'], category: 'secondary_act' },
  { id: 'labor', query: 'звільнення з роботи за прогул', expectDomainOneOf: ['labor_social', 'labor', 'general'], category: 'labor' },
  { id: 'tax', query: 'податкова перевірка та оскарження', expectDomainOneOf: ['tax_customs', 'tax', 'general'], category: 'tax' },
  { id: 'long_task', query: 'Сім\'я з двома дітьми. Батьки в розлученні. Мати хоче змінити місце проживання дитини. Які норми ЦКУ та СКУ застосовуються?', expectHasSelectedAct: true, category: 'long_family' },
  { id: 'recipe_ood', query: 'рецепт борщу з буряком', expectLowConfidence: true, category: 'out_of_domain' },
  { id: 'reference_style', query: 'Що сказано в Постанові КМУ 509 про перелік?', expectHasSelectedAct: true, category: 'reference' },
];

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

interface RunPayload {
  query_profile?: { domain?: string; domainHint?: string; domain_confidence?: number } | null;
  retrieval_trace?: {
    meta?: { hits_count?: number; low_confidence?: boolean; selected_acts?: Array<{ rada_nreg?: string }> };
  } | null;
}

async function runQuery(
  baseUrl: string,
  query: string,
  tenantId: string,
  userId: string
): Promise<{ run: RunPayload | null; latencyMs: number }> {
  const start = Date.now();
  let runId: string;
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
      if (getRes.status !== 200) { await sleep(POLL_MS); continue; }
      const run = (await getRes.json()) as RunPayload;
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object' && (rt.meta?.hits_count != null || rt.meta?.low_confidence === true))
        return { run, latencyMs: Date.now() - start };
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { run: null, latencyMs: Date.now() - start };
}

function checkCase(run: RunPayload | null, c: EdgeCase): { pass: boolean; note?: string } {
  if (!run) return { pass: false, note: 'no response' };
  const qp = run.query_profile;
  const rt = run.retrieval_trace;
  const meta = rt?.meta;
  const domain = (qp?.domainHint ?? qp?.domain ?? 'general').trim().toLowerCase();
  const lowConf = meta?.low_confidence === true;
  const selectedCount = (meta?.selected_acts ?? []).length;

  if (c.expectLowConfidence === true) {
    if (lowConf) return { pass: true };
    if ((meta?.hits_count ?? 0) === 0) return { pass: true, note: '0 hits' };
    return { pass: false, note: `expected low_confidence, got confidence with ${meta?.hits_count ?? 0} hits` };
  }
  if (c.expectDomainOneOf?.length) {
    const wantList = c.expectDomainOneOf.map((d) => d.trim().toLowerCase());
    const match = wantList.some((w) => domain === w || domain.includes(w));
    if (!match) return { pass: false, note: `domain "${domain}" not in [${wantList.join(', ')}]` };
  }
  if (c.expectHasSelectedAct === true && selectedCount === 0 && !lowConf)
    return { pass: false, note: `expected at least one selected act, got ${selectedCount}` };
  return { pass: true };
}

async function run(): Promise<void> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_edge_cases] port', port, 'cases', EDGE_CASES.length);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  type Row = { id: string; category: string; pass: boolean; note?: string; latencyMs: number; domain?: string };
  const results: Row[] = [];

  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_edge_cases] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const c of EDGE_CASES) {
      const { run, latencyMs } = await runQuery(baseUrl, c.query, tenantId, userId);
      const { pass, note } = checkCase(run, c);
      const domain = run?.query_profile?.domainHint ?? run?.query_profile?.domain;
      results.push({ id: c.id, category: c.category, pass, note, latencyMs, domain });
      const label = `${c.id} "${c.query.slice(0, 36)}..."`;
      if (pass) console.log('[verify_edge_cases]', label, 'PASS');
      else console.error('[verify_edge_cases]', label, 'FAIL', note ?? '');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS));
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  const passCount = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n--- Edge cases summary ---');
  console.log('pass:', passCount, '/', total);

  const reportDir = resolve(__dirname, '../_reports');
  try { mkdirSync(reportDir, { recursive: true }); } catch { /* ignore */ }
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = resolve(reportDir, `edge_cases_${date}.md`);
  const report = [
    `# Edge cases verify ${date}`,
    '',
    `Pass: ${passCount}/${total}`,
    '',
    '| id | category | pass | domain | latencyMs | note |',
    '|----|----------|------|--------|-----------|------|',
    ...results.map((r) => `| ${r.id} | ${r.category} | ${r.pass ? '✓' : '✗'} | ${r.domain ?? '-'} | ${r.latencyMs} | ${r.note ?? '-'} |`),
  ].join('\n');
  writeFileSync(reportPath, report, 'utf8');
  console.log('[verify_edge_cases] report:', reportPath);

  process.exit(passCount === total ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
