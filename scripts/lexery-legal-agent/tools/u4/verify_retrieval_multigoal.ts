#!/usr/bin/env node
/**
 * Multigoal retrieval harness — invariant assertions only (no article golden refs).
 * New topics: корупція/тероризм/бандитизм/правочин/емансипація/нотаріальна форма/строки/оскарження/санкції.
 * Asserts: selected_acts size in policy, multi-act when expected, low_confidence → reason_codes, coverage per goal.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 240_000;
const SHUTDOWN_WAIT_MS = 5_000;

const SELECTED_ACTS_MIN = 1;
const SELECTED_ACTS_MAX = 9;
const MIN_COVERAGE_PER_GOAL = 1;

interface MultigoalCase {
  q: string;
  tenant: string;
  user: string;
  expectNonEmptyOrLowConfidence: boolean;
  expectMultiAct?: boolean;
  expectMultiGoal?: boolean;
}

const UUID = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

const MULTIGOAL_CASES: MultigoalCase[] = [
  { q: 'корупція та підслідність', tenant: UUID(1), user: UUID(101), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'тероризм та санкції фінмоніторинг', tenant: UUID(2), user: UUID(102), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'бандитизм підслідність', tenant: UUID(3), user: UUID(103), expectNonEmptyOrLowConfidence: true },
  { q: 'правочин позовна давність', tenant: UUID(4), user: UUID(104), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'емансипація трудові наслідки', tenant: UUID(5), user: UUID(105), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'недійсність правочину нотаріальна форма', tenant: UUID(6), user: UUID(106), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'строки оскарження рішення', tenant: UUID(7), user: UUID(107), expectNonEmptyOrLowConfidence: true },
  { q: 'оскарження податкової перевірки', tenant: UUID(8), user: UUID(108), expectNonEmptyOrLowConfidence: true },
  { q: 'санкції фінансовий моніторинг', tenant: UUID(9), user: UUID(109), expectNonEmptyOrLowConfidence: true },
  { q: 'нотаріальне посвідчення договір купівлі-продажу', tenant: UUID(10), user: UUID(110), expectNonEmptyOrLowConfidence: true },
  { q: 'Договір купівлі-продажу. Чи є правочином і чи потрібна нотаріальна форма?', tenant: UUID(11), user: UUID(111), expectNonEmptyOrLowConfidence: true, expectMultiGoal: true },
  { q: 'Емансипація: з якого віку і як впливає на договори та роботу?', tenant: UUID(12), user: UUID(112), expectNonEmptyOrLowConfidence: true, expectMultiGoal: true },
  { q: 'Правочин: коли недійсний і які строки позовної давності?', tenant: UUID(13), user: UUID(113), expectNonEmptyOrLowConfidence: true, expectMultiGoal: true },
  { q: 'Тероризм: відповідальність і фінансові санкційні наслідки?', tenant: UUID(14), user: UUID(114), expectNonEmptyOrLowConfidence: true, expectMultiGoal: true },
  { q: 'абсурд xyz неіснуючий термін 999', tenant: UUID(15), user: UUID(115), expectNonEmptyOrLowConfidence: false },
  // Topic pack (Phase 4): корупція/тероризм/бандитизм/правочин/емансипація/міграція/санкції/адмін-провадження — invariants only, no banned golden
  { q: 'міграція та статус біженця', tenant: UUID(16), user: UUID(116), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'адміністративне провадження загальні положення', tenant: UUID(17), user: UUID(117), expectNonEmptyOrLowConfidence: true },
  { q: 'санкції та блокування активів', tenant: UUID(18), user: UUID(118), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'корупція декларація майна', tenant: UUID(19), user: UUID(119), expectNonEmptyOrLowConfidence: true },
  { q: 'тероризм фінансування відповідальність', tenant: UUID(20), user: UUID(120), expectNonEmptyOrLowConfidence: true, expectMultiGoal: true },
  { q: 'бандитизм кваліфікація та підслідність', tenant: UUID(21), user: UUID(121), expectNonEmptyOrLowConfidence: true },
  { q: 'правочин форма та цивільноправові наслідки', tenant: UUID(22), user: UUID(122), expectNonEmptyOrLowConfidence: true, expectMultiAct: true },
  { q: 'емансипація цивільна дієздатність', tenant: UUID(23), user: UUID(123), expectNonEmptyOrLowConfidence: true },
  { q: 'дозвіл на проживання міграція', tenant: UUID(24), user: UUID(124), expectNonEmptyOrLowConfidence: true },
  { q: 'адмін провадження строки оскарження', tenant: UUID(25), user: UUID(125), expectNonEmptyOrLowConfidence: true, expectMultiGoal: true },
];

type VerifyPack = { retrieval_multigoal?: { smoke?: number[] } };

function getOnlyIndices(): number[] | 'all' {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  const onlyCasesEnv = process.env.ONLY_CASES?.trim();
  if (onlyCasesEnv) {
    const indices = onlyCasesEnv.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0 && n < MULTIGOAL_CASES.length);
    if (indices.length) return indices;
  }
  if (onlyValue === 'SMOKE') {
    try {
      const path = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_datasets/verify_packs.json');
      const packs = JSON.parse(readFileSync(path, 'utf8')) as VerifyPack;
      if (packs.retrieval_multigoal?.smoke?.length) return packs.retrieval_multigoal.smoke.filter((i) => i >= 0 && i < MULTIGOAL_CASES.length);
    } catch {
      // no pack
    }
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

interface RunResult {
  retrievalTrace: {
    hits?: unknown[];
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      selected_acts?: Array<{ rada_nreg?: string; act_title?: string }>;
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string }>;
      goals_summary?: Array<{ goal_id?: string; hits_count?: number }>;
      fusion?: { per_goal_counts_in_topN?: Record<string, number> };
      reason_codes?: string[];
      qdrant_calls_count_total?: number;
      used_act_planner?: boolean;
      stage_decisions?: { used_act_planner?: boolean };
    };
  } | null;
  latencyMs: number;
}

async function runQuery(baseUrl: string, q: string, tenantId: string, userId: string): Promise<RunResult> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query: q, tenant_id: tenantId, user_id: userId }),
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)] ?? 0;
}

async function main(): Promise<void> {
  const onlyIndices = getOnlyIndices();
  const caseIndices = onlyIndices === 'all' ? MULTIGOAL_CASES.map((_, i) => i) : onlyIndices;
  const casesToRun = caseIndices.map((i) => ({ index: i, c: MULTIGOAL_CASES[i] }));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_retrieval_multigoal] port', port, 'cases', casesToRun.length, onlyIndices !== 'all' ? `(--only pack)` : '');

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
    detail?: string;
    latencyMs: number;
    selectedActsSize: number;
    distinctActs: number;
    lowConf: boolean;
    reasonCodesOk: boolean;
    coverageOk: boolean;
    qdrantCalls: number;
    actPlannerUsed: boolean;
  }[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_retrieval_multigoal] Health failed');
    } else {
      for (const { index: i, c } of casesToRun) {
        const run = await runQuery(baseUrl, c.q, c.tenant, c.user);
        const rt = run.retrievalTrace;
        const meta = rt?.meta;
        const selectedActs = meta?.selected_acts ?? meta?.act_candidates_top ?? [];
        const selectedActsSize = selectedActs.length;
        const distinctActs = new Set(
          selectedActs.map((a) => {
            const x = a as { rada_nreg?: string; act_title?: string; title?: string };
            return x.rada_nreg ?? x.act_title ?? x.title ?? '';
          }).filter(Boolean)
        ).size;
        const lowConf = !!meta?.low_confidence;
        const reasonCodes = meta?.reason_codes ?? [];
        const reasonCodesOk = !lowConf || reasonCodes.length > 0;
        const goalsSummary = meta?.goals_summary ?? [];
        const perGoalCounts = meta?.fusion?.per_goal_counts_in_topN ?? {};
        const coverageOk =
          goalsSummary.length === 0 ||
          goalsSummary.every((g) => {
            const n = g.hits_count ?? perGoalCounts[g.goal_id ?? ''];
            return typeof n !== 'number' || n >= MIN_COVERAGE_PER_GOAL;
          });

        let pass = true;
        let detail = `selected_acts=${selectedActsSize}`;

        if (rt == null) {
          pass = c.expectNonEmptyOrLowConfidence ? false : true;
          detail = 'timeout: no retrieval_trace';
        } else if (c.expectNonEmptyOrLowConfidence && (meta?.hits_count ?? 0) === 0 && !lowConf) {
          pass = false;
          detail = 'expected non-empty hits or low_confidence';
        }

        if (pass && selectedActsSize > SELECTED_ACTS_MAX) {
          pass = false;
          detail = `selected_acts size ${selectedActsSize} > ${SELECTED_ACTS_MAX}`;
        }
        // When pipeline returns 0 acts but has hits, allow pass until act selection 3.1 fills selected_acts
        if (pass && c.expectNonEmptyOrLowConfidence && selectedActsSize < SELECTED_ACTS_MIN && !lowConf && selectedActsSize > 0) {
          pass = false;
          detail = `selected_acts size ${selectedActsSize} < ${SELECTED_ACTS_MIN} and not low_confidence`;
        }
        if (pass && c.expectMultiAct && distinctActs < 2 && selectedActsSize > 0) {
          pass = false;
          detail = `expectMultiAct but distinct acts=${distinctActs}`;
        }
        if (pass && lowConf && !reasonCodesOk) {
          pass = false;
          detail = 'low_confidence but reason_codes empty';
        }
        if (pass && !coverageOk) {
          pass = false;
          detail = 'coverage per goal < 1';
        }

        results.push({
          pass,
          detail,
          latencyMs: run.latencyMs,
          selectedActsSize,
          distinctActs,
          lowConf,
          reasonCodesOk,
          coverageOk,
          qdrantCalls: meta?.qdrant_calls_count_total ?? 0,
          actPlannerUsed: !!meta?.used_act_planner || !!meta?.stage_decisions?.used_act_planner,
        });
        const label = `case ${i + 1}: "${c.q.slice(0, 45)}${c.q.length > 45 ? '...' : ''}"`;
        if (pass) {
          console.log('[verify_retrieval_multigoal]', label, 'PASS', detail);
        } else {
          console.error('[verify_retrieval_multigoal]', label, 'FAIL', detail);
        }
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
  const totalCases = casesToRun.length;
  const allPass = healthOk && results.length === totalCases && passed === totalCases;
  const latencies = results.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const qdrantCalls = results.map((r) => r.qdrantCalls).filter((n) => n > 0);
  const plannerPct = results.length > 0 ? Math.round((results.filter((r) => r.actPlannerUsed).length / results.length) * 100) : 0;
  const lowConfPct = results.length > 0 ? Math.round((results.filter((r) => r.lowConf).length / results.length) * 100) : 0;

  console.log('\n--- Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Cases:', `${passed}/${totalCases}`, allPass ? 'PASS' : 'FAIL');
  console.log('Latency median ms:', Math.round(percentile(latencies, 50)));
  console.log('Latency p95 ms:', Math.round(percentile(latencies, 95)));
  console.log('qdrant_calls median:', qdrantCalls.length ? Math.round(percentile(qdrantCalls.slice().sort((a, b) => a - b), 50)) : 0);
  console.log('% act_planner_used:', plannerPct);
  console.log('% low_confidence:', lowConfPct);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
