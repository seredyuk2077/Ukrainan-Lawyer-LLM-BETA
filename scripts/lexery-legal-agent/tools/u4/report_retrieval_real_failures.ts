#!/usr/bin/env node
/**
 * Read-only DEV failure report: labeled dataset + DEV split → run each via server → for each FAIL
 * output query, expectations, selected_acts, act_candidates_top, top hits, meta, first_mismatch_explanation.
 * Classify act_family_miss into A/B/C/D. Write tools/_reports/retrieval_real_dev_failures.md.
 *
 * CLI: --limit N (max cases to run), --offset N (skip first N), --onlyFailIds 1,2,3 (1-based indices to run only),
 *      --timeLimit N (abort after N seconds, write partial report), --concurrency 1 (default; kept for future).
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { splitLabeled } from './retrieval_real_split.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;
const TOP_HITS_N = 15;

const FAMILY_TITLE_SIGNALS: Record<string, RegExp> = {
  criminal: /кримін|кку|злочин|кримінальний\s+кодекс/i,
  criminal_procedure: /кпк|кримінальн.*процес|кримінально.*процесуальн/i,
  civil: /цивіль|цк\s*у|цік|цивільний\s+кодекс/i,
  civil_procedure: /ципк|цпк|цивільн.*процес/i,
  administrative: /адмін|адміністративн/i,
  administrative_offenses: /купап|адмін.*правопоруш|кодекс.*адмін/i,
  tax_customs: /податк|пкку|податковий\s+кодекс/i,
  tax: /податк|пкку|податковий\s+кодекс/i,
  labor_social: /труд|кзпп|трудовий\s+кодекс/i,
  constitutional: /конституц/i,
  anti_corruption: /корупц|протидія.*корупц/i,
  finance_banking: /банк|фінмон|санкц/i,
  other: /./,
};

function actTitleMatchesFamily(title: string, familyId: string): boolean {
  if (familyId === 'general') return true;
  const re = FAMILY_TITLE_SIGNALS[familyId];
  if (!re) return title.toLowerCase().includes(familyId.toLowerCase());
  return re.test(title);
}

interface LabeledRow {
  run_id: string;
  query: string;
  tenant_id_hash: string;
  fingerprint: string;
  expectations: {
    expected_act_families: Array<{ family_id: string }>;
    expected_domains: string[];
    must_have_multi_act: boolean;
    must_have_multi_goal: boolean;
    low_confidence?: boolean;
  };
}

interface RunResult {
  retrievalTrace: {
    hits?: Array<{ title?: string; act_title?: string }>;
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      reason_codes?: string[];
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string; why_selected?: string }>;
      selected_acts?: Array<{ rada_nreg?: string; act_title?: string; why_selected?: string }>;
      goals_summary?: Array<{ goal_id: string }>;
      qdrant_calls_count_total?: number;
      stage_decisions?: { used_llm_planner?: boolean; used_act_planner?: boolean };
      planner?: { tier?: number };
    };
  } | null;
  latencyMs: number;
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
      if (r.ok) {
        const body = (await r.json()) as { status?: string };
        if (body?.status === 'healthy') return true;
      }
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

async function runQuery(baseUrl: string, query: string, tenantId: string, userId: string): Promise<RunResult> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
    });
    if (postRes.status !== 202) return { retrievalTrace: null, latencyMs: Date.now() - start };
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { retrievalTrace: null, latencyMs: Date.now() - start };
  } catch {
    return { retrievalTrace: null, latencyMs: Date.now() - start };
  }
  const pollStart = Date.now();
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
      if (getRes.status !== 200) {
        await sleep(POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as { retrieval_trace?: RunResult['retrievalTrace'] };
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object' && rt.meta?.hits_count != null) {
        return { retrievalTrace: rt, latencyMs: Date.now() - start };
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { retrievalTrace: null, latencyMs: Date.now() - start };
}

function checkActFamilyHit(rt: RunResult['retrievalTrace'], expectedFamilies: Array<{ family_id: string }>): boolean {
  if (!rt || expectedFamilies.length === 0) return true;
  const actCandidates = rt.meta?.act_candidates_top ?? [];
  const selectedActs = rt.meta?.selected_acts ?? [];
  const hits = rt.hits ?? [];
  const allTitles = [
    ...actCandidates.map((a) => a.title ?? ''),
    ...selectedActs.map((a) => a.act_title ?? ''),
    ...hits.map((h) => (h.act_title ?? h.title) ?? ''),
  ].filter(Boolean);
  for (const exp of expectedFamilies) {
    if (exp.family_id === 'general') return true;
    if (allTitles.some((t) => actTitleMatchesFamily(t, exp.family_id))) return true;
  }
  return false;
}

function checkMultiGoalCorrect(rt: RunResult['retrievalTrace'], mustHaveMultiGoal: boolean): boolean {
  if (!mustHaveMultiGoal) return true;
  if (!rt?.meta?.goals_summary) return false;
  return rt.meta.goals_summary.length >= 2;
}

function checkMultiActCorrect(rt: RunResult['retrievalTrace'], mustHaveMultiAct: boolean): boolean {
  if (!mustHaveMultiAct) return true;
  const acts = rt?.meta?.act_candidates_top ?? rt?.meta?.selected_acts ?? [];
  const distinct = new Set(acts.map((a) => (a as { rada_nreg?: string; title?: string }).rada_nreg ?? (a as { rada_nreg?: string; title?: string }).title ?? '').filter(Boolean));
  return distinct.size >= 2;
}

type ActFamilyMissSubclass = 'A' | 'B' | 'C' | 'D';

function classifyActFamilyMiss(
  rt: RunResult['retrievalTrace'],
  row: LabeledRow,
  actFamilyHit: boolean,
  multiActCorrect: boolean
): ActFamilyMissSubclass | null {
  if (actFamilyHit) return null;
  const exp = row.expectations;
  const lowConf = !!rt?.meta?.low_confidence;
  if (lowConf) return 'D';
  if (exp.must_have_multi_act && !multiActCorrect) {
    const acts = rt?.meta?.act_candidates_top ?? rt?.meta?.selected_acts ?? [];
    const distinct = new Set(acts.map((a) => (a as { rada_nreg?: string; title?: string }).rada_nreg ?? (a as { rada_nreg?: string; title?: string }).title ?? '').filter(Boolean));
    if (distinct.size < 2) return 'C';
  }
  const allTitles = [
    ...(rt?.meta?.act_candidates_top ?? []).map((a) => (a as { title?: string }).title ?? ''),
    ...(rt?.meta?.selected_acts ?? []).map((a) => (a as { act_title?: string }).act_title ?? ''),
    ...(rt?.hits ?? []).map((h) => (h.act_title ?? h.title) ?? ''),
  ].filter(Boolean);
  for (const f of exp.expected_act_families) {
    if (f.family_id === 'general') continue;
    const hasFamilyIdSubstring = allTitles.some((t) => t.toLowerCase().includes(f.family_id.toLowerCase()));
    const hasSignalMatch = allTitles.some((t) => actTitleMatchesFamily(t, f.family_id));
    if (hasFamilyIdSubstring && !hasSignalMatch) return 'B';
  }
  return 'A';
}

function firstMismatchExplanation(
  rt: RunResult['retrievalTrace'],
  row: LabeledRow,
  actFamilyHit: boolean,
  multiGoalCorrect: boolean,
  multiActCorrect: boolean
): string {
  const parts: string[] = [];
  if (!actFamilyHit && row.expectations.expected_act_families.length) {
    const expected = row.expectations.expected_act_families.map((f) => f.family_id).join(', ');
    const allTitles = [
      ...(rt?.meta?.selected_acts ?? []).map((a) => (a as { act_title?: string }).act_title ?? ''),
      ...(rt?.meta?.act_candidates_top ?? []).map((a) => (a as { title?: string }).title ?? ''),
      ...(rt?.hits ?? []).slice(0, 5).map((h) => (h.act_title ?? h.title) ?? ''),
    ].filter(Boolean);
    parts.push(`Expected family/families: ${expected}. Verifier checks FAMILY_TITLE_SIGNALS (regex). No title in selected_acts/act_candidates_top/top hits matched. Sample titles: ${allTitles.slice(0, 5).join('; ') || '(none)'}.`);
  }
  if (!multiGoalCorrect && row.expectations.must_have_multi_goal) {
    const goalsCount = rt?.meta?.goals_summary?.length ?? 0;
    parts.push(`Expected multi-goal but goals_summary length=${goalsCount}.`);
  }
  if (!multiActCorrect && row.expectations.must_have_multi_act) {
    const acts = rt?.meta?.act_candidates_top ?? rt?.meta?.selected_acts ?? [];
    const distinct = new Set(acts.map((a) => (a as { rada_nreg?: string; title?: string }).rada_nreg ?? (a as { rada_nreg?: string; title?: string }).title ?? '').filter(Boolean));
    parts.push(`Expected multi-act but distinct acts=${distinct.size}.`);
  }
  return parts.join(' ') || 'Unknown mismatch.';
}

function parseCli(): { limit: number; offset: number; onlyFailIds: number[]; timeLimitSec: number; concurrency: number } {
  const args = process.argv.slice(2);
  let limit = 0;
  let offset = 0;
  let onlyFailIds: number[] = [];
  let timeLimitSec = 0;
  let concurrency = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1] != null) {
      limit = Math.max(0, parseInt(args[++i], 10) || 0);
    } else if (args[i] === '--offset' && args[i + 1] != null) {
      offset = Math.max(0, parseInt(args[++i], 10) || 0);
    } else if (args[i] === '--onlyFailIds' && args[i + 1] != null) {
      onlyFailIds = args[++i]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1);
    } else if (args[i] === '--timeLimit' && args[i + 1] != null) {
      timeLimitSec = Math.max(0, parseInt(args[++i], 10) || 0);
    } else if (args[i] === '--concurrency' && args[i + 1] != null) {
      concurrency = Math.max(1, Math.min(1, parseInt(args[++i], 10) || 1));
    }
  }
  return { limit, offset, onlyFailIds, timeLimitSec, concurrency };
}

async function main(): Promise<void> {
  const cli = parseCli();
  const labeledPath = resolve(__dirname, '../_datasets', 'retrieval_real_labeled.json');
  let labeled: LabeledRow[];
  try {
    labeled = JSON.parse(readFileSync(labeledPath, 'utf8')) as LabeledRow[];
  } catch {
    console.error('[report_retrieval_real_failures] Run brain:dataset:retrieval-real and brain:label:retrieval-expectations first.');
    process.exit(1);
  }
  const { dev } = splitLabeled(labeled);
  let indicesToRun: number[];
  if (cli.onlyFailIds.length > 0) {
    indicesToRun = cli.onlyFailIds.filter((idx) => idx >= 1 && idx <= dev.length);
    console.log('[report_retrieval_real_failures] onlyFailIds:', cli.onlyFailIds, '-> running', indicesToRun.length);
  } else {
    const start = cli.offset;
    const end = cli.limit > 0 ? Math.min(dev.length, start + cli.limit) : dev.length;
    indicesToRun = [];
    for (let i = start; i < end; i++) indicesToRun.push(i);
    if (cli.limit > 0 || cli.offset > 0) {
      console.log('[report_retrieval_real_failures] limit=', cli.limit || 'all', 'offset=', cli.offset, '-> running', indicesToRun.length);
    }
  }
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[report_retrieval_real_failures] port', port, 'DEV total', dev.length, 'cases to run', indicesToRun.length);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  const failures: {
    index: number;
    row: LabeledRow;
    run: RunResult;
    actFamilyHit: boolean;
    multiGoalCorrect: boolean;
    multiActCorrect: boolean;
    subclass: ActFamilyMissSubclass | null;
    firstMismatch: string;
  }[] = [];
  const allResults: { index: number; pass: boolean; latencyMs: number; qdrantCalls?: number }[] = [];
  const timeLimitMs = cli.timeLimitSec > 0 ? cli.timeLimitSec * 1000 : 0;
  const runStart = Date.now();

  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[report_retrieval_real_failures] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const i of indicesToRun) {
      if (timeLimitMs > 0 && Date.now() - runStart >= timeLimitMs) {
        console.log('[report_retrieval_real_failures] timeLimit reached, stopping. Partial report will be written.');
        break;
      }
      const row = dev[i];
      const run = await runQuery(baseUrl, row.query, tenantId, userId);
      const rt = run.retrievalTrace;
      const exp = row.expectations;
      const actFamilyHit = checkActFamilyHit(rt, exp.expected_act_families);
      const multiGoalCorrect = checkMultiGoalCorrect(rt, exp.must_have_multi_goal);
      const multiActCorrect = checkMultiActCorrect(rt, exp.must_have_multi_act);
      const pass = actFamilyHit && multiGoalCorrect && multiActCorrect;
      allResults.push({
        index: i + 1,
        pass,
        latencyMs: run.latencyMs,
        qdrantCalls: rt?.meta?.qdrant_calls_count_total,
      });
      if (pass) {
        console.log('[report_retrieval_real_failures]', `#${i + 1}`, 'PASS');
        continue;
      }
      const subclass = classifyActFamilyMiss(rt, row, actFamilyHit, multiActCorrect);
      const firstMismatch = firstMismatchExplanation(rt, row, actFamilyHit, multiGoalCorrect, multiActCorrect);
      failures.push({
        index: i + 1,
        row,
        run,
        actFamilyHit,
        multiGoalCorrect,
        multiActCorrect,
        subclass,
        firstMismatch,
      });
      console.log('[report_retrieval_real_failures]', `#${i + 1}`, 'FAIL', subclass ?? 'multi_goal/multi_act');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS));
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }

  const reportDir = resolve(__dirname, '../_reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, 'retrieval_real_dev_failures.md');

  const runCount = allResults.length;
  const passCount = allResults.filter((r) => r.pass).length;
  const failCount = failures.length;
  const failPct = runCount > 0 ? Math.round((failCount / runCount) * 100) : 0;
  const latencies = allResults.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const qdrantCalls = allResults.map((r) => r.qdrantCalls ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const latencyMedian = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : 0;
  const latencyP95 = latencies.length ? latencies[Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1)] ?? 0 : 0;
  const qdrantMedian = qdrantCalls.length ? qdrantCalls[Math.floor(qdrantCalls.length / 2)]! : 0;

  const subclassCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const f of failures) {
    if (f.subclass) subclassCounts[f.subclass]++;
  }
  console.log('\n--- Baseline (this run) ---');
  console.log('Cases run:', runCount, 'PASS:', passCount, 'FAIL:', failCount, '% fail:', failPct + '%');
  console.log('Latency median ms:', Math.round(latencyMedian), 'p95 ms:', Math.round(latencyP95));
  console.log('qdrant_calls median:', qdrantMedian);
  console.log('Subclass A:', subclassCounts.A, 'B:', subclassCounts.B, 'C:', subclassCounts.C, 'D:', subclassCounts.D);

  const lines: string[] = [
    '# Retrieval real DEV failures report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Cases run: ${runCount} | PASS: ${passCount} | FAIL: ${failCount} | % fail: ${failPct}%`,
    `Latency median ms: ${Math.round(latencyMedian)} | p95 ms: ${Math.round(latencyP95)} | qdrant_calls median: ${qdrantMedian}`,
    '',
    '## Classification (act_family_miss)',
    '- **A** Planner chose wrong act family',
    '- **B** Correct act present but verifier missed signal (title/aliases vs stem signals)',
    '- **C** Multi-act needed but only 1 act selected',
    '- **D** Unknown/low confidence case',
    '',
  ];

  lines.push('| Subclass | Count |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(subclassCounts)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');

  for (const f of failures) {
    const rt = f.run.retrievalTrace;
    const meta = rt?.meta;
    const selectedActs = meta?.selected_acts ?? meta?.act_candidates_top ?? [];
    const topHits = (rt?.hits ?? []).slice(0, TOP_HITS_N).map((h) => (h.act_title ?? h.title) ?? '').filter(Boolean);
    lines.push(`---`);
    lines.push(`### FAIL #${f.index}`);
    lines.push('');
    lines.push(`**Query:** ${f.row.query}`);
    lines.push('');
    lines.push(`**Expectations:**`);
    lines.push(`- expected_act_families: ${JSON.stringify(f.row.expectations.expected_act_families.map((x) => x.family_id))}`);
    lines.push(`- expected_domains: ${JSON.stringify(f.row.expectations.expected_domains)}`);
    lines.push(`- must_multi_act: ${f.row.expectations.must_have_multi_act}, must_multi_goal: ${f.row.expectations.must_have_multi_goal}`);
    lines.push('');
    lines.push(`**Selected acts:**`);
    for (const a of selectedActs) {
      const x = a as { rada_nreg?: string; act_title?: string; title?: string; why_selected?: string };
      lines.push(`- ${x.rada_nreg ?? '-'} | ${x.act_title ?? x.title ?? '-'} | ${x.why_selected ?? '-'}`);
    }
    if (selectedActs.length === 0) lines.push('- (none)');
    lines.push('');
    lines.push(`**Top ${TOP_HITS_N} hits (act_title/title):**`);
    for (const t of topHits) lines.push(`- ${t}`);
    if (topHits.length === 0) lines.push('- (none)');
    lines.push('');
    lines.push(`**Meta:**`);
    lines.push(`- used_act_planner: ${!!meta?.stage_decisions?.used_act_planner}, planner tier: ${meta?.planner?.tier ?? '-'}`);
    lines.push(`- low_confidence: ${!!meta?.low_confidence}, reason_codes: ${JSON.stringify(meta?.reason_codes ?? [])}`);
    lines.push(`- qdrant_calls_count_total: ${meta?.qdrant_calls_count_total ?? '-'}, latency_ms: ${f.run.latencyMs}`);
    lines.push('');
    lines.push(`**First mismatch:** ${f.firstMismatch}`);
    lines.push('');
    lines.push(`**Subclass (act_family_miss):** ${f.subclass ?? 'n/a (multi_goal/multi_act only)'}`);
    lines.push('');
  }

  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log('[report_retrieval_real_failures] Report written to', reportPath);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
