#!/usr/bin/env node
/**
 * Phase 5.2 — Verify retrieval on DEV set (70% of real labeled queries).
 * Runs queries via local server; asserts only on expectations (act families, multi-goal, multi-act). No article-level assertions.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { splitLabeled } from './retrieval_real_split.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FLAKY_CHECK_ENABLED =
  process.env.REAL_DEV_FLAKY_CHECK === '1' || process.argv.includes('--flaky-check');

type VerifyPack = {
  retrieval_real_dev?: { smoke?: number[]; real_dev_fast?: { pass_sample_size?: number; use_stable_fail_list?: boolean }; full?: string };
};

import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;

/** family_id -> regex to match act title (Ukrainian). "general" matches any. labor/labor_social aligned with taxonomy. */
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

/** When expected_confidence < this, act_family_miss counts as soft_fail only. */
const EXPECTED_CONFIDENCE_HARD_THRESHOLD = 0.5;

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
    heuristic_confidence?: number;
  };
}

interface RunResult {
  retrievalTrace: {
    hits?: Array<{ title?: string; act_title?: string }>;
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string }>;
      selected_acts?: Array<{ rada_nreg?: string; act_title?: string }>;
      goals_summary?: Array<{ goal_id: string }>;
      qdrant_calls_count_total?: number;
      hits_cap_applied?: boolean;
      stage_decisions?: { used_llm_planner?: boolean; used_act_planner?: boolean };
      planner?: { tier?: number };
      routing_hints?: {
        enabled?: boolean;
        called?: boolean;
        not_used_reason_codes?: string[];
        used_reason_codes?: string[];
        routing_path?: 'TAXONOMY_FIRST' | 'ACTS_SEARCH' | 'NONE';
      };
      reason_codes?: string[];
      selected_acts_decision?: { reason_codes?: string[] };
      selected_acts_sources_breakdown?: { from_routing_hints?: string[] };
      family_evidence_summary?: { dominant_family_key?: string };
    };
  } | null;
  latencyMs: number;
}

/** Resolve --only=SMOKE|FAST|FULL or ONLY_CASES=0,1,2. Returns indices into dev array or 'all'. */
function getOnlyIndices(devLength: number): number[] | 'all' {
  const onlyCasesEnv = process.env.ONLY_CASES?.trim();
  if (onlyCasesEnv) {
    const indices = onlyCasesEnv.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0 && n < devLength);
    if (indices.length) return indices;
  }
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  if (onlyValue === 'FULL' || !onlyValue) return 'all';
  try {
    const path = resolve(__dirname, '_datasets', 'verify_packs.json');
    if (!existsSync(path)) return 'all';
    const raw = readFileSync(path, 'utf8');
    const packs = JSON.parse(raw) as VerifyPack;
    const pack = packs.retrieval_real_dev;
    if (onlyValue === 'SMOKE' && pack?.smoke?.length) {
      return pack.smoke.filter((i) => i >= 0 && i < devLength);
    }
    if (onlyValue === 'FAST' && pack?.real_dev_fast?.use_stable_fail_list) {
      const stablePath = resolve(__dirname, '_datasets', 'stable_fail_list.json');
      let failIndices: number[] = [];
      if (existsSync(stablePath)) {
        try {
          const data = JSON.parse(readFileSync(stablePath, 'utf8')) as { indices?: number[] };
          failIndices = (data.indices ?? []).filter((i) => Number.isFinite(i) && i >= 0 && i < devLength);
        } catch {
          // ignore
        }
      }
      const passSampleSize = pack.real_dev_fast?.pass_sample_size ?? 10;
      const passIndices: number[] = [];
      for (let i = 0; i < devLength && passIndices.length < passSampleSize; i += 2) passIndices.push(i);
      const combined = [...new Set([...failIndices, ...passIndices])].sort((a, b) => a - b);
      return combined.length ? combined : 'all';
    }
  } catch {
    // no pack
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

async function runQuery(
  baseUrl: string,
  query: string,
  tenantId: string,
  userId: string
): Promise<RunResult> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
    });
    if (postRes.status !== 202) {
      return { retrievalTrace: null, latencyMs: Date.now() - start };
    }
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { retrievalTrace: null, latencyMs: Date.now() - start };
  } catch {
    return { retrievalTrace: null, latencyMs: Date.now() - start };
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
      const run = (await getRes.json()) as { retrieval_trace?: RunResult['retrievalTrace'] };
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object') {
        const meta = rt.meta;
        if (meta?.hits_count != null && meta.hits_count >= 0) {
          return { retrievalTrace: rt, latencyMs: Date.now() - start };
        }
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
    const match = allTitles.some((t) => actTitleMatchesFamily(t, exp.family_id));
    if (match) return true;
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
  if (!rt?.meta?.act_candidates_top?.length) return false;
  const distinct = new Set(rt.meta.act_candidates_top.map((a) => a.rada_nreg ?? a.title ?? '').filter(Boolean));
  return distinct.size >= 2;
}

async function main(): Promise<void> {
  const labeledPath = resolve(__dirname, '_datasets', 'retrieval_real_labeled.json');
  let labeled: LabeledRow[];
  try {
    labeled = JSON.parse(readFileSync(labeledPath, 'utf8')) as LabeledRow[];
  } catch {
    console.error('[verify_retrieval_real_dev] Run brain:dataset:retrieval-real and brain:label:retrieval-expectations first.');
    process.exit(1);
  }
  const { dev } = splitLabeled(labeled);
  const onlyIndices = getOnlyIndices(dev.length);
  const caseIndices = onlyIndices === 'all' ? dev.map((_, i) => i) : onlyIndices;
  const devToRun = caseIndices.map((i) => ({ index: i, row: dev[i] }));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_retrieval_real_dev] port', port, 'DEV cases', devToRun.length, onlyIndices !== 'all' ? `(--only: ${caseIndices.length} cases)` : '', FLAKY_CHECK_ENABLED ? 'flaky_check=ON' : '');

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  type ResultRow = {
    pass: boolean;
    actFamilyHit: boolean;
    multiGoalCorrect: boolean;
    multiActCorrect: boolean;
    lowConf?: boolean;
    softFail?: boolean;
    latencyMs: number;
    hasTrace: boolean;
    qdrantCalls?: number;
    goalsCount?: number;
    hitsCapApplied?: boolean;
    plannerTier?: number;
    llmPlannerUsed?: boolean;
    actPlannerUsed?: boolean;
    actListSize?: number;
    failReasons?: string[];
    routingHintsCalled?: boolean;
    routingHintsUsed?: boolean;
    retrievalTrace?: RunResult['retrievalTrace'];
    /** Set after first pass; when flaky check ON, FAIL cases get re-run and status becomes FAIL_STABLE or FAIL_FLAKY. */
    status?: 'PASS' | 'FAIL_STABLE' | 'FAIL_FLAKY';
  };
  const results: ResultRow[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_retrieval_real_dev] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const { index: i, row } of devToRun) {
      const run = await runQuery(baseUrl, row.query, tenantId, userId);
      const rt = run.retrievalTrace;
      const exp = row.expectations;
      const actFamilyHit = checkActFamilyHit(rt, exp.expected_act_families);
      const multiGoalCorrect = checkMultiGoalCorrect(rt, exp.must_have_multi_goal);
      const multiActCorrect = checkMultiActCorrect(rt, exp.must_have_multi_act);
      const pass = actFamilyHit && multiGoalCorrect && multiActCorrect;
      const expectedConf = exp.heuristic_confidence ?? 0.5;
      const softFail =
        !pass && !actFamilyHit && (multiGoalCorrect && multiActCorrect) && expectedConf < EXPECTED_CONFIDENCE_HARD_THRESHOLD;
      const lowConf = !!rt?.meta?.low_confidence;
      results.push({
        pass,
        actFamilyHit,
        multiGoalCorrect,
        multiActCorrect,
        lowConf,
        softFail,
        latencyMs: run.latencyMs,
        hasTrace: rt != null,
        qdrantCalls: rt?.meta?.qdrant_calls_count_total,
        goalsCount: rt?.meta?.goals_summary?.length,
        hitsCapApplied: rt?.meta?.hits_cap_applied,
        plannerTier: rt?.meta?.planner?.tier,
        llmPlannerUsed: rt?.meta?.stage_decisions?.used_llm_planner,
        actPlannerUsed: rt?.meta?.stage_decisions?.used_act_planner,
        actListSize: (rt?.meta?.selected_acts ?? rt?.meta?.act_candidates_top ?? []).length,
        failReasons: pass ? [] : [(!actFamilyHit && 'act_family_miss'), (!multiGoalCorrect && 'multi_goal_miss'), (!multiActCorrect && 'multi_act_miss')].filter(Boolean) as string[],
        routingHintsCalled: rt?.meta?.routing_hints?.called === true,
        routingHintsUsed:
          (rt?.meta?.selected_acts_sources_breakdown?.from_routing_hints?.length ?? 0) > 0,
        retrievalTrace: rt ?? undefined,
        status: pass ? 'PASS' : undefined,
      });
      const label = `#${i + 1} "${row.query.slice(0, 50)}..."`;
      if (pass) {
        console.log('[verify_retrieval_real_dev]', label, 'PASS');
      } else {
        const reasons: string[] = [];
        if (!actFamilyHit) reasons.push('act_family_miss');
        if (!multiGoalCorrect) reasons.push('multi_goal_miss');
        if (!multiActCorrect) reasons.push('multi_act_miss');
        console.error('[verify_retrieval_real_dev]', label, 'FAIL', reasons.join(', '));
      }
    }

    // Flaky check: re-run each hard-fail case once; set FAIL_STABLE (2/2 fail) or FAIL_FLAKY (1st fail, 2nd pass)
    if (FLAKY_CHECK_ENABLED && healthOk) {
      const hardFailIndices = results
        .map((r, idx) => ({ idx, row: devToRun[idx].row, exp: devToRun[idx].row.expectations }))
        .filter(({ idx }) => !results[idx].pass && !results[idx].softFail);
      for (const { idx, row, exp } of hardFailIndices) {
        const run2 = await runQuery(baseUrl, row.query, tenantId, userId);
        const rt2 = run2.retrievalTrace;
        const actFamilyHit2 = checkActFamilyHit(rt2, exp.expected_act_families);
        const multiGoalCorrect2 = checkMultiGoalCorrect(rt2, exp.must_have_multi_goal);
        const multiActCorrect2 = checkMultiActCorrect(rt2, exp.must_have_multi_act);
        const pass2 = actFamilyHit2 && multiGoalCorrect2 && multiActCorrect2;
        results[idx].status = pass2 ? 'FAIL_FLAKY' : 'FAIL_STABLE';
        if (pass2) {
          console.log('[verify_retrieval_real_dev]', `#${devToRun[idx].index + 1} re-run PASS → FAIL_FLAKY`);
        } else {
          console.log('[verify_retrieval_real_dev]', `#${devToRun[idx].index + 1} re-run FAIL → FAIL_STABLE`);
        }
      }
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === undefined) results[i].status = results[i].pass ? 'PASS' : 'FAIL_STABLE';
      }
    } else {
      for (let i = 0; i < results.length; i++) {
        results[i].status = results[i].pass ? 'PASS' : 'FAIL_STABLE';
      }
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

  const total = devToRun.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failStableCount = results.filter((r) => r.status === 'FAIL_STABLE').length;
  const failFlakyCount = results.filter((r) => r.status === 'FAIL_FLAKY').length;
  const softFailCount = results.filter((r) => r.softFail).length;
  const hardPass = passCount;
  const hardFailCount = failStableCount;
  const allPass = healthOk && total > 0 && passCount === total;
  const actFamilyHitPct = total > 0 ? Math.round((results.filter((r) => r.actFamilyHit).length / total) * 100) : 0;
  const multiGoalPct = total > 0 ? Math.round((results.filter((r) => r.multiGoalCorrect).length / total) * 100) : 0;
  const multiActPct = total > 0 ? Math.round((results.filter((r) => r.multiActCorrect).length / total) * 100) : 0;
  const latenciesAll = results.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50 = latenciesAll.length ? latenciesAll[Math.floor(latenciesAll.length * 0.5)] ?? 0 : 0;
  const p95 = latenciesAll.length ? latenciesAll[Math.min(Math.ceil(latenciesAll.length * 0.95) - 1, latenciesAll.length - 1)] ?? 0 : 0;
  const latenciesPass = results.filter((r) => r.status === 'PASS').map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const latenciesFailStable = results.filter((r) => r.status === 'FAIL_STABLE').map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50Pass = latenciesPass.length ? latenciesPass[Math.floor(latenciesPass.length * 0.5)] ?? 0 : 0;
  const p95Pass = latenciesPass.length ? latenciesPass[Math.min(Math.ceil(latenciesPass.length * 0.95) - 1, latenciesPass.length - 1)] ?? 0 : 0;
  const p50FailStable = latenciesFailStable.length ? latenciesFailStable[Math.floor(latenciesFailStable.length * 0.5)] ?? 0 : 0;
  const p95FailStable = latenciesFailStable.length ? latenciesFailStable[Math.min(Math.ceil(latenciesFailStable.length * 0.95) - 1, latenciesFailStable.length - 1)] ?? 0 : 0;
  const qdrantCalls = results.map((r) => r.qdrantCalls ?? 0).filter((n) => n > 0);
  const medianQdrant = qdrantCalls.length ? qdrantCalls.slice().sort((a, b) => a - b)[Math.floor(qdrantCalls.length / 2)] ?? 0 : 0;
  const maxQdrant = qdrantCalls.length ? Math.max(...qdrantCalls) : 0;
  const hitsCapPct = total > 0 ? Math.round((results.filter((r) => r.hitsCapApplied).length / total) * 100) : 0;
  const plannerTiers = results.map((r) => r.plannerTier ?? 0);
  const tier0 = plannerTiers.filter((t) => t === 0).length;
  const tier1 = plannerTiers.filter((t) => t === 1).length;
  const tier2 = plannerTiers.filter((t) => t === 2).length;
  const llmPlannerPct = total > 0 ? Math.round((results.filter((r) => r.llmPlannerUsed).length / total) * 100) : 0;
  const actPlannerPct = total > 0 ? Math.round((results.filter((r) => r.actPlannerUsed).length / total) * 100) : 0;
  const lowConfPct = total > 0 ? Math.round((results.filter((r) => r.lowConf).length / total) * 100) : 0;
  const actListSizes = results.map((r) => r.actListSize ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const actListSizeMedian = actListSizes.length ? actListSizes[Math.floor(actListSizes.length / 2)] ?? 0 : 0;
  const actListSizeP95 = actListSizes.length ? actListSizes[Math.min(Math.ceil(actListSizes.length * 0.95) - 1, actListSizes.length - 1)] ?? 0 : 0;

  const failReasonsAll = results.flatMap((r) => r.failReasons ?? []);
  const failReasonsStable = results.filter((r) => r.status === 'FAIL_STABLE').flatMap((r) => r.failReasons ?? []);
  const actFamilyMissCount = failReasonsAll.filter((x) => x === 'act_family_miss').length;
  const multiGoalMissCount = failReasonsAll.filter((x) => x === 'multi_goal_miss').length;
  const multiActMissCount = failReasonsAll.filter((x) => x === 'multi_act_miss').length;
  const actFamilyMissStable = failReasonsStable.filter((x) => x === 'act_family_miss').length;
  const multiGoalMissStable = failReasonsStable.filter((x) => x === 'multi_goal_miss').length;
  const multiActMissStable = failReasonsStable.filter((x) => x === 'multi_act_miss').length;
  const flakyDenom = failStableCount + failFlakyCount;
  const flakyPct = flakyDenom > 0 ? Math.round((failFlakyCount / flakyDenom) * 100) : 0;

  console.log('\n--- DEV Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Cases:', `${passCount}/${total}`, allPass ? 'PASS' : 'FAIL');
  console.log('status: PASS=', passCount, 'FAIL_STABLE=', failStableCount, 'FAIL_FLAKY=', failFlakyCount, 'soft_fail=', softFailCount);
  console.log('hard_pass:', hardPass, 'hard_fail (stable only):', hardFailCount);
  if (flakyDenom > 0) console.log('% flaky (of fail re-runs):', flakyPct);
  console.log('% act_family_hit:', actFamilyHitPct);
  console.log('% multi_goal_correct:', multiGoalPct);
  console.log('% multi_act_correct:', multiActPct);
  console.log('% low_confidence:', lowConfPct);
  console.log('act_list_size median:', actListSizeMedian, 'p95:', actListSizeP95);
  console.log('p50 latency ms (all):', Math.round(p50), '| PASS p50:', Math.round(p50Pass), 'p95:', Math.round(p95Pass), '| FAIL_STABLE p50:', Math.round(p50FailStable), 'p95:', Math.round(p95FailStable));
  console.log('p95 latency ms (all):', Math.round(p95));
  console.log('qdrant_calls median:', medianQdrant, 'max:', maxQdrant);
  console.log('planner tier: 0=', tier0, '1=', tier1, '2=', tier2);
  console.log('% llm_planner_used:', llmPlannerPct);
  console.log('% act_planner_used:', actPlannerPct);
  console.log('% hits_cap_applied:', hitsCapPct);
  const routingCalledCount = results.filter((r) => r.routingHintsCalled).length;
  const routingUsedCount = results.filter((r) => r.routingHintsUsed).length;
  const routingCalledPct = total > 0 ? Math.round((routingCalledCount / total) * 100) : 0;
  const routingUsedPct = total > 0 ? Math.round((routingUsedCount / total) * 100) : 0;
  console.log('% routing_hints_called:', routingCalledPct, `(${routingCalledCount}/${total})`);
  console.log('% routing_hints_used:', routingUsedPct, `(${routingUsedCount}/${total})`);
  const notUsedByReason: Record<string, number> = {};
  for (const r of results) {
    const codes = r.retrievalTrace?.meta?.routing_hints?.not_used_reason_codes ?? [];
    for (const c of codes) {
      notUsedByReason[c] = (notUsedByReason[c] ?? 0) + 1;
    }
  }
  const topNotUsedReasons = Object.entries(notUsedByReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topNotUsedReasons.length) {
    console.log('routing_hints top not_used_reason_codes:', topNotUsedReasons.map(([k, v]) => `${k}=${v}`).join(', '));
  }
  const routingPathCounts: Record<string, number> = {};
  for (const r of results) {
    const path = r.retrievalTrace?.meta?.routing_hints?.routing_path ?? 'NONE';
    routingPathCounts[path] = (routingPathCounts[path] ?? 0) + 1;
  }
  if (Object.keys(routingPathCounts).length) {
    console.log('routing_path distribution:', Object.entries(routingPathCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  console.log('--- Top failure reasons (all) ---');
  console.log('act_family_miss:', actFamilyMissCount);
  console.log('multi_goal_miss:', multiGoalMissCount);
  console.log('multi_act_miss:', multiActMissCount);
  console.log('--- Top failure reasons (FAIL_STABLE only) ---');
  console.log('act_family_miss:', actFamilyMissStable);
  console.log('multi_goal_miss:', multiGoalMissStable);
  console.log('multi_act_miss:', multiActMissStable);

  const minHardPassFull = parseInt(process.env.RETRIEVAL_REAL_DEV_MIN_HARD_PASS ?? '30', 10);
  const maxHardFailFull = parseInt(process.env.RETRIEVAL_REAL_DEV_MAX_HARD_FAIL ?? '13', 10);
  const isLimitedRun = Array.isArray(onlyIndices) && onlyIndices.length > 0;
  const minHardPass = isLimitedRun ? Math.max(1, Math.floor(total * 0.6)) : minHardPassFull;
  const maxHardFail = isLimitedRun ? Math.min(total, Math.max(1, Math.ceil(total * 0.3))) : maxHardFailFull;
  const gatePass = hardPass >= minHardPass && hardFailCount <= maxHardFail;
  console.log('--- Quality gate ---');
  if (isLimitedRun) console.log('(limited run: proportional gate 60% pass / 30% max fail)');
  console.log('thresholds: MIN_HARD_PASS=', minHardPass, 'MAX_HARD_FAIL=', maxHardFail);
  console.log('gate:', gatePass ? 'PASS' : 'FAIL', `(hard_pass=${hardPass} >= ${minHardPass} && hard_fail_stable=${hardFailCount} <= ${maxHardFail})`);

  if (isLimitedRun) {
    const reportsDir = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_reports');
    try {
      mkdirSync(reportsDir, { recursive: true });
      const onlyArg = process.argv.find((a) => a.startsWith('--only='));
      const fastResults = {
        run_at: new Date().toISOString(),
        only_mode: onlyArg?.slice('--only='.length) ?? 'custom',
        total,
        pass_count: passCount,
        fail_stable_count: failStableCount,
        fail_flaky_count: failFlakyCount,
        flaky_check_enabled: FLAKY_CHECK_ENABLED,
        cases: devToRun.map(({ index: i, row }, idx) => {
          const r = results[idx];
          const rt = r?.retrievalTrace;
          const meta = rt?.meta;
          return {
            index: i,
            query: row.query.slice(0, 120),
            status: r?.status ?? 'PASS',
            selected_acts: meta?.selected_acts?.map((a) => ({ rada_nreg: a.rada_nreg, act_title: a.act_title })) ?? [],
            reason_codes: meta?.reason_codes ?? meta?.selected_acts_decision?.reason_codes ?? [],
            routing_not_used_reason_codes: meta?.routing_hints?.not_used_reason_codes ?? [],
            routing_path: meta?.routing_hints?.routing_path,
            routing_called: meta?.routing_hints?.called,
            routing_used: (meta?.selected_acts_sources_breakdown?.from_routing_hints?.length ?? 0) > 0,
            dominant_family_key: meta?.family_evidence_summary?.dominant_family_key,
          };
        }),
      };
      writeFileSync(resolve(reportsDir, 'retrieval_real_dev_fast_results.json'), JSON.stringify(fastResults, null, 2), 'utf8');
      console.log('[verify_retrieval_real_dev] wrote _reports/retrieval_real_dev_fast_results.json');
    } catch (e) {
      console.warn('[verify_retrieval_real_dev] could not write fast results:', e);
    }
  }

  const exitCode = allPass ? 0 : gatePass ? 0 : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
