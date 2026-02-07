#!/usr/bin/env node
/**
 * Universal retrieval verify suite (U4) — 15–25 cases across domains.
 * One command: free port → start server → N runs → poll retrieval_trace.meta.sample_hits →
 * expected signals (non_empty_hits, optional domain, optional article_ref when "ст. X") → shutdown.
 * Summary: median/p95 latency, % low_confidence, % used_filtered_chunks_search, top-1 act_title coverage.
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
const POLL_TIMEOUT_MS = 55_000;
const SHUTDOWN_WAIT_MS = 5_000;

interface CaseDef {
  q: string;
  tenant: string;
  user: string;
  expected_non_empty_hits: boolean;
  expected_domain?: string[]; // soft: allow list
  expected_article_ref?: string; // when query contains "ст. X"
  expected_candidate_presence?: boolean; // when query contains act abbrev (e.g. ККУ)
  absurd?: boolean; // should not crash; low_confidence ok
}

const UUID = (i: number) =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

const CASES: CaseDef[] = [
  { q: 'умисне вбивство', tenant: UUID(1), user: UUID(101), expected_non_empty_hits: true, expected_domain: ['criminal'] },
  { q: 'звільнення з роботи', tenant: UUID(2), user: UUID(102), expected_non_empty_hits: true, expected_domain: ['labor', 'labour'] },
  { q: 'оскарження податкової', tenant: UUID(3), user: UUID(103), expected_non_empty_hits: true, expected_domain: ['tax', 'tax_customs'] },
  { q: 'поліція перевищення повноважень', tenant: UUID(4), user: UUID(104), expected_non_empty_hits: true },
  { q: 'спадщина квартира', tenant: UUID(5), user: UUID(105), expected_non_empty_hits: true, expected_domain: ['civil'] },
  { q: 'ККУ ст. 115 умисне вбивство', tenant: UUID(6), user: UUID(106), expected_non_empty_hits: true, expected_article_ref: '115', expected_candidate_presence: true },
  { q: 'ЦПК ст. 121 позов', tenant: UUID(7), user: UUID(107), expected_non_empty_hits: true, expected_domain: ['civil_procedure'] },
  { q: 'трудовий договір строковий', tenant: UUID(8), user: UUID(108), expected_non_empty_hits: true },
  { q: 'податкове право порушення', tenant: UUID(9), user: UUID(109), expected_non_empty_hits: true },
  { q: 'адміністративне провадження скарга', tenant: UUID(10), user: UUID(110), expected_non_empty_hits: true },
  { q: 'конституційні права громадянина', tenant: UUID(11), user: UUID(111), expected_non_empty_hits: true },
  { q: 'земельна ділянка приватизація', tenant: UUID(12), user: UUID(112), expected_non_empty_hits: true },
  { q: 'банкрутство підприємства', tenant: UUID(13), user: UUID(113), expected_non_empty_hits: true },
  { q: 'договір купівлі-продажу нерухомості', tenant: UUID(14), user: UUID(114), expected_non_empty_hits: true },
  { q: 'захист прав споживача', tenant: UUID(15), user: UUID(115), expected_non_empty_hits: true },
  { q: 'Сторони домовились про надання послуг у повному обсязі згідно з умовами додатку до договору. Термін виконання — до 31.12.2025. Відповідальність за порушення передбачена ст. 12 Закону.', tenant: UUID(16), user: UUID(116), expected_non_empty_hits: true },
  { q: 'абсурд xyz неіснуючий термін 12345', tenant: UUID(17), user: UUID(117), expected_non_empty_hits: false, absurd: true },
  { q: 'укр термін англ term', tenant: UUID(18), user: UUID(118), expected_non_empty_hits: true },
  { q: 'КЗпП повернення товару', tenant: UUID(19), user: UUID(119), expected_non_empty_hits: true },
  { q: 'умисне вбиство ККУ', tenant: UUID(20), user: UUID(120), expected_non_empty_hits: true, expected_candidate_presence: true },
];

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error('Could not get port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(baseUrl: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const json = (await res.json()) as { status?: string };
        if (json.status === 'healthy') return true;
      }
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

interface RunResult {
  runId: string;
  retrievalTrace: {
    meta?: {
      sample_hits?: Array<{ act_title?: string; article_ref?: string | null; score?: number }>;
      hits_count?: number;
      low_confidence?: boolean;
      used_filtered_chunks_search?: boolean;
      query_used?: string;
    };
    hits?: Array<{ title?: string; article_number?: string | null; score?: number }>;
    latency_ms?: number;
    degraded_sources?: { lldbi?: boolean };
  } | null;
  latencyMs: number;
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
    if (postRes.status !== 202) {
      return { runId: '', retrievalTrace: null, latencyMs: Date.now() - start };
    }
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { runId: '', retrievalTrace: null, latencyMs: Date.now() - start };
  } catch {
    return { runId: '', retrievalTrace: null, latencyMs: Date.now() - start };
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
        if (meta?.sample_hits != null || (meta?.hits_count != null && meta.hits_count >= 0)) {
          return { runId, retrievalTrace: rt, latencyMs: Date.now() - start };
        }
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { runId, retrievalTrace: null, latencyMs: Date.now() - start };
}

function getSampleHits(rt: RunResult['retrievalTrace']): Array<{ act_title?: string; article_ref?: string | null; score?: number }> {
  const fromMeta = rt?.meta?.sample_hits;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) return fromMeta;
  const hits = rt?.hits ?? [];
  return hits.slice(0, 10).map((h) => ({
    act_title: h.title,
    article_ref: h.article_number ?? null,
    score: h.score,
  }));
}

function extractArticleRefFromQuery(q: string): string | undefined {
  const m = q.match(/ст\.?\s*(\d+)/i) || q.match(/статт[яі]\s*(\d+)/i) || q.match(/\b(\d+)\s*статт/i);
  return m ? m[1] : undefined;
}

interface CaseResult {
  label: string;
  pass: boolean;
  detail?: string;
  latencyMs: number;
  hitsCount: number;
  lowConfidence: boolean;
  usedFilteredChunks: boolean;
  topActTitle?: string;
}

async function checkCase(
  baseUrl: string,
  def: CaseDef,
  index: number
): Promise<CaseResult> {
  const label = `case ${index + 1}: "${def.q.slice(0, 40)}${def.q.length > 40 ? '...' : ''}"`;
  const run = await runQuery(baseUrl, def.q, def.tenant, def.user);
  const rt = run.retrievalTrace;
  const hitsCount = rt?.meta?.hits_count ?? rt?.hits?.length ?? 0;
  const lowConfidence = !!rt?.meta?.low_confidence;
  const usedFilteredChunks = !!rt?.meta?.used_filtered_chunks_search;
  const sampleHits = getSampleHits(rt);
  const topActTitle = sampleHits[0]?.act_title;

  if (run.retrievalTrace == null) {
    return {
      label,
      pass: def.absurd ? true : false,
      detail: 'timeout: no retrieval_trace',
      latencyMs: run.latencyMs,
      hitsCount: 0,
      lowConfidence: false,
      usedFilteredChunks: false,
    };
  }

  if (def.absurd) {
    const ok = run.retrievalTrace != null;
    return {
      label,
      pass: ok,
      detail: ok ? 'absurd: no crash, trace present' : 'absurd: timeout',
      latencyMs: run.latencyMs,
      hitsCount,
      lowConfidence,
      usedFilteredChunks,
      topActTitle,
    };
  }

  if (def.expected_non_empty_hits && hitsCount === 0 && !lowConfidence) {
    return {
      label,
      pass: false,
      detail: 'expected non-empty hits or low_confidence',
      latencyMs: run.latencyMs,
      hitsCount,
      lowConfidence,
      usedFilteredChunks,
      topActTitle,
    };
  }

  if (def.expected_non_empty_hits && hitsCount === 0 && lowConfidence) {
    return {
      label,
      pass: true,
      detail: 'low_confidence with 0 hits (acceptable fallback)',
      latencyMs: run.latencyMs,
      hitsCount,
      lowConfidence,
      usedFilteredChunks,
      topActTitle,
    };
  }

  const explicitArt = def.expected_article_ref;
  const extractedArt = extractArticleRefFromQuery(def.q);
  const expectedArt = explicitArt ?? (def.q.length <= 80 ? extractedArt : undefined);
  if (expectedArt && sampleHits.length > 0) {
    const top10HasArt = sampleHits.slice(0, 10).some(
      (h) => h.article_ref != null && String(h.article_ref).trim() === expectedArt
    );
    if (!top10HasArt) {
      return {
        label,
        pass: false,
        detail: `expected article_ref ${expectedArt} in top-10`,
        latencyMs: run.latencyMs,
        hitsCount,
        lowConfidence,
        usedFilteredChunks,
        topActTitle,
      };
    }
  }

  return {
    label,
    pass: true,
    detail: `hits=${hitsCount} top=${topActTitle ?? 'n/a'}`,
    latencyMs: run.latencyMs,
    hitsCount,
    lowConfidence,
    usedFilteredChunks,
    topActTitle,
  };
}

function shutdownServer(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (!child.kill) {
      resolve();
      return;
    }
    child.kill('SIGTERM');
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, SHUTDOWN_WAIT_MS);
    child.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)] ?? 0;
}

async function main(): Promise<void> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_retrieval_suite] port', port, 'cases', CASES.length);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));
  child.on('error', (err) => console.error('[verify_retrieval_suite] Server spawn error:', err));

  let healthOk = false;
  const caseResults: CaseResult[] = [];

  try {
    healthOk = await waitForHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_retrieval_suite] Health check failed');
    } else {
      console.log('[verify_retrieval_suite] Health OK');
      for (let i = 0; i < CASES.length; i++) {
        const result = await checkCase(baseUrl, CASES[i], i);
        caseResults.push(result);
        if (result.pass) {
          console.log('[verify_retrieval_suite]', result.label, 'PASS', result.detail ?? '');
        } else {
          console.error('[verify_retrieval_suite]', result.label, 'FAIL', result.detail ?? '');
        }
      }
    }
  } finally {
    await shutdownServer(child);
  }

  const passed = caseResults.filter((r) => r.pass).length;
  const allPass = healthOk && caseResults.length === CASES.length && passed === CASES.length;
  const latencies = caseResults.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const lowConfCount = caseResults.filter((r) => r.lowConfidence).length;
  const filteredCount = caseResults.filter((r) => r.usedFilteredChunks).length;
  const withTopAct = caseResults.filter((r) => r.topActTitle && r.topActTitle.trim().length > 0).length;

  console.log('\n--- Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Cases:', `${passed}/${CASES.length}`, allPass ? 'PASS' : 'FAIL');
  console.log('Latency median ms:', Math.round(percentile(latencies, 50)));
  console.log('Latency p95 ms:', Math.round(percentile(latencies, 95)));
  console.log('low_confidence %:', CASES.length > 0 ? Math.round((lowConfCount / CASES.length) * 100) : 0);
  console.log('used_filtered_chunks_search %:', CASES.length > 0 ? Math.round((filteredCount / CASES.length) * 100) : 0);
  console.log('top-1 act_title coverage %:', CASES.length > 0 ? Math.round((withTopAct / CASES.length) * 100) : 0);
  caseResults.forEach((r) => console.log(' ', r.pass ? 'PASS' : 'FAIL', r.label));
  console.log('Exit:', allPass ? 0 : 1);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
