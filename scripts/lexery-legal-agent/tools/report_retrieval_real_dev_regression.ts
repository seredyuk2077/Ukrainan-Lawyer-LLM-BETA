#!/usr/bin/env node
/**
 * Phase 2.1 — Regression report: diff baseline vs current real-dev results.
 * 1) --save=baseline|current: run all DEV cases, write per-case results to _reports/retrieval_real_dev_results_*.json
 * 2) --report [--baseline=path] [--current=path]: generate retrieval_real_dev_regression.md
 *    With both files: list PASS→FAIL, FAIL→PASS, and for each regressed/current FAIL: expected_act_families,
 *    selected_acts (top 5), chunks_evidence_top_acts (top 3), act_candidates_top (top 5), low_confidence, reason_codes.
 *    With only --current: list current FAILs with same detail; note "baseline not provided".
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

const FAMILY_TITLE_SIGNALS: Record<string, RegExp> = {
  criminal: /кримін|кку|злочин|кримінальний\s+кодекс/i,
  criminal_procedure: /кпк|кримінальн.*процес|кримінально.*процесуальн/i,
  civil: /цивіль|цк\s*у|цік|цивільний\s+кодекс/i,
  civil_procedure: /ципк|цпк|цивільн.*процес/i,
  administrative: /адмін|адміністративн/i,
  administrative_offenses: /купап|адмін.*правопоруш|кодекс.*адмін/i,
  tax_customs: /податк|пкку|податковий\s+кодекс/i,
  labor: /працю|труд|кзпп|трудовий|кодекс\s+законів\s+про\s+працю/i,
  labor_social: /труд|кзпп|трудовий\s+кодекс|працю|кодекс\s+законів\s+про\s+працю/i,
  constitutional: /конституц/i,
  anti_corruption: /корупц|протидія.*корупц/i,
  finance_banking: /банк|фінмон|санкц/i,
  admin: /адмін|адміністративн|купап/i,
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
  expectations: {
    expected_act_families: Array<{ family_id: string }>;
    must_have_multi_act: boolean;
    must_have_multi_goal: boolean;
    heuristic_confidence?: number;
    low_confidence?: boolean;
  };
}

interface RunResult {
  retrievalTrace: {
    hits?: Array<{ act_title?: string; title?: string }>;
    meta?: {
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string }>;
      selected_acts?: Array<{ rada_nreg?: string; act_title?: string }>;
      goals_summary?: Array<{ goal_id: string }>;
      low_confidence?: boolean;
      reason_codes?: string[];
      chunks_evidence_top_acts?: Array<{ rada_nreg: string; count_in_top30: number; max_score: number }>;
      selected_acts_decision?: { policy_version?: number; included_from_chunks_evidence?: boolean; reason_codes?: string[] };
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
      if (r.ok && (await r.json()).status === 'healthy') return true;
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
      if (rt != null && typeof rt === 'object' && (rt.meta?.hits_count != null || rt.hits)) {
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
  const distinct = new Set(acts.map((a) => (a as { rada_nreg?: string }).rada_nreg ?? '').filter(Boolean));
  return distinct.size >= 2;
}

export interface PerCaseResult {
  index: number;
  query: string;
  expected_act_families: string[];
  pass: boolean;
  actFamilyHit: boolean;
  multiGoalCorrect: boolean;
  multiActCorrect: boolean;
  low_confidence: boolean;
  latencyMs: number;
  selected_acts_top5: Array<{ rada_nreg?: string; act_title?: string }>;
  act_candidates_top5: Array<{ rada_nreg?: string; title?: string }>;
  chunks_evidence_top3: Array<{ rada_nreg: string; count_in_top30: number; max_score: number }>;
  reason_codes: string[];
  selected_acts_decision_reason_codes: string[];
  included_from_chunks_evidence: boolean;
}

async function runAllAndCollect(dev: LabeledRow[], baseUrl: string): Promise<PerCaseResult[]> {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const userId = '00000000-0000-0000-0000-000000000002';
  const out: PerCaseResult[] = [];
  for (let i = 0; i < dev.length; i++) {
    const row = dev[i];
    const run = await runQuery(baseUrl, row.query, tenantId, userId);
    const rt = run.retrievalTrace;
    const exp = row.expectations;
    const actFamilyHit = checkActFamilyHit(rt, exp.expected_act_families);
    const multiGoalCorrect = checkMultiGoalCorrect(rt, exp.must_have_multi_goal);
    const multiActCorrect = checkMultiActCorrect(rt, exp.must_have_multi_act);
    const pass = actFamilyHit && multiGoalCorrect && multiActCorrect;
    const selectedActs = rt?.meta?.selected_acts ?? [];
    const actCandidates = rt?.meta?.act_candidates_top ?? [];
    const chunksEvidence = rt?.meta?.chunks_evidence_top_acts ?? [];
    const reasonCodes = rt?.meta?.reason_codes ?? [];
    const decisionReasonCodes = rt?.meta?.selected_acts_decision?.reason_codes ?? [];
    out.push({
      index: i + 1,
      query: row.query,
      expected_act_families: exp.expected_act_families.map((f) => f.family_id),
      pass,
      actFamilyHit,
      multiGoalCorrect,
      multiActCorrect,
      low_confidence: !!rt?.meta?.low_confidence,
      latencyMs: run.latencyMs,
      selected_acts_top5: selectedActs.slice(0, 5),
      act_candidates_top5: actCandidates.slice(0, 5),
      chunks_evidence_top3: chunksEvidence.slice(0, 3).map((e) => ({
        rada_nreg: e.rada_nreg,
        count_in_top30: e.count_in_top30,
        max_score: e.max_score,
      })),
      reason_codes: reasonCodes,
      selected_acts_decision_reason_codes: decisionReasonCodes,
      included_from_chunks_evidence: !!rt?.meta?.selected_acts_decision?.included_from_chunks_evidence,
    });
    const label = `#${i + 1} "${row.query.slice(0, 45)}..."`;
    console.log('[regression]', label, pass ? 'PASS' : 'FAIL', run.latencyMs, 'ms');
  }
  return out;
}

function buildReportMarkdown(
  currentResults: PerCaseResult[],
  baselineResults: PerCaseResult[] | null
): string {
  const lines: string[] = [];
  lines.push('# Real-dev regression report');
  lines.push('');
  lines.push('Generated by `pnpm brain:report:retrieval-real-dev-regression`.');
  lines.push('');

  const currentPass = currentResults.filter((r) => r.pass).length;
  const currentTotal = currentResults.length;
  lines.push('## Summary');
  lines.push('');
  lines.push('- **Current:** ' + currentPass + '/' + currentTotal + ' PASS');
  if (baselineResults && baselineResults.length === currentTotal) {
    const baselinePass = baselineResults.filter((r) => r.pass).length;
    lines.push('- **Baseline:** ' + baselinePass + '/' + baselineResults.length + ' PASS');
    const passToFail: PerCaseResult[] = [];
    const failToPass: PerCaseResult[] = [];
    for (let i = 0; i < currentTotal; i++) {
      const cur = currentResults[i];
      const base = baselineResults[i];
      if (base.pass && !cur.pass) passToFail.push(cur);
      if (!base.pass && cur.pass) failToPass.push(cur);
    }
    lines.push('- **PASS→FAIL (regressions):** ' + passToFail.length);
    lines.push('- **FAIL→PASS:** ' + failToPass.length);
    lines.push('');

    if (passToFail.length) {
      lines.push('## Cases that regressed (PASS → FAIL)');
      lines.push('');
      for (const c of passToFail) {
        lines.push('### #' + c.index + ' `' + c.query.slice(0, 60) + '...`');
        lines.push('');
        lines.push('- **expected_act_families:** ' + c.expected_act_families.join(', '));
        lines.push('- **selected_acts (top5):** ' + c.selected_acts_top5.map((a) => a.rada_nreg + ' ' + (a.act_title ?? '')).join(' | '));
        lines.push('- **act_candidates_top (top5):** ' + c.act_candidates_top5.map((a) => a.rada_nreg + ' ' + (a.title ?? '')).join(' | '));
        lines.push('- **chunks_evidence_top_acts (top3):** ' + c.chunks_evidence_top3.map((e) => e.rada_nreg + ' c=' + e.count_in_top30 + ' s=' + e.max_score.toFixed(2)).join(' | '));
        lines.push('- **low_confidence:** ' + c.low_confidence);
        lines.push('- **reason_codes:** ' + (c.reason_codes.length ? c.reason_codes.join(', ') : '(none)'));
        lines.push('- **selected_acts_decision reason_codes:** ' + (c.selected_acts_decision_reason_codes.length ? c.selected_acts_decision_reason_codes.join(', ') : '(none)'));
        lines.push('- **included_from_chunks_evidence:** ' + c.included_from_chunks_evidence);
        lines.push('');
      }
    }
    if (failToPass.length) {
      lines.push('## Cases that improved (FAIL → PASS)');
      lines.push('');
      for (const c of failToPass) {
        lines.push('- #' + c.index + ': `' + c.query.slice(0, 55) + '...`');
      }
      lines.push('');
    }
  } else {
    lines.push('- **Baseline:** not provided. Run with `--save=baseline` on pre–selected_acts-2.0 code to get baseline, then `--report --baseline=... --current=...`.');
    lines.push('');
  }

  const currentFails = currentResults.filter((r) => !r.pass);
  lines.push('## Current FAIL cases (detail)');
  lines.push('');
  for (const c of currentFails) {
    lines.push('### #' + c.index + ' `' + c.query.slice(0, 60) + '...`');
    lines.push('');
    lines.push('- **expected_act_families:** ' + c.expected_act_families.join(', '));
    lines.push('- **selected_acts (top5):** ' + c.selected_acts_top5.map((a) => a.rada_nreg + ' ' + (a.act_title ?? '')).join(' | '));
    lines.push('- **act_candidates_top (top5):** ' + c.act_candidates_top5.map((a) => a.rada_nreg + ' ' + (a.title ?? '')).join(' | '));
    lines.push('- **chunks_evidence_top_acts (top3):** ' + c.chunks_evidence_top3.map((e) => e.rada_nreg + ' c=' + e.count_in_top30 + ' s=' + e.max_score.toFixed(2)).join(' | '));
    lines.push('- **low_confidence:** ' + c.low_confidence);
    lines.push('- **reason_codes:** ' + (c.reason_codes.length ? c.reason_codes.join(', ') : '(none)'));
    lines.push('- **selected_acts_decision reason_codes:** ' + (c.selected_acts_decision_reason_codes.length ? c.selected_acts_decision_reason_codes.join(', ') : '(none)'));
    lines.push('- **included_from_chunks_evidence:** ' + c.included_from_chunks_evidence);
    lines.push('');
  }

  lines.push('## Conclusion (policy terms)');
  lines.push('');
  if (baselineResults && baselineResults.length === currentTotal) {
    const passToFailCount = currentResults.filter((c, i) => baselineResults[i].pass && !c.pass).length;
    if (passToFailCount > 0) {
      lines.push('- **Regression:** ' + passToFailCount + ' cases moved from PASS to FAIL. Likely causes: (1) selected_acts policy is stricter (evidence-only) so expected family appears in act_candidates_top/hits but not in selected_acts and verifier may rely on union; (2) evidence thresholds (count≥3 / max_score≥0.55) exclude acts that were previously in the list; (3) diversity cap reduced act list size so expected act dropped from top-N.');
    } else {
      lines.push('- No PASS→FAIL regressions; current KPI vs baseline unchanged or improved.');
    }
  } else {
    lines.push('- Provide baseline results to get PASS→FAIL / FAIL→PASS and conclusion.');
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveMode = args.find((a) => a.startsWith('--save='))?.split('=')[1]; // 'baseline' | 'current'
  const reportMode = args.includes('--report');
  const baselinePath = args.find((a) => a.startsWith('--baseline='))?.slice('--baseline='.length);
  const currentPath = args.find((a) => a.startsWith('--current='))?.slice('--current='.length);

  const labeledPath = resolve(__dirname, '_datasets', 'retrieval_real_labeled.json');
  let labeled: LabeledRow[];
  try {
    labeled = JSON.parse(readFileSync(labeledPath, 'utf8')) as LabeledRow[];
  } catch {
    console.error('[report_retrieval_real_dev_regression] Run brain:dataset:retrieval-real and brain:label:retrieval-expectations first.');
    process.exit(1);
  }
  const { dev } = splitLabeled(labeled);
  const reportDir = resolve(__dirname, '_reports');
  mkdirSync(reportDir, { recursive: true });

  if (reportMode) {
    const currentFile = currentPath ?? resolve(reportDir, 'retrieval_real_dev_results_current.json');
    let currentResults: PerCaseResult[];
    try {
      currentResults = JSON.parse(readFileSync(currentFile, 'utf8')) as PerCaseResult[];
    } catch {
      console.error('[report_retrieval_real_dev_regression] Missing or invalid current results:', currentFile);
      process.exit(1);
    }
    let baselineResults: PerCaseResult[] | null = null;
    if (baselinePath) {
      try {
        baselineResults = JSON.parse(readFileSync(baselinePath, 'utf8')) as PerCaseResult[];
      } catch {
        console.error('[report_retrieval_real_dev_regression] Invalid baseline file:', baselinePath);
        process.exit(1);
      }
    }
    const md = buildReportMarkdown(currentResults, baselineResults);
    const outPath = resolve(reportDir, 'retrieval_real_dev_regression.md');
    writeFileSync(outPath, md, 'utf8');
    console.log('[report_retrieval_real_dev_regression] Wrote', outPath);
    return;
  }

  if (!saveMode || !['baseline', 'current'].includes(saveMode)) {
    console.log('Usage: --save=baseline|current   OR   --report [--baseline=path] [--current=path]');
    process.exit(1);
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let results: PerCaseResult[] = [];
  try {
    const ok = await waitHealth(baseUrl);
    if (!ok) {
      console.error('[report_retrieval_real_dev_regression] Health failed');
      process.exit(1);
    }
    results = await runAllAndCollect(dev, baseUrl);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS));
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }

  const outFile = resolve(reportDir, `retrieval_real_dev_results_${saveMode}.json`);
  writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
  console.log('[report_retrieval_real_dev_regression] Wrote', outFile, '| PASS', results.filter((r) => r.pass).length + '/' + results.length);
}

function baselineTotal(_: PerCaseResult[]): number {
  return 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
