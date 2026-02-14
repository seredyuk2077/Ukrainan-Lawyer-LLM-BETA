#!/usr/bin/env node
/**
 * Phase 1.3 — Verify retrieval act-type audit: 20 act types, invariant assertions (A explicit, B implicit, C within-act).
 * Not part of default brain:verify:smoke. Run as audit after major changes.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { classifyActKind, type ActKind } from '../retrieval/selected-acts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type AssertionType = 'A_explicit_act' | 'B_implicit_category' | 'C_within_act' | 'D_multiact_border' | 'E_out_of_domain' | 'F_reference_expansion';

interface ActTypeAuditCase {
  id: string;
  query: string;
  rada_nreg?: string;
  act_kind?: string;
  category?: string | null;
  assertion: AssertionType;
  expect_in_selected_or_evidence?: boolean;
  /** D_multiact_border only */
  expect_min_distinct_acts?: number;
  expect_secondary_order?: boolean;
  expect_primary_law?: boolean;
  /** F_reference_expansion only */
  expect_attempted?: boolean;
  expect_added_if_ref_detected?: boolean;
  expect_no_match_ok?: boolean;
}

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;

type VerifyPack = { act_type_audit?: { smoke?: number[]; fast?: number[]; full?: string } };

function getOnlyIndices(casesLength: number): number[] | 'all' {
  const onlyCasesEnv = process.env.ONLY_CASES?.trim();
  if (onlyCasesEnv) {
    const indices = onlyCasesEnv.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n < casesLength);
    if (indices.length) return indices;
  }
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  if (onlyValue === 'FULL' || !onlyValue) return 'all';
  try {
    const path = resolve(__dirname, '_datasets', 'verify_packs.json');
    if (!existsSync(path)) return 'all';
    const packs = JSON.parse(readFileSync(path, 'utf8')) as VerifyPack;
    const pack = packs.act_type_audit;
    if (onlyValue === 'SMOKE' && pack?.smoke?.length)
      return pack.smoke.filter((i) => i >= 0 && i < casesLength);
    if (onlyValue === 'FAST' && pack?.fast?.length)
      return pack.fast.filter((i) => i >= 0 && i < casesLength);
  } catch {
    // ignore
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
      if (r.ok && (await r.json() as { status?: string })?.status === 'healthy') return true;
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

interface TraceMeta {
  hits_count?: number;
  selected_acts?: Array<{ rada_nreg?: string; act_title?: string }>;
  act_candidates_top?: Array<{ rada_nreg?: string }>;
  chunks_evidence_top_acts?: Array<{ rada_nreg?: string }>;
  low_confidence?: boolean;
  reason_codes?: string[];
  qdrant_calls_count_total?: number;
  selected_acts_kinds_count?: Partial<Record<ActKind, number>>;
  reference_expansion?: {
    enabled?: boolean;
    attempted?: boolean;
    added_count?: number;
    referenced_acts?: string[];
    skipped_reason_codes?: string[];
  };
}

interface RunResult {
  retrievalTrace: {
    hits?: Array<{ rada_nreg?: string }>;
    meta?: TraceMeta;
  } | null;
  latencyMs: number;
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
      if (getRes.status !== 200) { await sleep(POLL_MS); continue; }
      const run = (await getRes.json()) as { retrieval_trace?: RunResult['retrievalTrace'] };
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object' && (rt.meta?.hits_count != null && rt.meta.hits_count >= 0 || rt.meta?.low_confidence === true))
        return { retrievalTrace: rt, latencyMs: Date.now() - start };
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { retrievalTrace: null, latencyMs: Date.now() - start };
}

function actInSelectedOrEvidence(rt: RunResult['retrievalTrace'], radaNreg: string): boolean {
  if (!rt?.meta) return false;
  const nreg = radaNreg.trim();
  const sel = (rt.meta.selected_acts ?? []).some((a) => (a.rada_nreg ?? '').trim() === nreg);
  const ev = (rt.meta.chunks_evidence_top_acts ?? []).some((a) => (a.rada_nreg ?? '').trim() === nreg);
  const cand = (rt.meta.act_candidates_top ?? []).some((a) => (a.rada_nreg ?? '').trim() === nreg);
  return sel || ev || cand;
}

function actInHits(rt: RunResult['retrievalTrace'], radaNreg: string): boolean {
  const hits = rt?.hits ?? [];
  const nreg = radaNreg.trim();
  return hits.some((h) => (h.rada_nreg ?? '').trim() === nreg);
}

const OUT_OF_DOMAIN_REASON_CODES = ['NO_STRONG_ACT_EVIDENCE', 'OUT_OF_SCOPE', 'LOW_EVIDENCE', 'low_confidence_fallback', 'ACT_SELECTION_LOW_CONFIDENCE'];

function checkReferenceExpansion(rt: RunResult['retrievalTrace'], c: ActTypeAuditCase): boolean {
  const ref = rt?.meta?.reference_expansion;
  if (!ref) return false;
  const attempted = ref.attempted === true;
  if (!attempted) return false;
  if (c.expect_no_match_ok) {
    return (ref.added_count ?? 0) > 0 || (ref.skipped_reason_codes ?? []).includes('NO_MATCH_IN_TAXONOMY');
  }
  if (c.expect_added_if_ref_detected) return (ref.added_count ?? 0) > 0;
  return true;
}

function checkCase(rt: RunResult['retrievalTrace'], c: ActTypeAuditCase): boolean {
  if (c.assertion === 'D_multiact_border') return checkMultiactBorder(rt, c);
  if (c.assertion === 'E_out_of_domain') return checkOutOfDomain(rt);
  if (c.assertion === 'F_reference_expansion') return checkReferenceExpansion(rt, c);
  const radaNreg = c.rada_nreg ?? '';
  const inSelOrEv = actInSelectedOrEvidence(rt, radaNreg);
  const inHits = actInHits(rt, radaNreg);
  if (c.assertion === 'A_explicit_act' || c.assertion === 'B_implicit_category') return inSelOrEv;
  if (c.assertion === 'C_within_act') return inSelOrEv || inHits;
  return inSelOrEv;
}

function checkOutOfDomain(rt: RunResult['retrievalTrace']): boolean {
  if (!rt?.meta) return false;
  const lowConf = rt.meta.low_confidence === true;
  const codes = rt.meta.reason_codes ?? [];
  const hasExpectedCode = OUT_OF_DOMAIN_REASON_CODES.some((code) => codes.includes(code));
  return lowConf && hasExpectedCode;
}

function checkMultiactBorder(rt: RunResult['retrievalTrace'], c: ActTypeAuditCase): boolean {
  const sel = rt?.meta?.selected_acts ?? [];
  const minActs = c.expect_min_distinct_acts ?? 2;
  const distinct = new Set(sel.map((a) => (a.rada_nreg ?? '').trim()).filter(Boolean));
  if (distinct.size < minActs) return false;
  const needSecondary = c.expect_secondary_order !== false;
  const needPrimary = c.expect_primary_law !== false;
  let hasSecondary = false;
  let hasPrimary = false;
  for (const a of sel) {
    const k = classifyActKind(a.act_title ?? '');
    if (k === 'SECONDARY_ORDER') hasSecondary = true;
    if (k === 'PRIMARY_LAW') hasPrimary = true;
  }
  return (!needSecondary || hasSecondary) && (!needPrimary || hasPrimary);
}

async function run(): Promise<void> {
  const casesPath = resolve(__dirname, '_datasets', 'act_type_audit_cases.json');
  let cases: ActTypeAuditCase[];
  try {
    const data = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases?: ActTypeAuditCase[] };
    cases = data.cases ?? [];
  } catch {
    console.error('[verify_act_type_audit] Run brain:dataset:act-type-audit and generate cases first.');
    process.exit(1);
  }
  if (cases.length === 0) {
    console.error('[verify_act_type_audit] No cases in act_type_audit_cases.json');
    process.exit(1);
  }

  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  if (onlyValue === 'FULL') {
    const specialPath = resolve(__dirname, '_datasets', 'special_multiact_cases.json');
    if (existsSync(specialPath)) {
      try {
        const special = JSON.parse(readFileSync(specialPath, 'utf8')) as { cases?: ActTypeAuditCase[] };
        if (Array.isArray(special.cases) && special.cases.length) cases = [...cases, ...special.cases];
      } catch {
        // ignore
      }
    }
    const oodPath = resolve(__dirname, '_datasets', 'out_of_domain_cases.json');
    if (existsSync(oodPath)) {
      try {
        const ood = JSON.parse(readFileSync(oodPath, 'utf8')) as { cases?: ActTypeAuditCase[] };
        if (Array.isArray(ood.cases) && ood.cases.length) cases = [...cases, ...ood.cases];
      } catch {
        // ignore
      }
    }
    const refExpPath = resolve(__dirname, '_datasets', 'reference_expansion_cases.json');
    if (existsSync(refExpPath)) {
      try {
        const refExp = JSON.parse(readFileSync(refExpPath, 'utf8')) as { cases?: ActTypeAuditCase[] };
        if (Array.isArray(refExp.cases) && refExp.cases.length) cases = [...cases, ...refExp.cases];
      } catch {
        // ignore
      }
    }
  }

  const onlyIndices = getOnlyIndices(cases.length);
  const indices = onlyIndices === 'all' ? cases.map((_, i) => i) : onlyIndices;
  const toRun = indices.map((i) => ({ index: i, c: cases[i] }));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[verify_act_type_audit] port', port, 'cases', toRun.length, onlyIndices === 'all' ? '(full)' : `(--only: ${indices.length})`);

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  type Row = { pass: boolean; assertion: ActTypeAuditCase['assertion']; latencyMs: number; qdrantCalls?: number; lowConf?: boolean; reasonCodes?: string[]; selectedKinds?: Partial<Record<ActKind, number>> };
  const results: Row[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_act_type_audit] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const { c } of toRun) {
      const run = await runQuery(baseUrl, c.query, tenantId, userId);
      const rt = run.retrievalTrace;
      const pass = checkCase(rt, c);
      results.push({
        pass,
        assertion: c.assertion,
        latencyMs: run.latencyMs,
        qdrantCalls: rt?.meta?.qdrant_calls_count_total,
        lowConf: rt?.meta?.low_confidence,
        reasonCodes: rt?.meta?.reason_codes ?? [],
        selectedKinds: rt?.meta?.selected_acts_kinds_count,
      });
      const label = `${c.id} "${c.query.slice(0, 40)}..."`;
      if (pass) console.log('[verify_act_type_audit]', label, 'PASS');
      else console.error('[verify_act_type_audit]', label, 'FAIL');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS));
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  const total = results.length;
  const hitA = results.filter((r, i) => toRun[i].c.assertion === 'A_explicit_act' && r.pass).length;
  const hitB = results.filter((r, i) => toRun[i].c.assertion === 'B_implicit_category' && r.pass).length;
  const hitC = results.filter((r, i) => toRun[i].c.assertion === 'C_within_act' && r.pass).length;
  const nA = toRun.filter(({ c }) => c.assertion === 'A_explicit_act').length;
  const nB = toRun.filter(({ c }) => c.assertion === 'B_implicit_category').length;
  const nC = toRun.filter(({ c }) => c.assertion === 'C_within_act').length;
  const pctA = nA ? Math.round((hitA / nA) * 100) : 0;
  const pctB = nB ? Math.round((hitB / nB) * 100) : 0;
  const pctC = nC ? Math.round((hitC / nC) * 100) : 0;

  const secondaryCases = toRun.filter(({ c }) => c.assertion !== 'D_multiact_border' && c.act_kind === 'SECONDARY_ORDER');
  const secondaryHit = results.filter((r, i) => {
    const c = toRun[i].c;
    return c.assertion !== 'D_multiact_border' && c.act_kind === 'SECONDARY_ORDER' && r.pass;
  }).length;
  const secondaryInclusionRate = secondaryCases.length ? Math.round((secondaryHit / secondaryCases.length) * 100) : 0;
  const multiactCases = toRun.filter(({ c }) => c.assertion === 'D_multiact_border');
  const multiactHit = results.filter((r, i) => toRun[i].c.assertion === 'D_multiact_border' && r.pass).length;
  const multiactPct = multiactCases.length ? Math.round((multiactHit / multiactCases.length) * 100) : 0;
  const oodCases = toRun.filter(({ c }) => c.assertion === 'E_out_of_domain');
  const oodHit = results.filter((r, i) => toRun[i].c.assertion === 'E_out_of_domain' && r.pass).length;
  const oodPct = oodCases.length ? Math.round((oodHit / oodCases.length) * 100) : 0;

  const latencies = results.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] ?? 0 : 0;
  const p95 = latencies.length ? latencies[Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1)] ?? 0 : 0;
  const qdrantAll = results.map((r) => r.qdrantCalls ?? 0).filter((n) => n > 0);
  const qdrantMedian = qdrantAll.length ? qdrantAll.slice().sort((a, b) => a - b)[Math.floor(qdrantAll.length / 2)] ?? 0 : 0;
  const qdrantMax = qdrantAll.length ? Math.max(...qdrantAll) : 0;
  const lowConfPct = total ? Math.round((results.filter((r) => r.lowConf).length / total) * 100) : 0;
  const reasonCounts: Record<string, number> = {};
  for (const r of results) for (const code of r.reasonCodes ?? []) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  const topReasonCodes = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);

  const kindDist: Partial<Record<ActKind, number>> = {};
  for (const r of results) {
    const k = r.selectedKinds;
    if (!k) continue;
    for (const [key, v] of Object.entries(k)) if (typeof v === 'number') kindDist[key as ActKind] = (kindDist[key as ActKind] ?? 0) + v;
  }

  console.log('\n--- Act-type audit summary ---');
  console.log('explicit_act_hit %:', pctA, `(${hitA}/${nA})`);
  console.log('implicit_category_hit %:', pctB, `(${hitB}/${nB})`);
  console.log('within_act_hit %:', pctC, `(${hitC}/${nC})`);
  console.log('secondary_inclusion_rate %:', secondaryInclusionRate, `(${secondaryHit}/${secondaryCases.length})`);
  if (multiactCases.length) console.log('multiact_border_hit %:', multiactPct, `(${multiactHit}/${multiactCases.length})`);
  if (oodCases.length) console.log('out_of_domain low_confidence_correct %:', oodPct, `(${oodHit}/${oodCases.length})`);
  const refExpCases = toRun.filter(({ c }) => c.assertion === 'F_reference_expansion');
  const refExpHit = results.filter((r, i) => toRun[i].c.assertion === 'F_reference_expansion' && r.pass).length;
  const refExpPct = refExpCases.length ? Math.round((refExpHit / refExpCases.length) * 100) : 0;
  if (refExpCases.length) console.log('reference_expansion pass %:', refExpPct, `(${refExpHit}/${refExpCases.length})`);
  console.log('selected_acts act_kind dist:', JSON.stringify(kindDist));
  console.log('latency_ms p50/p95:', p50, p95);
  console.log('qdrant_calls median/max:', qdrantMedian, qdrantMax);
  console.log('low_confidence %:', lowConfPct);
  console.log('top reason_codes:', topReasonCodes.join(', ') || 'none');
  console.log('total pass:', results.filter((r) => r.pass).length, '/', total);

  const allPass = total > 0 && results.every((r) => r.pass);
  const passCount = results.filter((r) => r.pass).length;
  const fastGate =
    onlyValue === 'FAST' &&
    total >= 10 &&
    passCount >= Math.floor(total * 0.6) &&
    pctA >= 70 &&
    pctB >= 50;
  const exitCode = allPass || fastGate ? 0 : 1;
  if (fastGate && !allPass) console.log('[verify_act_type_audit] FAST gate: pass (thresholds met)');
  process.exit(exitCode);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
