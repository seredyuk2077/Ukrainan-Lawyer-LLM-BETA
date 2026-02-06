#!/usr/bin/env node
/**
 * U2 test — 25 queries with polling (no fixed sleep) + latency reporting.
 * Run: pnpm brain:u2:test (loads .env so DEV_API_KEY matches server). Override: U2_TEST_TENANT_ID=... U2_TEST_USER_ID=...
 * Or: USE_RULE_BASED_CLASSIFIER=true pnpm brain:u2:test (server must be started with same env for rules-only).
 * Requires: Brain server on port 3081.
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

const BASE = process.env.BRAIN_URL || 'http://localhost:3081';
const DEV_KEY = process.env.DEV_API_KEY || 'dev-key-change-me';

const POLL_INTERVAL_MS = 150;
const POLL_MAX_INTERVAL_MS = 600;
const POLL_TIMEOUT_MS = 12000;
/** Run this many queries in parallel to cut total time */
const CONCURRENCY = 8;

const QUERIES: Array<{ query: string; expected?: { domain?: string; intent?: string; entitiesMin?: number; ambiguous?: boolean } }> = [
  { query: 'ККУ ст. 115 умисне вбивство', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'ст.115-1 ККУ', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'стаття 115¹ Кримінального кодексу', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'стаття 115 з позначкою один', expected: { entitiesMin: 1 } },
  { query: 'ч. 2 ст. 115 ККУ', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'п. 1 ч. 2 ст. 115 ККУ', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'пункт 1 статті 10 ЗУ "Про Національну поліцію"', expected: { entitiesMin: 1 } },
  { query: 'ЗУ про мобілізаційну підготовку і мобілізацію ст 22', expected: { entitiesMin: 1 } },
  { query: 'КЗпП ст. 40 звільнення', expected: { domain: 'labor', entitiesMin: 1 } },
  { query: 'ЦКУ ст. 1166 відшкодування шкоди', expected: { domain: 'civil', entitiesMin: 1 } },
  { query: 'КАС України строк звернення до суду', expected: { domain: 'admin' } },
  { query: 'ПКУ штраф за несвоєчасну сплату', expected: { domain: 'tax', entitiesMin: 1 } },
  { query: 'Звільнення працівника за прогул', expected: { domain: 'labor' } },
  { query: 'як захистити право власності', expected: { domain: 'civil' } },
  { query: 'інвестиція в нерухомість', expected: {} },
  { query: 'мобілізація', expected: { ambiguous: true } },
  { query: 'поліція', expected: { ambiguous: true } },
  { query: 'права', expected: { ambiguous: true } },
  { query: 'обов\'язки', expected: { ambiguous: true } },
  { query: 'стаття 1-1-1', expected: {} },
  { query: 'ст 000', expected: {} },
  { query: 'кку 115 один', expected: { domain: 'criminal' } },
  { query: 'складіть заяву про оскарження', expected: { intent: 'drafting' } },
  { query: 'як оскаржити рішення податкової', expected: { intent: 'procedure', domain: 'tax' } },
  { query: 'МВС та СБУ повноваження', expected: { entitiesMin: 2 } },
];

interface RunResponse {
  run_id?: string;
  query_profile?: {
    intent?: string;
    domain?: string;
    entities?: unknown[];
    ambiguity?: { is_ambiguous?: boolean };
    meta?: { classifier_mode?: string };
  };
}

async function pollUntilQueryProfile(runId: string): Promise<{ run: RunResponse; latencyMs: number }> {
  const start = Date.now();
  let interval = POLL_INTERVAL_MS;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const getRes = await fetch(`${BASE}/v1/runs/${runId}`, {
      headers: { 'X-Dev-API-Key': DEV_KEY },
    });
    if (getRes.status !== 200) {
      await sleep(interval);
      interval = Math.min(interval + 100, POLL_MAX_INTERVAL_MS);
      continue;
    }
    const run = (await getRes.json()) as RunResponse;
    const qp = run.query_profile;
    if (qp && (qp.intent !== undefined || qp.meta?.classifier_mode !== undefined)) {
      return { run, latencyMs: Date.now() - start };
    }
    await sleep(interval);
    interval = Math.min(interval + 100, POLL_MAX_INTERVAL_MS);
  }
  const getRes = await fetch(`${BASE}/v1/runs/${runId}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
  const run = (getRes.status === 200 ? await getRes.json() : {}) as RunResponse;
  return { run, latencyMs: Date.now() - start };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

async function main() {
  const tenantId =
    process.env.U2_TEST_TENANT_ID ||
    `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
  const userId = process.env.U2_TEST_USER_ID || tenantId;

  console.log('U2 test queries —', BASE);
  console.log('tenant_id:', tenantId, '| user_id:', userId);
  console.log('Mode:', process.env.USE_RULE_BASED_CLASSIFIER === 'true' ? 'rules' : 'LLM (if key)');
  console.log('Concurrency:', CONCURRENCY, '| Poll: interval', POLL_INTERVAL_MS, 'ms, timeout', POLL_TIMEOUT_MS, 'ms\n');
  const results: Array<{
    query: string;
    expected?: object;
    actual: { intent?: string; domain?: string; entities_count?: number; ambiguous?: boolean; mode?: string };
    status: string;
    latencyMs?: number;
    postStatus?: number;
  }> = [];
  const latencies: number[] = [];

  const runOne = async (
    idx: number
  ): Promise<{
    query: string;
    expected?: object;
    actual: { intent?: string; domain?: string; entities_count?: number; ambiguous?: boolean; mode?: string };
    status: string;
    latencyMs?: number;
    postStatus?: number;
  }> => {
    const { query, expected } = QUERIES[idx];
    try {
      const res = await fetch(`${BASE}/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dev-API-Key': DEV_KEY,
        },
        body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
      });
      if (res.status !== 202) {
        const is429 = res.status === 429;
        return {
          query: query.slice(0, 50),
          expected,
          actual: { intent: undefined, domain: undefined, entities_count: undefined, ambiguous: undefined, mode: undefined },
          status: is429 ? 'FAIL POST 429' : `FAIL POST ${res.status}`,
          postStatus: res.status,
        };
      }
      const json = (await res.json()) as { run_id?: string };
      const runId = json.run_id;
      if (!runId) {
        return { query: query.slice(0, 50), expected, actual: {}, status: 'FAIL no run_id' };
      }

      const { run, latencyMs } = await pollUntilQueryProfile(runId);
      latencies.push(latencyMs);

      const qp = run.query_profile;
      const actual = {
        intent: qp?.intent,
        domain: qp?.domain,
        entities_count: Array.isArray(qp?.entities) ? qp.entities.length : 0,
        ambiguous: qp?.ambiguity?.is_ambiguous,
        mode: qp?.meta?.classifier_mode,
      };
      let status = '✅';
      if (expected) {
        if (expected.intent !== undefined && expected.intent !== actual.intent) status = '❌ intent';
        else if (expected.domain && expected.domain !== actual.domain) status = '❌ domain';
        else if (expected.entitiesMin !== undefined && actual.entities_count! < expected.entitiesMin) status = '❌ entities';
        else if (expected.ambiguous !== undefined && actual.ambiguous !== expected.ambiguous) status = '❌ ambiguous';
      }
      if (!qp) status = '❌ timeout';
      return { query: query.slice(0, 50), expected, actual, status, latencyMs };
    } catch (e) {
      return {
        query: query.slice(0, 50),
        expected,
        actual: {},
        status: `❌ ${(e as Error).message}`,
      };
    }
  };

  for (let i = 0; i < QUERIES.length; i += CONCURRENCY) {
    const chunk = QUERIES.slice(i, i + CONCURRENCY).map((_, j) => runOne(i + j));
    const chunkResults = await Promise.all(chunk);
    results.push(...chunkResults);
  }

  console.log('| query | expected | actual (intent/domain/entities/ambiguous) | mode | latency_ms | status |');
  console.log('|-------|----------|------------------------------------------|------|------------|--------|');
  for (const r of results) {
    const exp = r.expected ? JSON.stringify(r.expected).slice(0, 30) : '-';
    const act = `${r.actual.intent ?? '-'}/${r.actual.domain ?? '-'}/${r.actual.entities_count ?? 0}/${r.actual.ambiguous ?? false}`;
    const lat = r.latencyMs !== undefined ? String(r.latencyMs) : '-';
    console.log(`| ${r.query.slice(0, 35)} | ${exp} | ${act} | ${r.actual.mode ?? '-'} | ${lat} | ${r.status} |`);
  }

  const passed = results.filter((r) => r.status === '✅');
  const failed = results.filter((r) => r.status !== '✅');
  const byMode = { llm: 0, rules: 0, degraded: 0 };
  for (const r of results) {
    const m = r.actual.mode;
    if (m === 'llm') byMode.llm++;
    else if (m === 'rules') byMode.rules++;
    else if (m === 'degraded') byMode.degraded++;
  }

  const count429 = results.filter((r) => r.postStatus === 429 || r.status === 'FAIL POST 429').length;
  const sortedLat = latencies.slice().sort((a, b) => a - b);
  const medianLat = percentile(sortedLat, 50);
  const p95Lat = percentile(sortedLat, 95);

  console.log('\n--- Summary ---');
  console.log('Passed:', passed.length, '/', QUERIES.length);
  console.log('Mode: llm', byMode.llm, '| rules', byMode.rules, '| degraded', byMode.degraded, `(${((100 * byMode.llm) / results.length).toFixed(0)}% llm)`);
  console.log('U2 latency (POST → query_profile ready): median', Math.round(medianLat), 'ms | p95', Math.round(p95Lat), 'ms');
  if (count429 > 0) {
    console.log('\n429 count:', count429, '— rate/concurrent limit hit.');
    console.log('Fix: raise gateway limits on the server: MAX_CONCURRENT_RUNS (default 10) and RUNS_PER_MINUTE (default 30).');
    console.log('Example: MAX_CONCURRENT_RUNS=25 RUNS_PER_MINUTE=60 pnpm brain:dev');
    process.exit(1);
  }
  if (failed.length > 0) {
    console.log('\nFailed:', failed.length);
    for (const f of failed) console.log(' -', f.query, f.status);
    process.exit(1);
  }
  console.log('\nAll passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
