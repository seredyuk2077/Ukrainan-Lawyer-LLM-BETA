#!/usr/bin/env node
/**
 * LLDBI semantic evidence verify: ККУ ст.115.
 * Autonomous: free port → start server → 3 queries → poll retrieval_trace.meta.sample_hits → fetch R2 fragment → assert 115 + умисне вбивство + ККУ.
 * REAL_LLDBI_REQUIRED=true: if Qdrant/R2 unavailable or degraded → FAIL (no fake PASS).
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

import { getFragmentFromR2 } from '../../retrieval/r2-fragment.js';
import type { SampleHit } from '../../retrieval/types.js';

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const REAL_LLDBI_REQUIRED = process.env.REAL_LLDBI_REQUIRED === 'true';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 45_000;
const SHUTDOWN_WAIT_MS = 5_000;

const QUERIES: Array<{ q: string; tenant: string; user: string }> = [
  { q: 'умисне вбивство', tenant: '00000000-0000-0000-0000-000000000101', user: '00000000-0000-0000-0000-000000000102' },
  { q: 'умисне вбиство', tenant: '00000000-0000-0000-0000-000000000201', user: '00000000-0000-0000-0000-000000000202' },
  { q: 'ККУ ст. 115 умисне вбивство', tenant: '00000000-0000-0000-0000-000000000301', user: '00000000-0000-0000-0000-000000000302' },
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
    meta?: { sample_hits?: SampleHit[] };
    hits?: Array<{ r2_key?: string; json_path?: string; score?: number; title?: string; article_number?: string }>;
    degraded_sources?: { lldbi?: boolean };
  } | null;
}

async function runQuery(baseUrl: string, query: string, tenantId: string, userId: string): Promise<RunResult | null> {
  let runId: string;
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query,
        tenant_id: tenantId,
        user_id: userId,
      }),
    });
    if (postRes.status !== 202) {
      console.error('[verify_lldbi] POST failed', postRes.status, await postRes.text().then((t) => t.slice(0, 200)));
      return null;
    }
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return null;
  } catch (e) {
    console.error('[verify_lldbi] POST error', e);
    return null;
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
      const run = (await getRes.json()) as {
        retrieval_trace?: RunResult['retrievalTrace'] | null;
      };
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object') {
        return { runId, retrievalTrace: rt };
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { runId, retrievalTrace: null };
}

/** Assert fragment text is ККУ ст.115 (Стаття 115 + умисне вбивство) and act is KKU. */
function assertKku115(text: string, actTitle?: string, articleRef?: string | null): { ok: boolean; reason?: string } {
  const lower = text.toLowerCase();
  const has115InText =
    /статт[яі]\s*115/i.test(text) ||
    (/\b115\b/.test(text) && /статт?я/i.test(text));
  const has115FromRef = articleRef != null && String(articleRef).trim() === '115';
  const has115 = has115InText || has115FromRef;

  const hasUmysne =
    /умисн(е|ого|е)\s+вбивств/i.test(text) ||
    /умисн(е|ого)\s+вбиство/i.test(text) ||
    lower.includes('умисне вбивство') ||
    lower.includes('умисне вбиство');
  const actInfo = (actTitle ?? '') + (articleRef ?? '');
  const isKku =
    /кримінальний\s+кодекс/i.test(actInfo) ||
    /\bкку\b/i.test(actInfo) ||
    /кримінальний\s+кодекс/i.test(text) ||
    /\bкку\b/i.test(text);

  if (!has115) return { ok: false, reason: 'fragment/hit does not indicate Стаття 115 (text or article_ref)' };
  if (!hasUmysne) return { ok: false, reason: 'fragment does not contain умисне вбивство' };
  if (!isKku) return { ok: false, reason: 'act is not ККУ/Кримінальний кодекс' };
  return { ok: true };
}

function getSampleHits(rt: RunResult['retrievalTrace']): SampleHit[] {
  const fromMeta = rt?.meta?.sample_hits;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) return fromMeta;
  const hits = rt?.hits ?? [];
  return hits.slice(0, 5).map((h) => ({
    source: undefined,
    score: h.score ?? 0,
    r2_key: h.r2_key ?? '',
    json_path: h.json_path ?? '',
    act_title: h.title,
    article_ref: h.article_number ?? null,
  }));
}

async function checkCase(
  baseUrl: string,
  label: string,
  query: string,
  tenantId: string,
  userId: string
): Promise<{ pass: boolean; detail?: string; debug?: string }> {
  const run = await runQuery(baseUrl, query, tenantId, userId);
  if (!run) return { pass: false, detail: 'run failed or no run_id' };

  const rt = run.retrievalTrace;
  if (REAL_LLDBI_REQUIRED && (rt == null || rt.degraded_sources?.lldbi)) {
    return {
      pass: false,
      detail: 'REAL_LLDBI_REQUIRED=true but retrieval_trace missing or degraded_sources.lldbi',
      debug: rt ? `degraded_sources=${JSON.stringify(rt.degraded_sources)}` : 'retrieval_trace=null',
    };
  }

  if (rt == null) {
    return { pass: false, detail: 'timeout: no retrieval_trace' };
  }

  const sampleHits = getSampleHits(rt);
  const top3 = sampleHits
    .filter((h) => (h.r2_key?.trim() ?? '') !== '' && (h.json_path?.trim() ?? '') !== '')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 3);

  if (top3.length === 0) {
    return {
      pass: false,
      detail: 'no hits with r2_key+json_path',
      debug: `sample_hits count=${sampleHits.length}`,
    };
  }

  for (const hit of top3) {
    let text: string | null = null;
    try {
      text = await getFragmentFromR2(hit.r2_key, hit.json_path);
    } catch (e) {
      if (REAL_LLDBI_REQUIRED) {
        return {
          pass: false,
          detail: `R2 fetch failed: ${(e as Error).message}`,
          debug: `r2_key=${hit.r2_key?.slice(0, 80)} json_path=${hit.json_path}`,
        };
      }
      continue;
    }
    if (text == null || text.length === 0) continue;
    const assertion = assertKku115(text, hit.act_title, hit.article_ref ?? undefined);
    if (assertion.ok) {
      const preview = text.slice(0, 200).replace(/\s+/g, ' ');
      return {
        pass: true,
        detail: `top hit: act_title=${hit.act_title ?? 'n/a'} article_ref=${hit.article_ref ?? 'n/a'} score=${hit.score} | fragment preview: ${preview}...`,
      };
    }
  }

  const firstHit = top3[0];
  let fragmentPreview = '';
  try {
    const t = await getFragmentFromR2(firstHit.r2_key, firstHit.json_path);
    fragmentPreview = (t ?? '').slice(0, 200).replace(/\s+/g, ' ');
  } catch {
    fragmentPreview = '(R2 fetch failed)';
  }
  return {
    pass: false,
    detail: 'none of top-3 hits matched ККУ ст.115 + умисне вбивство',
    debug: `top: act_title=${firstHit.act_title} article_ref=${firstHit.article_ref} score=${firstHit.score} r2_key=${firstHit.r2_key?.slice(0, 60)} json_path=${firstHit.json_path} | fragment: ${fragmentPreview}`,
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

async function main(): Promise<void> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_lldbi_kku115] port', port, 'REAL_LLDBI_REQUIRED=', REAL_LLDBI_REQUIRED);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    {
      env: serverEnv,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));
  child.on('error', (err) => {
    console.error('[verify_lldbi_kku115] Server spawn error:', err);
  });

  let healthOk = false;
  const caseResults: Array<{ label: string; pass: boolean; detail?: string; debug?: string }> = [];

  try {
    healthOk = await waitForHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_lldbi_kku115] Health check failed');
    } else {
      console.log('[verify_lldbi_kku115] Health OK');
      for (let i = 0; i < QUERIES.length; i++) {
        const { q, tenant, user } = QUERIES[i];
        const label = `case ${i + 1}: "${q.slice(0, 30)}..."`;
        console.log('[verify_lldbi_kku115] Running', label);
        const result = await checkCase(baseUrl, label, q, tenant, user);
        caseResults.push({ label, ...result });
        if (result.pass) {
          console.log('[verify_lldbi_kku115]', label, 'PASS');
          if (result.detail) console.log('  ', result.detail.slice(0, 200));
        } else {
          console.error('[verify_lldbi_kku115]', label, 'FAIL', result.detail ?? '');
          if (result.debug) console.error('  ', result.debug);
        }
      }
    }
  } finally {
    await shutdownServer(child);
  }

  const allPass = healthOk && caseResults.length === QUERIES.length && caseResults.every((r) => r.pass);
  const passed = caseResults.filter((r) => r.pass).length;

  console.log('\n--- Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('Cases:', `${passed}/${QUERIES.length}`, allPass ? 'PASS' : 'FAIL');
  caseResults.forEach((r) => console.log(' ', r.pass ? 'PASS' : 'FAIL', r.label));
  console.log('Exit:', allPass ? 0 : 1);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
