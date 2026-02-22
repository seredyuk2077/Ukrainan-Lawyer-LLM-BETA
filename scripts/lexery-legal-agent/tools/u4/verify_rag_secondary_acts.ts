#!/usr/bin/env node
/**
 * RAG перевірка по вторинних актах (постанови КМУ, розпорядження, накази, укази).
 * Запити БЕЗ згадки акту — лише питання за темою. Очікуємо, що потрібний акт з'явиться в selected_acts або hits.
 * Dataset: _datasets/rag_secondary_acts_cases.json (зроблено на основі документів з Supabase legislation).
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;

interface SecondaryActCase {
  id: string;
  query: string;
  expected_rada_nregs: string[];
  expected_families: string[];
  description: string;
}

interface RunPayload {
  retrieval_trace?: {
    hits?: Array<{ rada_nreg?: string }>;
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      selected_acts?: Array<{ rada_nreg?: string }>;
      act_candidates_top?: Array<{ rada_nreg?: string }>;
    };
  } | null;
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
      /* ignore */
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
      if (getRes.status !== 200) {
        await sleep(POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as RunPayload;
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object' && (rt.meta?.hits_count != null || rt.meta?.low_confidence === true))
        return { run, latencyMs: Date.now() - start };
    } catch {
      /* ignore */
    }
    await sleep(POLL_MS);
  }
  return { run: null, latencyMs: Date.now() - start };
}

function getActNregs(run: RunPayload | null): Set<string> {
  const rt = run?.retrieval_trace;
  if (!rt) return new Set();
  const nregs: string[] = [];
  for (const a of rt.meta?.selected_acts ?? []) {
    if (a.rada_nreg) nregs.push(a.rada_nreg);
  }
  for (const a of rt.meta?.act_candidates_top ?? []) {
    if (a.rada_nreg) nregs.push(a.rada_nreg);
  }
  for (const h of rt.hits ?? []) {
    if (h.rada_nreg) nregs.push(h.rada_nreg);
  }
  return new Set(nregs.map((n) => String(n).trim().toLowerCase()));
}

function evaluateCase(c: SecondaryActCase, run: RunPayload | null): { pass: boolean; found: string[]; reason: string } {
  const foundNregs = getActNregs(run);
  const expectedLower = c.expected_rada_nregs.map((n) => String(n).trim().toLowerCase());
  const found = expectedLower.filter((n) => foundNregs.has(n));
  const pass = found.length > 0;
  const reason = pass
    ? `found: ${found.join(', ')}`
    : `expected one of [${c.expected_rada_nregs.join(', ')}], got ${foundNregs.size} acts total`;
  return { pass, found, reason };
}

async function main(): Promise<void> {
  const casesPath = resolve(__dirname, '../_datasets', 'rag_secondary_acts_cases.json');
  if (!existsSync(casesPath)) {
    console.error('[verify_rag_secondary_acts] Missing', casesPath);
    process.exit(1);
  }
  const cases: SecondaryActCase[] = JSON.parse(readFileSync(casesPath, 'utf8'));

  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.trim();
  let toRun = cases;
  if (onlyValue) {
    const ids = onlyValue.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) toRun = cases.filter((c) => ids.includes(c.id));
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_rag_secondary_acts] port', port, 'cases', toRun.length, '— запити без згадки акту');

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  type Row = { id: string; pass: boolean; found: string[]; reason: string; latencyMs: number };
  const results: Row[] = [];

  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_rag_secondary_acts] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';

    for (const c of toRun) {
      const { run, latencyMs } = await runQuery(baseUrl, c.query, tenantId, userId);
      const ev = evaluateCase(c, run);
      results.push({
        id: c.id,
        pass: ev.pass,
        found: ev.found,
        reason: ev.reason,
        latencyMs,
      });
      const label = `${c.id}`;
      if (ev.pass) console.log('[verify_rag_secondary_acts]', label, 'PASS', ev.found.join(', '));
      else console.error('[verify_rag_secondary_acts]', label, 'FAIL', ev.reason);
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

  const passCount = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n--- RAG secondary acts summary ---');
  console.log('pass:', passCount, '/', total);

  const reportDir = resolve(__dirname, '../_reports');
  try {
    mkdirSync(reportDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = resolve(reportDir, `rag_secondary_acts_${date}.md`);
  const report = [
    `# RAG перевірка вторинних актів (постанови КМУ, накази, укази) ${date}`,
    '',
    'Запити **без згадки** акту — лише питання за темою. Очікувані rada_nreg з Supabase legislation.',
    '',
    `**Результат:** ${passCount}/${total} PASS`,
    '',
    '| id | pass | found | reason | latencyMs |',
    '|----|------|-------|--------|-----------|',
    ...results.map((r) =>
      `| ${r.id} | ${r.pass ? '✓' : '✗'} | ${r.found.join(', ') || '-'} | ${(r.reason ?? '').slice(0, 60)} | ${r.latencyMs} |`
    ),
    '',
    '## Кейси (запит → очікуваний акт)',
    ...toRun.map((c) => `- **${c.id}:** "${c.query.slice(0, 60)}..." → ${c.expected_rada_nregs.join(', ')}`),
  ].join('\n');
  writeFileSync(reportPath, report, 'utf8');
  console.log('[verify_rag_secondary_acts] report:', reportPath);

  process.exit(passCount === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
