#!/usr/bin/env node
/**
 * U3/U3a plan test — POST /v1/runs, poll until search_plan + steps (LEX-112, LEX-113).
 * Run: pnpm brain:u3:test (server must be running; use BRAIN_BASE_URL/BRAIN_URL for port).
 * Or: pnpm brain:verify:u3 (starts server on random port and runs this test).
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

const BASE = process.env.BRAIN_BASE_URL ?? process.env.BRAIN_URL ?? 'http://localhost:3081';
const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const TENANT_ID = process.env.U3_TEST_TENANT_ID || '00000000-0000-0000-0000-000000000003';
const USER_ID = process.env.U3_TEST_USER_ID || '00000000-0000-0000-0000-000000000004';

const POLL_INTERVAL_MS = 200;
const POLL_MAX_INTERVAL_MS = 600;
const POLL_TIMEOUT_MS = 20000;

interface SearchPlanPayload {
  plan?: {
    version?: number;
    sources?: { use_lldbi?: boolean; use_memory?: boolean; use_doclist?: boolean };
    reason_codes?: string[];
  };
  steps?: Array<{ kind: string; order?: number }>;
  next_step?: string;
  built_at?: string;
}

interface RunResponse {
  run_id?: string;
  status?: string;
  query?: string;
  query_profile?: { intent?: string; domain?: string; ambiguity?: { is_ambiguous?: boolean }; routing_flags?: Record<string, boolean> };
  search_plan?: SearchPlanPayload | null;
  retrieval_trace?: unknown;
}

const CASES: Array<{
  query: string;
  expectLldbi: boolean;
  expectDoclist?: boolean;
  expectSteps?: boolean;
  label: string;
}> = [
  { query: 'ККУ ст. 115 умисне вбивство', expectLldbi: true, expectDoclist: false, expectSteps: true, label: 'direct_citation' },
  { query: 'мобілізація', expectLldbi: true, expectDoclist: true, expectSteps: true, label: 'ambiguity_hard' },
  { query: 'Звільнення за прогул', expectLldbi: true, expectDoclist: undefined, expectSteps: true, label: 'labor' },
  { query: 'Оскільки Сторони досягли згоди щодо предмету договору та його умов, додаткові положення про заборону відступлення права вимоги та переведення боргу регулюються чинним законодавством. '.repeat(60), expectLldbi: true, expectSteps: true, label: 'long_contract' },
  { query: 'A | B | C\n1 | 2 | 3\nx | y | z', expectLldbi: true, expectSteps: true, label: 'table_like' },
  { query: 'як оскаржити рішення податкової', expectLldbi: true, expectSteps: true, label: 'tax_procedure' },
  { query: 'Contract termination clause and расторжение договора', expectLldbi: true, expectSteps: true, label: 'mixed_lang' },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntilSearchPlanAndSteps(runId: string): Promise<{ run: RunResponse; latencyMs: number }> {
  const start = Date.now();
  let interval = POLL_INTERVAL_MS;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`${BASE}/v1/runs/${runId}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
    if (res.status !== 200) {
      await sleep(interval);
      interval = Math.min(interval + 100, POLL_MAX_INTERVAL_MS);
      continue;
    }
    const run = (await res.json()) as RunResponse;
    const sp = run.search_plan;
    const hasPlan = !!sp?.plan;
    const hasSteps = Array.isArray(sp?.steps) && sp.steps.length > 0;
    if (hasPlan && hasSteps) {
      return { run, latencyMs: Date.now() - start };
    }
    await sleep(interval);
    interval = Math.min(interval + 100, POLL_MAX_INTERVAL_MS);
  }
  const res = await fetch(`${BASE}/v1/runs/${runId}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
  const run = (res.status === 200 ? await res.json() : {}) as RunResponse;
  return { run, latencyMs: Date.now() - start };
}

async function main() {
  console.log('U3/U3a plan test —', BASE);
  console.log('Tenant:', TENANT_ID, 'User:', USER_ID);
  const results: Array<{
    label: string;
    query: string;
    pass: boolean;
    latencyMs: number;
    hasPlan: boolean;
    stepsCount: number;
    nextStep: string;
    lldbi: boolean;
    doclist: boolean;
    degraded?: boolean;
  }> = [];

  for (const c of CASES) {
    const postRes = await fetch(`${BASE}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query: c.query,
        tenant_id: TENANT_ID,
        user_id: USER_ID,
      }),
    });
    if (postRes.status !== 202) {
      const text = await postRes.text();
      console.error('POST failed', c.label, postRes.status, text);
      results.push({
        label: c.label,
        query: c.query.slice(0, 40) + (c.query.length > 40 ? '…' : ''),
        pass: false,
        latencyMs: 0,
        hasPlan: false,
        stepsCount: 0,
        nextStep: '',
        lldbi: false,
        doclist: false,
      });
      continue;
    }
    const { run_id } = (await postRes.json()) as { run_id: string };
    const { run, latencyMs } = await pollUntilSearchPlanAndSteps(run_id);
    const sp = run.search_plan;
    const hasPlan = !!sp?.plan;
    const steps = sp?.steps ?? [];
    const stepsCount = steps.length;
    const nextStep = sp?.next_step ?? '';
    const lldbi = sp?.plan?.sources?.use_lldbi ?? false;
    const doclist = sp?.plan?.sources?.use_doclist ?? false;
    const degraded = run.query_profile?.meta?.classifier_mode === 'degraded';

    const pass =
      hasPlan &&
      stepsCount > 0 &&
      nextStep === 'U4' &&
      lldbi === c.expectLldbi &&
      (c.expectDoclist === undefined || doclist === c.expectDoclist);

    results.push({
      label: c.label,
      query: c.query.slice(0, 40) + (c.query.length > 40 ? '…' : ''),
      pass,
      latencyMs,
      hasPlan,
      stepsCount,
      nextStep,
      lldbi,
      doclist,
      degraded,
    });
  }

  console.log('\n--- Summary ---');
  console.log(
    'label'.padEnd(14),
    'pass'.padEnd(6),
    'latency'.padEnd(8),
    'plan'.padEnd(6),
    'steps'.padEnd(6),
    'next'.padEnd(4),
    'lldbi'.padEnd(6),
    'doclist'.padEnd(8),
    'degraded'
  );
  for (const r of results) {
    console.log(
      r.label.padEnd(14),
      (r.pass ? 'ok' : 'FAIL').padEnd(6),
      (r.latencyMs + 'ms').padEnd(8),
      (r.hasPlan ? 'Y' : 'n').padEnd(6),
      (r.stepsCount + '').padEnd(6),
      (r.nextStep || '-').padEnd(4),
      (r.lldbi ? 'Y' : 'n').padEnd(6),
      (r.doclist ? 'Y' : 'n').padEnd(8),
      r.degraded ? 'Y' : 'n'
    );
  }
  const failed = results.filter((r) => !r.pass).length;
  if (failed > 0) {
    console.log('\n❌ Failed:', failed, 'of', results.length);
    process.exit(1);
  }
  console.log('\n✅ All', results.length, 'cases passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
