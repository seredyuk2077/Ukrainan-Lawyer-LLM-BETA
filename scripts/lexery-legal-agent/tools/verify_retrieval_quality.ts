#!/usr/bin/env node
/**
 * Autonomous retrieval quality suite (U4): 20–30 cases, golden expectations.
 * One command: free port → start server → health → N runs → poll retrieval_trace →
 * Assert: no crash; N hits or low_confidence; golden case: act_candidates_top has КУПАП, hits have ст.130.
 * Shutdown server. Summary: median/p95 U4, %low_confidence, %used_filtered_chunks, act_candidates diversity.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
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
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string; score?: number; reasons?: string[] }>;
      stage_decisions?: { used_taxonomy?: boolean; used_acts_search?: boolean; used_filtered_chunks?: boolean; used_llm_rewrite?: boolean; used_llm_rerank?: boolean };
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
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_retrieval_quality] port', port, 'cases', QUALITY_CASES.length);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  const results: { pass: boolean; detail?: string; latencyMs: number; hitsCount: number; lowConf: boolean; usedFiltered: boolean; llmUsed: boolean }[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_retrieval_quality] Health failed');
    } else {
      for (let i = 0; i < QUALITY_CASES.length; i++) {
        const c = QUALITY_CASES[i];
        const run = await runQuery(baseUrl, c.q, c.tenant, c.user);
        const rt = run.retrievalTrace;
        const hitsCount = rt?.meta?.hits_count ?? rt?.hits?.length ?? 0;
        const lowConf = !!rt?.meta?.low_confidence;
        const usedFiltered = !!rt?.meta?.used_filtered_chunks_search;
        const llmUsed = !!(rt?.meta?.stage_decisions?.used_llm_rewrite || rt?.meta?.stage_decisions?.used_llm_rerank);

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
          const hasArt = fullHits.some((h) => {
            const art = h.article_number != null ? String(h.article_number).trim() : '';
            const title = String(h.title ?? '');
            const isKupap = /КУПАП|адміністративн.*правопорушен|кодекс.*адмін/i.test(title);
            return art === c.goldenArticleRef && isKupap;
          });
          if (!hasArt) {
            pass = false;
            detail = `golden: hits must contain article_number=${c.goldenArticleRef} (КУПАП)`;
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
  const allPass = healthOk && results.length === QUALITY_CASES.length && passed === QUALITY_CASES.length;
  const latencies = results.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const lowConfPct = results.length > 0 ? Math.round((results.filter((r) => r.lowConf).length / results.length) * 100) : 0;
  const filteredPct = results.length > 0 ? Math.round((results.filter((r) => r.usedFiltered).length / results.length) * 100) : 0;
  const llmPct = results.length > 0 ? Math.round((results.filter((r) => r.llmUsed).length / results.length) * 100) : 0;

  console.log('\n--- Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Cases:', `${passed}/${QUALITY_CASES.length}`, allPass ? 'PASS' : 'FAIL');
  console.log('Latency median ms:', Math.round(percentile(latencies, 50)));
  console.log('Latency p95 ms:', Math.round(percentile(latencies, 95)));
  console.log('low_confidence %:', lowConfPct);
  console.log('used_filtered_chunks %:', filteredPct);
  console.log('used_llm_rewrite/rerank %:', llmPct);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
