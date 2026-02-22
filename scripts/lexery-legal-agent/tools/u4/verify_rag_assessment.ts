#!/usr/bin/env node
/**
 * RAG глибока перевірка — усі варіанти: явна згадка акту, лише природне питання, поза темою.
 * Запускає сервер, прогоняє кейси з _datasets/rag_assessment_cases.json, оцінює відповідність очікуваним сімействам та low_confidence.
 * Звіт: _reports/rag_assessment_YYYY-MM-DD.md
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

/** family_id -> regex to match act title (Ukrainian). */
const FAMILY_TITLE_SIGNALS: Record<string, RegExp> = {
  criminal: /кримін|кку|злочин|кримінальний\s+кодекс/i,
  criminal_procedure: /кпк|кримінальн.*процес|кримінально.*процесуальн/i,
  civil: /цивіль|цк\s*у|цік|цивільний\s+кодекс|споживач/i,
  civil_procedure: /ципк|цпк|цивільн.*процес/i,
  administrative: /адмін|адміністративн|кас/i,
  administrative_offenses: /купап|адмін.*правопоруш|кодекс.*адмін/i,
  tax_customs: /податк|пкку|податковий\s+кодекс/i,
  tax: /податк|пкку|податковий\s+кодекс/i,
  labor: /працю|труд|кзпп|трудовий|кодекс\s+законів\s+про\s+працю/i,
  labor_social: /труд|кзпп|трудовий\s+кодекс|працю/i,
  constitutional: /конституц/i,
  healthcare: /мед|оздоров|моз|наказ.*2559|охорон.*здоров/i,
  health: /мед|оздоров|моз|наказ|охорон.*здоров/i,
  admin: /адмін|адміністративн|купап|кас/i,
  general: /./,
};

function actTitleMatchesFamily(title: string, familyId: string): boolean {
  if (familyId === 'general') return true;
  const re = FAMILY_TITLE_SIGNALS[familyId];
  if (!re) return title.toLowerCase().includes(familyId.toLowerCase());
  return re.test(title);
}

interface RAGCase {
  id: string;
  type: 'explicit_act' | 'natural_language' | 'out_of_scope';
  query: string;
  description: string;
  expected_families?: string[];
  min_hits?: number;
  expect_low_confidence?: boolean;
}

interface RunPayload {
  retrieval_trace?: {
    hits?: Array<{ title?: string; act_title?: string }>;
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      selected_acts?: Array<{ rada_nreg?: string; act_title?: string }>;
      act_candidates_top?: Array<{ title?: string }>;
      reason_codes?: string[];
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
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { run: null, latencyMs: Date.now() - start };
}

function evaluateCase(c: RAGCase, run: RunPayload | null): { pass: boolean; reason: string; hitsCount: number; lowConf: boolean; familyHit: boolean } {
  const rt = run?.retrieval_trace;
  const meta = rt?.meta;
  const hitsCount = meta?.hits_count ?? 0;
  const lowConf = meta?.low_confidence === true;

  const allTitles: string[] = [
    ...(meta?.selected_acts ?? []).map((a) => a.act_title ?? ''),
    ...(meta?.act_candidates_top ?? []).map((a) => a.title ?? ''),
    ...(rt?.hits ?? []).map((h) => (h.act_title ?? h.title) ?? ''),
  ].filter(Boolean);

  const familyHit =
    (c.expected_families?.length ?? 0) > 0 &&
    c.expected_families.some((fam) => allTitles.some((t) => actTitleMatchesFamily(t, fam)));

  if (c.type === 'out_of_scope') {
    const pass = c.expect_low_confidence ? lowConf || hitsCount < 30 : true;
    return {
      pass,
      reason: pass ? 'low_confidence or few hits' : `expected low_confidence, got hits=${hitsCount} lowConf=${lowConf}`,
      hitsCount,
      lowConf,
      familyHit: false,
    };
  }

  if (c.type === 'explicit_act' || c.type === 'natural_language') {
    const minHits = c.min_hits ?? 1;
    const pass = familyHit && hitsCount >= minHits;
    const reasons: string[] = [];
    if (!familyHit) reasons.push('expected family not in selected_acts/hits');
    if (hitsCount < minHits) reasons.push(`hits ${hitsCount} < min ${minHits}`);
    return {
      pass,
      reason: pass ? 'family hit, min_hits ok' : reasons.join('; '),
      hitsCount,
      lowConf,
      familyHit,
    };
  }

  return { pass: true, reason: 'n/a', hitsCount, lowConf, familyHit: false };
}

async function main(): Promise<void> {
  const casesPath = resolve(__dirname, '../_datasets', 'rag_assessment_cases.json');
  if (!existsSync(casesPath)) {
    console.error('[verify_rag_assessment] Missing', casesPath);
    process.exit(1);
  }
  const cases: RAGCase[] = JSON.parse(readFileSync(casesPath, 'utf8'));

  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toLowerCase();
  let toRun = cases;
  if (onlyValue === 'explicit') toRun = cases.filter((c) => c.type === 'explicit_act');
  else if (onlyValue === 'natural') toRun = cases.filter((c) => c.type === 'natural_language');
  else if (onlyValue === 'out') toRun = cases.filter((c) => c.type === 'out_of_scope');
  else if (onlyValue === 'smoke') toRun = cases.slice(0, 6);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_rag_assessment] port', port, 'cases', toRun.length, onlyValue ? `(--only=${onlyValue})` : '');

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  type Row = { id: string; type: string; pass: boolean; reason: string; hitsCount: number; lowConf: boolean; familyHit: boolean; latencyMs: number };
  const results: Row[] = [];

  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_rag_assessment] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';

    for (const c of toRun) {
      const { run, latencyMs } = await runQuery(baseUrl, c.query, tenantId, userId);
      const ev = evaluateCase(c, run);
      results.push({
        id: c.id,
        type: c.type,
        pass: ev.pass,
        reason: ev.reason,
        hitsCount: ev.hitsCount,
        lowConf: ev.lowConf,
        familyHit: ev.familyHit,
        latencyMs,
      });
      const label = `${c.id} (${c.type})`;
      if (ev.pass) console.log('[verify_rag_assessment]', label, 'PASS', `hits=${ev.hitsCount}`);
      else console.error('[verify_rag_assessment]', label, 'FAIL', ev.reason);
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
  const byType = { explicit_act: 0, natural_language: 0, out_of_scope: 0 };
  results.forEach((r) => {
    if (r.type in byType) (byType as Record<string, number>)[r.type]++;
  });

  console.log('\n--- RAG assessment summary ---');
  console.log('pass:', passCount, '/', total);
  console.log('by type: explicit_act', results.filter((r) => r.type === 'explicit_act').filter((r) => r.pass).length + '/' + byType.explicit_act,
    '| natural_language', results.filter((r) => r.type === 'natural_language').filter((r) => r.pass).length + '/' + byType.natural_language,
    '| out_of_scope', results.filter((r) => r.type === 'out_of_scope').filter((r) => r.pass).length + '/' + byType.out_of_scope);

  const reportDir = resolve(__dirname, '../_reports');
  try {
    mkdirSync(reportDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = resolve(reportDir, `rag_assessment_${date}.md`);
  const report = [
    `# RAG глибока перевірка ${date}`,
    '',
    `**Результат:** ${passCount}/${total} PASS`,
    '',
    '| id | type | pass | hits | lowConf | familyHit | reason |',
    '|----|------|------|------|--------|-----------|--------|',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.type} | ${r.pass ? '✓' : '✗'} | ${r.hitsCount} | ${r.lowConf} | ${r.familyHit} | ${(r.reason ?? '').slice(0, 60)} |`
    ),
    '',
    '## Реальна оцінка',
    '- **Явна згадка акту** (ККУ, ЦКУ, КЗпП, ЦПК, КАС, МОЗ): очікуваний акт/родина має бути в selected_acts або hits.',
    '- **Лише природне питання** (без згадки акту): очікувана правова сім\'я має з\'явитися в результатах, min_hits ≥ 5.',
    '- **Поза темою** (рецепт, гіберіш): очікується low_confidence або мало hits.',
    total === passCount
      ? '- **Висновок:** усі варіанти пройшли — RAG коректно працює для документів з БД і для питань без згадки актів.'
      : '- **Висновок:** є провали — перегляньте кейси з FAIL (family miss, min_hits, low_confidence).',
  ].join('\n');
  writeFileSync(reportPath, report, 'utf8');
  console.log('[verify_rag_assessment] report:', reportPath);

  process.exit(passCount === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
