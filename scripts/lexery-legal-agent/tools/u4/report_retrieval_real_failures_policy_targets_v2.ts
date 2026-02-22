#!/usr/bin/env node
/**
 * Phase 4.5 — Policy targets v2: list hard_fail (13), per-case fields, cluster into 4 buckets.
 * A) Wrong family routing
 * B) Missing multi-act coverage per goal
 * C) Procedure/substance split missed (or over-split)
 * D) Low_confidence should-have-triggered planner/rewrite
 * Writes _reports/retrieval_real_dev_failures_policy_targets_v2.md
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
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
/** Per-query poll timeout; one slow case does not kill the run (graceful continue). */
const POLL_TIMEOUT_MS = 120_000; // 2 min per query
/** Total wall-clock timeout for all runs (e.g. repeat 3); after this we finish current run and write report. */
const REPORT_TOTAL_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const SHUTDOWN_WAIT_MS = 5_000;
const EXPECTED_CONFIDENCE_HARD_THRESHOLD = 0.5;

interface LabeledRow {
  run_id: string;
  query: string;
  expectations: {
    expected_act_families: Array<{ family_id: string }>;
    expected_domains: string[];
    must_have_multi_act: boolean;
    must_have_multi_goal: boolean;
    heuristic_confidence?: number;
  };
}

interface RunResult {
  retrievalTrace: {
    hits?: Array<{ title?: string; act_title?: string }>;
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      reason_codes?: string[];
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string }>;
      selected_acts?: Array<{ rada_nreg?: string; act_title?: string }>;
      goals_summary?: Array<{ goal_id?: string; required_categories?: string[] }>;
      selected_acts_sources_breakdown?: Record<string, unknown> & { from_routing_hints?: string[] };
      chunks_evidence_top_acts?: Array<{ rada_nreg?: string; count_in_top30?: number; max_score?: number }>;
      selected_acts_decision?: { reason_codes?: string[]; confidence?: number };
      qdrant_calls_count_total?: number;
      stage_decisions?: { used_llm_planner?: boolean; used_act_planner?: boolean };
      planner?: { tier?: number };
      routing_hints?: {
        enabled?: boolean;
        called?: boolean;
        call_failed_reason?: string;
        families_ranked_top2?: Array<{ family_key: string; confidence?: number }>;
        used_reason_codes?: string[];
        not_used_reason_codes?: string[];
        used_effect?: {
          added_act?: { rada_nreg: string; title: string; family_key: string; source: string };
          added_count: number;
        };
        routing_path?: 'TAXONOMY_FIRST' | 'ACTS_SEARCH' | 'NONE';
      };
      family_evidence_summary?: {
        dominant_family_key?: string;
        family_confidence?: number;
        family_conflict?: boolean;
        top2?: Array<{ family_key: string; support_score: number }>;
      };
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

async function runQuery(baseUrl: string, query: string, tenantId: string, userId: string): Promise<RunResult> {
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
      if (getRes.status !== 200) {
        await sleep(POLL_MS);
        continue;
      }
      const run = (await getRes.json()) as { retrieval_trace?: RunResult['retrievalTrace'] };
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object' && rt.meta?.hits_count != null) {
        return { retrievalTrace: rt, latencyMs: Date.now() - start };
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
  return { retrievalTrace: null, latencyMs: Date.now() - start };
}

const FAMILY_TITLE_SIGNALS: Record<string, RegExp> = {
  criminal: /кримін|кку|злочин|кримінальний\s+кодекс/i,
  criminal_procedure: /кпк|кримінальн.*процес/i,
  civil: /цивіль|цк\s*у|цік/i,
  civil_procedure: /ципк|цпк|цивільн.*процес/i,
  administrative: /адмін|адміністративн/i,
  administrative_offenses: /купап|адмін.*правопоруш/i,
  tax_customs: /податк|пкку|податковий\s+кодекс/i,
  tax: /податк|пкку|податковий\s+кодекс/i,
  labor: /працю|труд|кзпп|кодекс\s+законів\s+про\s+працю/i,
  labor_social: /труд|кзпп|трудовий\s+кодекс|працю/i,
  admin: /адмін|адміністративн|купап/i,
  other: /./,
};

function actTitleMatchesFamily(title: string, familyId: string): boolean {
  if (familyId === 'general') return true;
  const re = FAMILY_TITLE_SIGNALS[familyId];
  if (!re) return title.toLowerCase().includes(familyId.toLowerCase());
  return re.test(title);
}

/** Derive family_keys from selected_acts titles using title signals (read-only, no taxonomy call). */
function selectedActsFamilyKeys(selectedActs: Array<{ act_title?: string }>): string[] {
  const keys = new Set<string>();
  for (const a of selectedActs) {
    const title = (a as { act_title?: string }).act_title ?? '';
    let matched = false;
    for (const familyId of Object.keys(FAMILY_TITLE_SIGNALS)) {
      if (actTitleMatchesFamily(title, familyId)) {
        keys.add(familyId);
        matched = true;
      }
    }
    if (title && !matched) keys.add('other');
  }
  return Array.from(keys);
}

const FAMILY_MISMATCH_SUPPORT_THRESHOLD = 0.62;

type FamilyEvidenceSummaryLike = {
  dominant_family_key?: string;
  family_confidence?: number;
  family_conflict?: boolean;
  top2?: Array<{ support_score: number }>;
} | undefined;

function familyMismatchFlag(familyEvidence: FamilyEvidenceSummaryLike, selectedActs: Array<{ act_title?: string }>): boolean {
  if (!familyEvidence?.dominant_family_key) return false;
  const support = familyEvidence.family_confidence ?? familyEvidence.top2?.[0]?.support_score ?? 0;
  if (support < FAMILY_MISMATCH_SUPPORT_THRESHOLD || familyEvidence.family_conflict) return false;
  const hasMatch = selectedActs.some((a) => actTitleMatchesFamily((a.act_title ?? '') as string, familyEvidence.dominant_family_key!));
  return !hasMatch;
}

function checkActFamilyHit(rt: RunResult['retrievalTrace'], expectedFamilies: Array<{ family_id: string }>): boolean {
  if (!rt || expectedFamilies.length === 0) return true;
  const actCandidates = rt.meta?.act_candidates_top ?? [];
  const selectedActs = rt.meta?.selected_acts ?? [];
  const hits = rt.hits ?? [];
  const allTitles = [
    ...actCandidates.map((a) => (a as { title?: string }).title ?? ''),
    ...selectedActs.map((a) => (a as { act_title?: string }).act_title ?? ''),
    ...hits.map((h) => (h.act_title ?? h.title) ?? ''),
  ].filter(Boolean);
  for (const exp of expectedFamilies) {
    if (exp.family_id === 'general') return true;
    if (allTitles.some((t) => actTitleMatchesFamily(t, exp.family_id))) return true;
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
  const acts = rt?.meta?.selected_acts ?? rt?.meta?.act_candidates_top ?? [];
  const distinct = new Set(
    acts.map((a) => (a as { rada_nreg?: string }).rada_nreg ?? (a as { title?: string }).title ?? '').filter(Boolean)
  );
  return distinct.size >= 2;
}

type BucketV2 = 'A' | 'B' | 'C' | 'D';

function classifyBucketV2(
  row: LabeledRow,
  rt: RunResult['retrievalTrace'],
  actFamilyHit: boolean,
  multiGoalCorrect: boolean,
  multiActCorrect: boolean
): BucketV2 {
  const meta = rt?.meta;
  const lowConf = !!meta?.low_confidence;
  const usedPlanner = !!(meta?.stage_decisions?.used_llm_planner || meta?.stage_decisions?.used_act_planner);
  const goalsCount = meta?.goals_summary?.length ?? 1;
  const exp = row.expectations;

  if (lowConf && !usedPlanner) return 'D';
  if (!multiActCorrect || !multiGoalCorrect) return 'B';
  if (exp.must_have_multi_goal && goalsCount < 2) return 'C';
  if (!exp.must_have_multi_goal && goalsCount >= 2) return 'C';
  if (!actFamilyHit) return 'A';
  return 'A';
}

function parseRepeat(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repeat' && args[i + 1] != null) {
      const n = parseInt(args[i + 1], 10);
      return n >= 1 ? n : 3;
    }
  }
  return 3;
}

type CaseResult = {
  index: number;
  row: LabeledRow;
  run: RunResult;
  pass: boolean;
  softFail: boolean;
  hardFail: boolean;
  bucket: BucketV2;
};

interface RunOnePassOptions {
  /** If set, stop before next query when Date.now() >= deadlineAt (graceful timeout). */
  deadlineAt?: number;
  /** Progress: (queryIndex1Based, totalQueries). */
  onProgress?: (j: number, total: number) => void;
}

async function runOnePass(
  baseUrl: string,
  dev: LabeledRow[],
  tenantId: string,
  userId: string,
  options: RunOnePassOptions = {}
): Promise<CaseResult[]> {
  const { deadlineAt, onProgress } = options;
  const results: CaseResult[] = [];
  for (let i = 0; i < dev.length; i++) {
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      for (let k = i; k < dev.length; k++) {
        const row = dev[k];
        results.push({
          index: k + 1,
          row,
          run: { retrievalTrace: null, latencyMs: 0 },
          pass: false,
          softFail: false,
          hardFail: true,
          bucket: 'A',
        });
      }
      return results;
    }
    onProgress?.(i + 1, dev.length);
    const row = dev[i];
    const run = await runQuery(baseUrl, row.query, tenantId, userId);
    const rt = run.retrievalTrace;
    const exp = row.expectations;
    const actFamilyHit = checkActFamilyHit(rt, exp.expected_act_families);
    const multiGoalCorrect = checkMultiGoalCorrect(rt, exp.must_have_multi_goal);
    const multiActCorrect = checkMultiActCorrect(rt, exp.must_have_multi_act);
    const pass = actFamilyHit && multiGoalCorrect && multiActCorrect;
    const expectedConf = exp.heuristic_confidence ?? 0.5;
    const softFail =
      !pass && !actFamilyHit && multiGoalCorrect && multiActCorrect && expectedConf < EXPECTED_CONFIDENCE_HARD_THRESHOLD;
    const hardFail = !pass && !softFail;
    const bucket = hardFail ? classifyBucketV2(row, rt, actFamilyHit, multiGoalCorrect, multiActCorrect) : 'A';
    results.push({
      index: i + 1,
      row,
      run,
      pass,
      softFail,
      hardFail,
      bucket,
    });
  }
  return results;
}

async function main(): Promise<void> {
  const repeat = parseRepeat();
  const labeledPath = resolve(__dirname, '../_datasets', 'retrieval_real_labeled.json');
  let labeled: LabeledRow[];
  try {
    labeled = JSON.parse(readFileSync(labeledPath, 'utf8')) as LabeledRow[];
  } catch {
    console.error('[report_policy_targets_v2] Run brain:dataset:retrieval-real and brain:label:retrieval-expectations first.');
    process.exit(1);
  }
  const { dev } = splitLabeled(labeled);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(
    '[report_policy_targets_v2] port',
    port,
    'DEV cases',
    dev.length,
    'repeat',
    repeat,
    'total_timeout_ms',
    REPORT_TOTAL_TIMEOUT_MS
  );

  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  const runsResults: CaseResult[][] = [];
  const startTime = Date.now();
  const deadlineAt = startTime + REPORT_TOTAL_TIMEOUT_MS;

  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[report_policy_targets_v2] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (let r = 0; r < repeat; r++) {
      if (Date.now() >= deadlineAt) {
        console.log('[report_policy_targets_v2] total timeout reached, stopping after', r, 'runs');
        break;
      }
      console.log('[report_policy_targets_v2] run', r + 1, '/', repeat);
      const oneRun = await runOnePass(baseUrl, dev, tenantId, userId, {
        deadlineAt,
        onProgress: (j, total) => console.log('[report_policy_targets_v2] run', r + 1, '/', repeat, 'query', j, '/', total),
      });
      runsResults.push(oneRun);
      const passCount = oneRun.filter((x) => x.pass).length;
      const hardCount = oneRun.filter((x) => x.hardFail).length;
      console.log('[report_policy_targets_v2] run', r + 1, 'PASS', passCount, 'hard_fail', hardCount);
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

  const consensusMin = Math.ceil((2 / 3) * repeat);
  const hardFailCountByIndex = new Map<number, number>();
  for (let i = 0; i < dev.length; i++) {
    const count = runsResults.filter((run) => run[i].hardFail).length;
    hardFailCountByIndex.set(i, count);
  }

  const consensusHardFailIndices = [...Array(dev.length).keys()].filter(
    (i) => (hardFailCountByIndex.get(i) ?? 0) >= consensusMin
  );

  const hardFails: Array<CaseResult & { hardFailRuns: number; consensusLabel: 'HARD_FAIL_STABLE' | 'HARD_FAIL_FLAKY' }> = [];
  for (const i of consensusHardFailIndices) {
    const lastRunResult = runsResults[runsResults.length - 1][i];
    const hardFailRuns = hardFailCountByIndex.get(i) ?? 0;
    const consensusLabel = hardFailRuns === repeat ? 'HARD_FAIL_STABLE' : 'HARD_FAIL_FLAKY';
    hardFails.push({ ...lastRunResult, hardFailRuns, consensusLabel });
  }

  const bucketCounts: Record<BucketV2, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const f of hardFails) {
    bucketCounts[f.bucket]++;
  }

  const reportDir = resolve(__dirname, '../_reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, 'retrieval_real_dev_failures_policy_targets_v2.md');

  const lastRun = runsResults[runsResults.length - 1] ?? [];
  const routingPathCounts: Record<string, number> = { TAXONOMY_FIRST: 0, ACTS_SEARCH: 0, NONE: 0 };
  for (const c of lastRun) {
    const path = c.run.retrievalTrace?.meta?.routing_hints?.routing_path ?? 'NONE';
    routingPathCounts[path] = (routingPathCounts[path] ?? 0) + 1;
  }

  const lines: string[] = [
    '# Retrieval real DEV failures — policy targets v2',
    '',
    `Generated: ${new Date().toISOString()}`,
    `repeat: ${repeat} | consensus: hard_fail if ≥${consensusMin}/${repeat} runs`,
    `hard_fail (consensus): ${hardFails.length} (of ${dev.length} DEV)`,
    `routing_path (last run): TAXONOMY_FIRST=${routingPathCounts.TAXONOMY_FIRST ?? 0} ACTS_SEARCH=${routingPathCounts.ACTS_SEARCH ?? 0} NONE=${routingPathCounts.NONE ?? 0}`,
    '',
    '## Buckets',
    '- **A)** Wrong family routing',
    '- **B)** Missing multi-act coverage per goal',
    '- **C)** Procedure/substance split missed (or over-split)',
    '- **D)** Low_confidence should-have-triggered planner/rewrite',
    '',
    '| Bucket | Count |',
    '| --- | --- |',
    ...Object.entries(bucketCounts).map(([k, v]) => `| ${k} | ${v} |`),
    '',
  ];

  for (const f of hardFails) {
    const rt = f.run.retrievalTrace;
    const meta = rt?.meta;
    const selectedActs = meta?.selected_acts ?? [];
    const goalsSummary = meta?.goals_summary ?? [];
    const breakdown = meta?.selected_acts_sources_breakdown;
    const chunksEvidence = meta?.chunks_evidence_top_acts ?? [];
    const reasonCodes = [
      ...(meta?.reason_codes ?? []),
      ...(meta?.selected_acts_decision?.reason_codes ?? []),
    ];
    const decisionReasonCodes = meta?.selected_acts_decision?.reason_codes ?? [];

    lines.push('---');
    lines.push(`### FAIL #${f.index} [${f.bucket}] ${f.consensusLabel}`);
    lines.push('');
    lines.push(`**Consensus:** ${f.consensusLabel} (hard_fail in ${f.hardFailRuns}/${repeat} runs)`);
    lines.push('');
    lines.push(`**Query:** ${f.row.query}`);
    lines.push('');
    lines.push(`**Expected families:** ${JSON.stringify(f.row.expectations.expected_act_families.map((x) => x.family_id))}`);
    lines.push(`**must_multi_goal:** ${f.row.expectations.must_have_multi_goal}, **must_multi_act:** ${f.row.expectations.must_have_multi_act}`);
    lines.push('');
    lines.push('**goals_summary:**');
    for (const g of goalsSummary) {
      lines.push(`- goal_id: ${(g as { goal_id?: string }).goal_id}, required_categories: ${JSON.stringify((g as { required_categories?: string[] }).required_categories ?? [])}`);
    }
    if (goalsSummary.length === 0) lines.push('- (single goal)');
    lines.push('');
    lines.push('**selected_acts:**');
    for (const a of selectedActs) {
      const x = a as { rada_nreg?: string; act_title?: string };
      lines.push(`- ${x.rada_nreg ?? '-'} | ${x.act_title ?? '-'}`);
    }
    if (selectedActs.length === 0) lines.push('- (none)');
    lines.push('');
    lines.push('**selected_acts_sources_breakdown:**');
    lines.push(breakdown != null ? JSON.stringify(breakdown, null, 2).slice(0, 500) + (JSON.stringify(breakdown).length > 500 ? '...' : '') : '-');
    lines.push('');
    lines.push('**chunks_evidence_top_acts (top10):**');
    for (const e of chunksEvidence.slice(0, 10)) {
      const x = e as { rada_nreg?: string; count_in_top30?: number; max_score?: number };
      lines.push(`- ${x.rada_nreg ?? '-'} count_in_top30=${x.count_in_top30 ?? '-'} max_score=${x.max_score ?? '-'}`);
    }
    if (chunksEvidence.length === 0) lines.push('- (none)');
    lines.push('');
    lines.push(`**selected_acts_decision.reason_codes:** ${JSON.stringify(decisionReasonCodes)}`);
    lines.push(`**meta.reason_codes:** ${JSON.stringify(meta?.reason_codes ?? [])}`);
    lines.push(`**low_confidence:** ${!!meta?.low_confidence}`);
    lines.push(`**qdrant_calls_count_total:** ${meta?.qdrant_calls_count_total ?? '-'}`);
    lines.push(`**latency_ms:** ${f.run.latencyMs}`);

    const routingHints = meta?.routing_hints;
    const routingCalled = routingHints?.called === true;
    const routingUsed = (meta?.selected_acts_sources_breakdown as { from_routing_hints?: string[] } | undefined)?.from_routing_hints?.length ? true : false;
    lines.push('');
    lines.push('**routing_hints:**');
    lines.push(`- called: ${routingCalled}`);
    lines.push(`- used: ${routingUsed}`);
    if (routingHints?.not_used_reason_codes?.length) {
      lines.push(`- not_used_reason_codes: ${JSON.stringify(routingHints.not_used_reason_codes)}`);
    }
    if (routingHints?.used_reason_codes?.length) {
      lines.push(`- used_reason_codes: ${JSON.stringify(routingHints.used_reason_codes)}`);
    }
    if (routingHints?.used_effect && routingHints.used_effect.added_count > 0) {
      lines.push(`- used_effect.added_count: ${routingHints.used_effect.added_count}`);
      if (routingHints.used_effect.added_act) {
        lines.push(`- used_effect.added_act: ${JSON.stringify(routingHints.used_effect.added_act)}`);
      }
    }
    lines.push(`- routing_path: ${routingHints?.routing_path ?? 'NONE'}`);
    if (routingHints?.families_ranked_top2?.length) {
      lines.push(`- families_ranked_top2: ${JSON.stringify(routingHints.families_ranked_top2)}`);
    }
    if (routingHints?.call_failed_reason) {
      lines.push(`- call_failed_reason: ${routingHints.call_failed_reason}`);
    }
    lines.push(`- triggers/reason_codes (may have triggered call): ${JSON.stringify(meta?.reason_codes ?? [])}`);

    const familyEvidence = meta?.family_evidence_summary;
    if (familyEvidence) {
      lines.push('');
      lines.push('**family_evidence_summary:**');
      lines.push(`- dominant_family_key: ${familyEvidence.dominant_family_key ?? '-'}`);
      lines.push(`- family_confidence/support: ${familyEvidence.family_confidence ?? familyEvidence.top2?.[0]?.support_score ?? '-'}`);
      lines.push(`- family_conflict: ${!!familyEvidence.family_conflict}`);
      lines.push(`- top2: ${familyEvidence.top2 ? JSON.stringify(familyEvidence.top2) : '-'}`);
    }

    const selActsFamilyKeys = selectedActsFamilyKeys(selectedActs as Array<{ act_title?: string }>);
    lines.push('');
    lines.push(`**selected_acts_family_keys (from titles):** ${JSON.stringify(selActsFamilyKeys)}`);

    const mismatch = familyMismatchFlag(meta?.family_evidence_summary, selectedActs as Array<{ act_title?: string }>);
    lines.push(`**family_mismatch_flag:** ${mismatch}`);

    lines.push('');
  }

  lines.push('## Top 3 policy-target patterns');
  lines.push('');
  const order: BucketV2[] = [...(['A', 'B', 'C', 'D'] as const)].sort(
    (a, b) => (bucketCounts[b] ?? 0) - (bucketCounts[a] ?? 0)
  );
  const top3 = order.slice(0, 3).filter((k: BucketV2) => (bucketCounts[k] ?? 0) > 0);
  const labels: Record<BucketV2, string> = {
    A: 'Wrong family routing (selected_acts/evidence don\'t match expected families)',
    B: 'Missing multi-act coverage per goal',
    C: 'Procedure/substance split missed or over-split',
    D: 'Low_confidence should-have-triggered planner/rewrite',
  };
  for (const k of top3) {
    lines.push(`- **${k}** (${bucketCounts[k]}): ${labels[k]}`);
  }
  lines.push('');

  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log('[report_policy_targets_v2] Wrote', reportPath);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
