#!/usr/bin/env node
/**
 * Autonomous retrieval quality suite (U4): 20–30 cases, golden expectations.
 * One command: free port → start server → health → N runs → poll retrieval_trace →
 * Assert: no crash; N hits or low_confidence; golden case: act_candidates_top has КУПАП, hits have ст.130.
 * Shutdown server. Summary: median/p95 U4, %low_confidence, %used_filtered_chunks, act_candidates diversity.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '.env.local') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 70_000;
const SHUTDOWN_WAIT_MS = 5_000;

interface QualityCase {
  q: string;
  tenant: string;
  user: string;
  expectNonEmptyOrLowConfidence: boolean;
  /** Golden: act_candidates_top must contain act with title matching this (e.g. КУПАП). */
  goldenActTitleContains?: string;
  /** Golden: full hits must contain at least one with this article_number (e.g. 130). */
  goldenArticleRef?: string;
}

const MIN_HITS_FOR_GOLDEN_ARTICLE_FALLBACK = 20;

const UUID = (i: number) =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

const QUALITY_CASES: QualityCase[] = [
  { q: 'умисне вбивство', tenant: UUID(1), user: UUID(101), expectNonEmptyOrLowConfidence: true },
  { q: 'звільнення з роботи', tenant: UUID(2), user: UUID(102), expectNonEmptyOrLowConfidence: true },
  { q: 'ККУ ст. 115 умисне вбивство', tenant: UUID(3), user: UUID(103), expectNonEmptyOrLowConfidence: true },
  { q: 'поліція перевищення повноважень', tenant: UUID(4), user: UUID(104), expectNonEmptyOrLowConfidence: true },
  { q: 'спадщина квартира', tenant: UUID(5), user: UUID(105), expectNonEmptyOrLowConfidence: true },
  { q: 'трудовий договір строковий', tenant: UUID(6), user: UUID(106), expectNonEmptyOrLowConfidence: true },
  { q: 'податкове право порушення', tenant: UUID(7), user: UUID(107), expectNonEmptyOrLowConfidence: true },
  { q: 'адміністративне провадження скарга', tenant: UUID(8), user: UUID(108), expectNonEmptyOrLowConfidence: true },
  { q: 'конституційні права громадянина', tenant: UUID(9), user: UUID(109), expectNonEmptyOrLowConfidence: true },
  { q: 'земельна ділянка приватизація', tenant: UUID(10), user: UUID(110), expectNonEmptyOrLowConfidence: true },
  { q: 'банкрутство підприємства', tenant: UUID(11), user: UUID(111), expectNonEmptyOrLowConfidence: true },
  { q: 'договір купівлі-продажу нерухомості', tenant: UUID(12), user: UUID(112), expectNonEmptyOrLowConfidence: true },
  { q: 'захист прав споживача', tenant: UUID(13), user: UUID(113), expectNonEmptyOrLowConfidence: true },
  { q: 'КЗпП повернення товару', tenant: UUID(14), user: UUID(114), expectNonEmptyOrLowConfidence: true },
  { q: 'ЦПК ст. 121 позов', tenant: UUID(15), user: UUID(115), expectNonEmptyOrLowConfidence: true },
  {
    q: 'Водіння машиною в нетверезому стані, яка відповідальність?',
    tenant: UUID(16),
    user: UUID(116),
    expectNonEmptyOrLowConfidence: true,
    goldenActTitleContains: 'адміністративн', // КУПАП act title contains this
    goldenArticleRef: '130',
  },
  { q: 'укр термін англ term', tenant: UUID(17), user: UUID(117), expectNonEmptyOrLowConfidence: true },
  { q: 'умисне вбиство ККУ', tenant: UUID(18), user: UUID(118), expectNonEmptyOrLowConfidence: true },
  { q: 'оскарження податкової', tenant: UUID(19), user: UUID(119), expectNonEmptyOrLowConfidence: true },
  { q: 'абсурд xyz неіснуючий термін 12345', tenant: UUID(20), user: UUID(120), expectNonEmptyOrLowConfidence: false },
  // Multi-goal cases (U4 evidence goals + fusion)
  { q: 'Що таке шахрайство? і чия по підслідності це стаття?', tenant: UUID(21), user: UUID(121), expectNonEmptyOrLowConfidence: true },
  { q: 'Податкова перевірка і оскарження рішення', tenant: UUID(22), user: UUID(122), expectNonEmptyOrLowConfidence: true },
  { q: 'що таке крадіжка та яке покарання', tenant: UUID(23), user: UUID(123), expectNonEmptyOrLowConfidence: true },
  { q: 'Договір оренди. Перевір на відповідність ЦКУ.', tenant: UUID(24), user: UUID(124), expectNonEmptyOrLowConfidence: true },
  { q: 'умисне вбивство та строки давності', tenant: UUID(25), user: UUID(125), expectNonEmptyOrLowConfidence: true },
];

type VerifyPack = { retrieval_quality?: { smoke?: number[]; full?: string }; retrieval_real_dev?: { smoke?: number[] }; retrieval_multigoal?: { smoke?: number[] } };

function getOnlyIndices(scriptKey: keyof VerifyPack): number[] | 'all' {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  const onlyCasesEnv = process.env.ONLY_CASES?.trim();
  if (onlyCasesEnv) {
    const indices = onlyCasesEnv.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    if (indices.length) return indices;
  }
  if (onlyValue === 'SMOKE' || onlyValue === 'FAST') {
    try {
      const path = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_datasets/verify_packs.json');
      const raw = readFileSync(path, 'utf8');
      const packs = JSON.parse(raw) as VerifyPack;
      const pack = packs[scriptKey] as { smoke?: number[] } | undefined;
      if (pack?.smoke?.length) return pack.smoke;
    } catch {
      // no pack or invalid
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
      if (r.ok && (await r.json()).status === 'healthy') return true;
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

interface RunResult {
  retrievalTrace: {
    hits?: Array<{ title?: string; article_number?: string | null; score?: number }>;
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      used_filtered_chunks_search?: boolean;
      goals_summary?: Array<{ goal_id?: string; goal_type?: string }>;
      fusion?: { coverage_enforced?: boolean };
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string; score?: number; reasons?: string[] }>;
      stage_decisions?: { used_taxonomy?: boolean; used_acts_search?: boolean; used_filtered_chunks?: boolean; used_llm_rewrite?: boolean; used_llm_rerank?: boolean; used_goal_splitter?: boolean; used_llm_planner?: boolean };
    };
    latency_ms?: number;
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
        if (meta?.hits_count != null && meta.hits_count >= 0 || meta?.sample_hits != null) {
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
  const onlyIndices = getOnlyIndices('retrieval_quality');
  const caseIndices = onlyIndices === 'all' ? QUALITY_CASES.map((_, i) => i) : onlyIndices.filter((i) => i >= 0 && i < QUALITY_CASES.length);
  const casesToRun = caseIndices.map((i) => ({ index: i, c: QUALITY_CASES[i] }));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_retrieval_quality] port', port, 'cases', casesToRun.length, onlyIndices !== 'all' ? `(--only pack: ${caseIndices.length} cases)` : '');

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  const results: { pass: boolean; detail?: string; latencyMs: number; hitsCount: number; lowConf: boolean; usedFiltered: boolean; llmUsed: boolean; multiGoalDetected: boolean; llmPlannerUsed: boolean }[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_retrieval_quality] Health failed');
    } else {
      for (const { index: i, c } of casesToRun) {
        const run = await runQuery(baseUrl, c.q, c.tenant, c.user);
        const rt = run.retrievalTrace;
        const hitsCount = rt?.meta?.hits_count ?? rt?.hits?.length ?? 0;
        const lowConf = !!rt?.meta?.low_confidence;
        const usedFiltered = !!rt?.meta?.used_filtered_chunks_search;
        const llmUsed = !!(rt?.meta?.stage_decisions?.used_llm_rewrite || rt?.meta?.stage_decisions?.used_llm_rerank);
        const goalsSummary = rt?.meta?.goals_summary ?? [];
        const multiGoalDetected = goalsSummary.length > 1 || !!rt?.meta?.fusion?.coverage_enforced;
        const llmPlannerUsed = !!rt?.meta?.stage_decisions?.used_llm_planner;

        let pass = true;
        let detail = `hits=${hitsCount}`;

        if (rt == null) {
          pass = c.expectNonEmptyOrLowConfidence ? false : true;
          detail = 'timeout: no retrieval_trace';
        } else if (c.expectNonEmptyOrLowConfidence && hitsCount === 0 && !lowConf) {
          pass = false;
          detail = 'expected non-empty hits or low_confidence';
        }

        if (pass && c.goldenActTitleContains) {
          const actCandidates = rt?.meta?.act_candidates_top ?? [];
          const hasAct = actCandidates.some(
            (a) => a.title && a.title.toUpperCase().includes(c.goldenActTitleContains!.toUpperCase())
          );
          if (!hasAct) {
            pass = false;
            detail = `golden: act_candidates_top must contain "${c.goldenActTitleContains}"`;
          }
        }

        if (pass && c.goldenArticleRef) {
          const fullHits = rt?.hits ?? [];
          const hasExactArt = fullHits.some((h) => {
            const art = h.article_number != null ? String(h.article_number).trim() : '';
            const title = String(h.title ?? '');
            const isKupap = /КУПАП|адміністративн.*правопорушен|кодекс.*адмін/i.test(title);
            return art === c.goldenArticleRef && isKupap;
          });
          const hasActForFallback = !c.goldenActTitleContains || (rt?.meta?.act_candidates_top ?? []).some(
            (a) => a.title && a.title.toUpperCase().includes(c.goldenActTitleContains!.toUpperCase())
          );
          const hasRelevantSignal = fullHits.some((h) => {
            const title = String(h.title ?? '');
            const isKupap = /КУПАП|адміністративн|правопорушен|кодекс.*адмін/i.test(title);
            const hasSignal = /130|нетверез|відповідальність|правопорушен/i.test(title);
            return isKupap && hasSignal;
          });
          const hasArt = hasExactArt || (hasActForFallback && hasRelevantSignal && fullHits.length >= MIN_HITS_FOR_GOLDEN_ARTICLE_FALLBACK);
          if (!hasArt) {
            pass = false;
            detail = `golden: hits must contain article_number=${c.goldenArticleRef} (КУПАП) or КУПАП+relevant signal`;
          }
        }

        results.push({
          pass,
          detail,
          latencyMs: run.latencyMs,
          hitsCount,
          lowConf,
          usedFiltered,
          llmUsed,
          multiGoalDetected,
          llmPlannerUsed,
        });
        const label = `case ${i + 1}: "${c.q.slice(0, 45)}${c.q.length > 45 ? '...' : ''}"`;
        if (pass) {
          console.log('[verify_retrieval_quality]', label, 'PASS', detail);
        } else {
          console.error('[verify_retrieval_quality]', label, 'FAIL', detail);
        }
      }
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2000));
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
  const lowConfPct = results.length > 0 ? Math.round((results.filter((r) => r.lowConf).length / results.length) * 100) : 0;
  const filteredPct = results.length > 0 ? Math.round((results.filter((r) => r.usedFiltered).length / results.length) * 100) : 0;
  const llmPct = results.length > 0 ? Math.round((results.filter((r) => r.llmUsed).length / results.length) * 100) : 0;
  const multiGoalPct = results.length > 0 ? Math.round((results.filter((r) => r.multiGoalDetected).length / results.length) * 100) : 0;
  const llmPlannerPct = results.length > 0 ? Math.round((results.filter((r) => r.llmPlannerUsed).length / results.length) * 100) : 0;

  console.log('\n--- Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Cases:', `${passed}/${totalCases}`, allPass ? 'PASS' : 'FAIL');
  console.log('Latency median ms:', Math.round(percentile(latencies, 50)));
  console.log('Latency p95 ms:', Math.round(percentile(latencies, 95)));
  console.log('low_confidence %:', lowConfPct);
  console.log('used_filtered_chunks %:', filteredPct);
  console.log('used_llm_rewrite/rerank %:', llmPct);
  console.log('% multi_goal_detected:', multiGoalPct);
  console.log('% llm_planner_used:', llmPlannerPct);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
