#!/usr/bin/env node
/**
 * Phase 5.2 — Verify retrieval on HOLDOUT set (30% of real labeled queries).
 * Same as real-dev but uses holdout slice. Run only at final before commit.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
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
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string }>;
      goals_summary?: Array<{ goal_id: string }>;
      qdrant_calls_count_total?: number;
      hits_cap_applied?: boolean;
      stage_decisions?: { used_llm_planner?: boolean };
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
      if (r.ok && (await r.json()).status === 'healthy') return true;
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
  const normalizeFamilyId = (familyId: string | undefined): string | undefined => {
    switch ((familyId ?? '').trim().toLowerCase()) {
      case 'tax':
      case 'tax_customs':
        return 'tax_customs';
      case 'labor':
      case 'labor_social':
        return 'labor_social';
      case 'admin':
      case 'administrative':
        return 'administrative';
      case 'administrative_offenses':
        return 'administrative_offenses';
      default:
        return familyId?.trim().toLowerCase();
    }
  };
  const actCandidates = rt.meta?.act_candidates_top ?? [];
  const selectedActs = rt.meta?.selected_acts ?? [];
  const hits = rt.hits ?? [];
  const dominantFamilyKey = normalizeFamilyId(rt.meta?.family_evidence_summary?.dominant_family_key);
  const allTitles = [
    ...actCandidates.map((a) => a.title ?? ''),
    ...selectedActs.map((a) => a.act_title ?? ''),
    ...hits.map((h) => (h.act_title ?? h.title) ?? ''),
  ].filter(Boolean);
  for (const exp of expectedFamilies) {
    if (exp.family_id === 'general') return true;
    const normalizedExpected = normalizeFamilyId(exp.family_id);
    if (dominantFamilyKey && normalizedExpected && dominantFamilyKey === normalizedExpected) return true;
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
  const labeledPath = resolve(__dirname, '../_datasets', 'retrieval_real_labeled.json');
  let labeled: LabeledRow[];
  try {
    labeled = JSON.parse(readFileSync(labeledPath, 'utf8')) as LabeledRow[];
  } catch {
    console.error('[verify_retrieval_real_holdout] Run brain:dataset:retrieval-real and brain:label:retrieval-expectations first.');
    process.exit(1);
  }
  const { holdout } = splitLabeled(labeled);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_retrieval_real_holdout] port', port, 'HOLDOUT cases', holdout.length);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  const results: {
    pass: boolean;
    actFamilyHit: boolean;
    multiGoalCorrect: boolean;
    multiActCorrect: boolean;
    lowConf?: boolean;
    latencyMs: number;
    hasTrace: boolean;
    qdrantCalls?: number;
    goalsCount?: number;
    hitsCapApplied?: boolean;
    plannerTier?: number;
    llmPlannerUsed?: boolean;
    failReasons?: string[];
  }[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_retrieval_real_holdout] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (let i = 0; i < holdout.length; i++) {
      const row = holdout[i];
      const run = await runQuery(baseUrl, row.query, tenantId, userId);
      const rt = run.retrievalTrace;
      const exp = row.expectations;
      const actFamilyHit = checkActFamilyHit(rt, exp.expected_act_families);
      const multiGoalCorrect = checkMultiGoalCorrect(rt, exp.must_have_multi_goal);
      const multiActCorrect = checkMultiActCorrect(rt, exp.must_have_multi_act);
      const pass = actFamilyHit && multiGoalCorrect && multiActCorrect;
      const lowConf = !!rt?.meta?.low_confidence;
      results.push({
        pass,
        actFamilyHit,
        multiGoalCorrect,
        multiActCorrect,
        lowConf,
        latencyMs: run.latencyMs,
        hasTrace: rt != null,
        qdrantCalls: rt?.meta?.qdrant_calls_count_total,
        goalsCount: rt?.meta?.goals_summary?.length,
        hitsCapApplied: rt?.meta?.hits_cap_applied,
        plannerTier: rt?.meta?.planner?.tier,
        llmPlannerUsed: rt?.meta?.stage_decisions?.used_llm_planner,
        failReasons: pass ? [] : [(!actFamilyHit && 'act_family_miss'), (!multiGoalCorrect && 'multi_goal_miss'), (!multiActCorrect && 'multi_act_miss')].filter(Boolean) as string[],
      });
      const label = `#${i + 1} "${row.query.slice(0, 50)}..."`;
      if (pass) {
        console.log('[verify_retrieval_real_holdout]', label, 'PASS');
      } else {
        const reasons: string[] = [];
        if (!actFamilyHit) reasons.push('act_family_miss');
        if (!multiGoalCorrect) reasons.push('multi_goal_miss');
        if (!multiActCorrect) reasons.push('multi_act_miss');
        console.error('[verify_retrieval_real_holdout]', label, 'FAIL', reasons.join(', '));
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

  const passed = results.filter((r) => r.pass).length;
  const total = holdout.length;
  const allPass = healthOk && total > 0 && passed === total;
  const actFamilyHitPct = total > 0 ? Math.round((results.filter((r) => r.actFamilyHit).length / total) * 100) : 0;
  const multiGoalPct = total > 0 ? Math.round((results.filter((r) => r.multiGoalCorrect).length / total) * 100) : 0;
  const multiActPct = total > 0 ? Math.round((results.filter((r) => r.multiActCorrect).length / total) * 100) : 0;
  const latencies = results.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] ?? 0 : 0;
  const p95 = latencies.length ? latencies[Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1)] ?? 0 : 0;
  const qdrantCalls = results.map((r) => r.qdrantCalls ?? 0).filter((n) => n > 0);
  const medianQdrant = qdrantCalls.length ? qdrantCalls.slice().sort((a, b) => a - b)[Math.floor(qdrantCalls.length / 2)] ?? 0 : 0;
  const maxQdrant = qdrantCalls.length ? Math.max(...qdrantCalls) : 0;
  const hitsCapPct = total > 0 ? Math.round((results.filter((r) => r.hitsCapApplied).length / total) * 100) : 0;
  const plannerTiers = results.map((r) => r.plannerTier ?? 0);
  const tier0 = plannerTiers.filter((t) => t === 0).length;
  const tier1 = plannerTiers.filter((t) => t === 1).length;
  const tier2 = plannerTiers.filter((t) => t === 2).length;
  const llmPlannerPct = total > 0 ? Math.round((results.filter((r) => r.llmPlannerUsed).length / total) * 100) : 0;
  const lowConfPct = total > 0 ? Math.round((results.filter((r) => r.lowConf).length / total) * 100) : 0;
  const failReasons = results.flatMap((r) => r.failReasons ?? []);
  const actFamilyMissCount = failReasons.filter((x) => x === 'act_family_miss').length;
  const multiGoalMissCount = failReasons.filter((x) => x === 'multi_goal_miss').length;
  const multiActMissCount = failReasons.filter((x) => x === 'multi_act_miss').length;

  console.log('\n--- HOLDOUT Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Cases:', `${passed}/${total}`, allPass ? 'PASS' : 'FAIL');
  console.log('% act_family_hit:', actFamilyHitPct);
  console.log('% multi_goal_correct:', multiGoalPct);
  console.log('% multi_act_correct:', multiActPct);
  console.log('% low_confidence:', lowConfPct);
  console.log('p50 latency ms:', Math.round(p50));
  console.log('p95 latency ms:', Math.round(p95));
  console.log('qdrant_calls median:', medianQdrant, 'max:', maxQdrant);
  console.log('planner tier: 0=', tier0, '1=', tier1, '2=', tier2);
  console.log('% llm_planner_used:', llmPlannerPct);
  console.log('% hits_cap_applied:', hitsCapPct);
  console.log('--- Top failure reasons ---');
  console.log('act_family_miss:', actFamilyMissCount);
  console.log('multi_goal_miss:', multiGoalMissCount);
  console.log('multi_act_miss:', multiActMissCount);

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
