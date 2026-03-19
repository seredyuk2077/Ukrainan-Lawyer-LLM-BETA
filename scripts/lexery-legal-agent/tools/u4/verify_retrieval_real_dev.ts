#!/usr/bin/env node
/**
 * Phase 5.2 — Verify retrieval on DEV set (70% of real labeled queries).
 * Runs queries via local server; asserts only on expectations (act families, multi-goal, multi-act). No article-level assertions.
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { splitLabeled } from './retrieval_real_split.js';
import { RunRepository } from '../../gateway/storage.js';
import { getRetrievalTraceHitsForForensics } from '../../retrieval/retrieval-trace-r2.js';
import {
  findExpectationRank,
  type GoldenHitExpectation,
  type RetrievalTraceLike,
} from './rag_golden_eval.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runRepo = new RunRepository();

const FLAKY_CHECK_ENABLED =
  process.env.REAL_DEV_FLAKY_CHECK === '1' || process.argv.includes('--flaky-check');

type VerifyPack = {
  retrieval_real_dev?: { smoke?: number[]; real_dev_fast?: { pass_sample_size?: number; use_stable_fail_list?: boolean }; full?: string };
};

import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;
const ONLY_ARG = process.argv.find((arg) => arg.startsWith('--only='));
const ONLY_MODE = ONLY_ARG?.slice('--only='.length)?.toUpperCase();
const RETRIEVAL_ONLY_MODE =
  process.argv.includes('--retrieval-only') ||
  process.env.RETRIEVAL_REAL_DEV_RETRIEVAL_ONLY === '1' ||
  ONLY_MODE === 'FAST' ||
  ONLY_MODE === 'SMOKE';
const ARTICLE_RANK_MODE =
  process.argv.includes('--article-rank') ||
  process.env.RETRIEVAL_REAL_DEV_ARTICLE_MODE === '1';
const SKIP_U10_POSTCHECK =
  RETRIEVAL_ONLY_MODE || process.env.RETRIEVAL_REAL_DEV_SKIP_U10_POSTCHECK === '1';

/** family_id -> regex to match act title (Ukrainian). "general" matches any. labor/labor_social aligned with taxonomy. */
const FAMILY_TITLE_SIGNALS: Record<string, RegExp> = {
  criminal: /кримін|кку|злочин|кримінальний\s+кодекс/i,
  criminal_procedure: /кпк|кримінальн.*процес|кримінально.*процесуальн/i,
  civil: /цивіль|цк\s*у|цік|цивільний\s+кодекс/i,
  civil_procedure: /ципк|цпк|цивільн.*процес/i,
  administrative: /адмін|адміністративн/i,
  administrative_offenses: /купап|адмін.*правопоруш|кодекс.*адмін/i,
  tax_customs: /податк|пкку|податковий\s+кодекс/i,
  /** Labeler may use "tax"; same signals as tax_customs (ПКУ, податковий кодекс). */
  tax: /податк|пкку|податковий\s+кодекс/i,
  labor: /працю|труд|кзпп|трудовий|кодекс\s+законів\s+про\s+працю/i,
  labor_social: /труд|кзпп|трудовий\s+кодекс|працю|кодекс\s+законів\s+про\s+працю/i,
  constitutional: /конституц/i,
  anti_corruption: /корупц|протидія.*корупц/i,
  finance_banking: /банк|фінмон|санкц/i,
  admin: /адмін|адміністративн|купап/i,
  other: /./,
};

function actTitleMatchesFamily(title: string, familyId: string): boolean {
  if (familyId === 'general') return true;
  const re = FAMILY_TITLE_SIGNALS[familyId];
  if (!re) return title.toLowerCase().includes(familyId.toLowerCase());
  return re.test(title);
}

/** When expected_confidence < this, act_family_miss counts as soft_fail only. */
const EXPECTED_CONFIDENCE_HARD_THRESHOLD = 0.5;

/** Exported for unit tests: smoke gate must require 0 stable fails (7/7 PASS). */
export function getRetrievalGateThresholds(
  total: number,
  isSmokeRun: boolean,
  isLimitedRun: boolean
): { minHardPass: number; maxHardFail: number } {
  const minHardPassFull = parseInt(process.env.RETRIEVAL_REAL_DEV_MIN_HARD_PASS ?? '30', 10);
  const maxHardFailFull = parseInt(process.env.RETRIEVAL_REAL_DEV_MAX_HARD_FAIL ?? '13', 10);
  const minHardPass = isSmokeRun
    ? total
    : isLimitedRun
      ? Math.max(1, Math.floor(total * 0.6))
      : minHardPassFull;
  const maxHardFail = isSmokeRun
    ? 0
    : isLimitedRun
      ? Math.min(total, Math.max(1, Math.ceil(total * 0.3)))
      : maxHardFailFull;
  return { minHardPass, maxHardFail };
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
    heuristic_confidence?: number;
  };
}

interface RunResult {
  run_id?: string;
  retrievalTrace: (RetrievalTraceLike & {
    hits?: Array<{
      title?: string;
      act_title?: string;
      rada_nreg?: string;
      article_number?: string | null;
    }>;
    meta?: {
      hits_count?: number;
      low_confidence?: boolean;
      full_trace_r2_key?: string;
      act_candidates_top?: Array<{ rada_nreg?: string; title?: string }>;
      selected_acts?: Array<{
        rada_nreg?: string;
        act_title?: string;
        category?: string | null;
        document_type?: string | null;
      }>;
      goals_summary?: Array<{ goal_id: string }>;
      qdrant_calls_count_total?: number;
      hits_cap_applied?: boolean;
      stage_decisions?: { used_llm_planner?: boolean; used_act_planner?: boolean };
      planner?: { tier?: number; duration_ms?: number };
      routing_hints?: {
        enabled?: boolean;
        called?: boolean;
        not_used_reason_codes?: string[];
        used_reason_codes?: string[];
        routing_path?: 'TAXONOMY_FIRST' | 'ACTS_SEARCH' | 'NONE';
        tokens_approx?: number;
      };
      reason_codes?: string[];
      selected_acts_decision?: { reason_codes?: string[] };
      selected_acts_sources_breakdown?: { from_routing_hints?: string[] };
      family_evidence_summary?: { dominant_family_key?: string };
    };
  }) | null;
  promptTokens?: number;
  latencyMs: number;
}

interface ArticleExpectationOverlayRow {
  fingerprint: string;
  query?: string;
  expected_primary?: GoldenHitExpectation;
  expected_hits?: GoldenHitExpectation[];
}

type ArticleExpectationOverlayMap = Map<string, ArticleExpectationOverlayRow>;

export interface ArticleExpectationEvaluation {
  applied: boolean;
  pass: boolean;
  reasons: string[];
  primary_rank?: number;
  expected_hit_ranks: Record<string, number | null>;
}

type HydratedArticleTraceResult = {
  trace: RunResult['retrievalTrace'];
  ready: boolean;
  source: 'db' | 'r2' | 'fallback';
};

type RunGetPayload = {
  status?: string;
  retrieval_trace?: RunResult['retrievalTrace'];
};

/** Resolve --only=SMOKE|FAST|FULL or ONLY_CASES=0,1,2. Returns indices into dev array or 'all'. */
function getOnlyIndices(devLength: number): number[] | 'all' {
  const onlyCasesEnv = process.env.ONLY_CASES?.trim();
  if (onlyCasesEnv) {
    const indices = onlyCasesEnv.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0 && n < devLength);
    if (indices.length) return indices;
  }
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyValue = onlyArg?.slice('--only='.length)?.toUpperCase();
  if (onlyValue === 'FULL' || !onlyValue) return 'all';
  try {
    const path = resolve(__dirname, '../_datasets', 'verify_packs.json');
    if (!existsSync(path)) return 'all';
    const raw = readFileSync(path, 'utf8');
    const packs = JSON.parse(raw) as VerifyPack;
    const pack = packs.retrieval_real_dev;
    if (onlyValue === 'SMOKE' && pack?.smoke?.length) {
      return pack.smoke.filter((i) => i >= 0 && i < devLength);
    }
    if (onlyValue === 'FAST' && pack?.real_dev_fast?.use_stable_fail_list) {
      const stablePath = resolve(__dirname, '../_datasets', 'stable_fail_list.json');
      let failIndices: number[] = [];
      if (existsSync(stablePath)) {
        try {
          const data = JSON.parse(readFileSync(stablePath, 'utf8')) as { indices?: number[] };
          failIndices = (data.indices ?? []).filter((i) => Number.isFinite(i) && i >= 0 && i < devLength);
        } catch {
          // ignore
        }
      }
      const passSampleSize = pack.real_dev_fast?.pass_sample_size ?? 10;
      const passIndices: number[] = [];
      for (let i = 0; i < devLength && passIndices.length < passSampleSize; i += 2) passIndices.push(i);
      const combined = [...new Set([...failIndices, ...passIndices])].sort((a, b) => a - b);
      return combined.length ? combined : 'all';
    }
  } catch {
    // no pack
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

const TERMINAL_STATUSES = ['completed', 'failed', 'U11_DONE', 'Deliver'];
const RUN_TERMINAL_POLL_MS = 500;
const RUN_TERMINAL_TIMEOUT_MS = 120_000;
const U10_POSTCHECK_RETRIES = 6;
const U10_POSTCHECK_RETRY_DELAY_MS = 5_000;
const DB_TERMINAL_STATUSES = new Set(TERMINAL_STATUSES);
const ARTICLE_TRACE_HYDRATION_RETRIES = 5;
const ARTICLE_TRACE_HYDRATION_DELAY_MS = 1_000;

/** Poll GET /v1/runs/:id until status is terminal. Canonical for U10 post-check readiness. */
async function waitRunTerminal(
  baseUrl: string,
  runId: string,
  timeoutMs: number = RUN_TERMINAL_TIMEOUT_MS
): Promise<{ terminal: boolean; status?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (r.status === 200) {
        const body = (await r.json()) as { status?: string };
        const status = body?.status;
        if (typeof status === 'string' && TERMINAL_STATUSES.includes(status)) {
          return { terminal: true, status };
        }
      }
    } catch {
      // ignore
    }
    await sleep(RUN_TERMINAL_POLL_MS);
  }
  return { terminal: false };
}

/** Wait for terminal with retries: 6 x 5s delay after first wait, then short re-check. */
async function waitRunTerminalWithRetries(
  baseUrl: string,
  runId: string
): Promise<{ terminal: boolean; status?: string }> {
  let result = await waitRunTerminal(baseUrl, runId);
  for (let r = 0; r < U10_POSTCHECK_RETRIES && !result.terminal; r++) {
    await sleep(U10_POSTCHECK_RETRY_DELAY_MS);
    result = await waitRunTerminal(baseUrl, runId, 15_000);
  }
  return result;
}

async function waitRunTerminalViaDb(runId: string): Promise<{ terminal: boolean; status?: string }> {
  try {
    const run = await runRepo.findByRunId(runId);
    const status = typeof run?.status === 'string' ? run.status : undefined;
    if (status && DB_TERMINAL_STATUSES.has(status)) {
      return { terminal: true, status };
    }
  } catch {
    // HTTP remains primary; DB is verifier fallback so timing lag does not fake a failure.
  }
  return { terminal: false };
}

export function isRetrievalTraceReadyForScoring(
  status: string | undefined,
  retrievalTrace: RunResult['retrievalTrace'] | undefined | null,
  requireTerminal: boolean = true
): boolean {
  if (requireTerminal && (!status || !TERMINAL_STATUSES.includes(status))) return false;
  if (retrievalTrace == null || typeof retrievalTrace !== 'object') return false;
  const hitsCount = retrievalTrace.meta?.hits_count;
  if (typeof hitsCount === 'number' && hitsCount >= 0) return true;
  return retrievalTrace.meta?.low_confidence === true;
}

async function fetchRunPayload(baseUrl: string, runId: string): Promise<RunGetPayload | null> {
  try {
    const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, {
      headers: { 'X-Dev-API-Key': DEV_KEY },
    });
    if (getRes.status !== 200) return null;
    return (await getRes.json()) as RunGetPayload;
  } catch {
    return null;
  }
}

function loadArticleExpectationOverlay(): ArticleExpectationOverlayMap {
  const overlayPath = resolve(__dirname, '../_datasets', 'retrieval_real_article_expectations.json');
  if (!existsSync(overlayPath)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(overlayPath, 'utf8')) as ArticleExpectationOverlayRow[];
    return new Map(
      raw
        .filter((row) => typeof row.fingerprint === 'string' && row.fingerprint.trim().length > 0)
        .map((row) => [row.fingerprint.trim(), row])
    );
  } catch {
    return new Map();
  }
}

async function hydrateTraceForArticleScoring(
  runId: string | undefined,
  fallbackTrace: RunResult['retrievalTrace']
): Promise<HydratedArticleTraceResult> {
  if (!runId) return { trace: fallbackTrace, ready: false, source: 'fallback' };
  try {
    const persisted = await runRepo.findByRunId(runId);
    if (!persisted?.retrieval_trace || typeof persisted.retrieval_trace !== 'object') {
      return { trace: fallbackTrace, ready: false, source: 'fallback' };
    }
    const persistedTrace = persisted.retrieval_trace as RunResult['retrievalTrace'];
    const fullTraceKey = persistedTrace?.meta?.full_trace_r2_key;
    let forensicHits: unknown[] = Array.isArray(persistedTrace?.hits) ? persistedTrace.hits : [];
    let forensicSource: 'db' | 'r2' = 'db';
    for (let attempt = 0; attempt < ARTICLE_TRACE_HYDRATION_RETRIES; attempt += 1) {
      const forensic = await getRetrievalTraceHitsForForensics(
        persisted as { retrieval_trace?: { hits?: unknown[]; meta?: { full_trace_r2_key?: string } } | null }
      );
      forensicHits = forensic.hits;
      forensicSource = forensic.source;
      if (!fullTraceKey || forensicSource === 'r2') break;
      await sleep(ARTICLE_TRACE_HYDRATION_DELAY_MS);
    }
    const trace = {
      ...persistedTrace,
      hits: forensicHits as RunResult['retrievalTrace']['hits'],
    };
    if (fullTraceKey && forensicSource !== 'r2') {
      return { trace, ready: false, source: 'db' };
    }
    return {
      trace,
      ready: true,
      source: forensicSource,
    };
  } catch {
    return { trace: fallbackTrace, ready: false, source: 'fallback' };
  }
}

export function evaluateArticleExpectations(
  trace: RunResult['retrievalTrace'],
  expectation: ArticleExpectationOverlayRow | null | undefined
): ArticleExpectationEvaluation {
  if (!expectation || (!expectation.expected_primary && !(expectation.expected_hits?.length))) {
    return {
      applied: false,
      pass: true,
      reasons: [],
      expected_hit_ranks: {},
    };
  }
  const hits = trace?.hits ?? [];
  const reasons: string[] = [];
  const expectedHitRanks: Record<string, number | null> = {};
  let primaryRank: number | undefined;

  if (expectation.expected_primary) {
    const rank = findExpectationRank(hits, expectation.expected_primary);
    primaryRank = rank ?? undefined;
    if (rank == null) {
      reasons.push(
        `article_miss:${expectation.expected_primary.rada_nreg}:${(expectation.expected_primary.article_numbers ?? []).join('|') || '*'}`
      );
    } else if (rank > expectation.expected_primary.max_rank) {
      reasons.push(`rank_miss:primary:${rank}>${expectation.expected_primary.max_rank}`);
    }
  }

  for (const hitExpectation of expectation.expected_hits ?? []) {
    const key = `${hitExpectation.rada_nreg}:${(hitExpectation.article_numbers ?? []).join('|') || '*'}`;
    const rank = findExpectationRank(hits, hitExpectation);
    expectedHitRanks[key] = rank;
    if (rank == null) {
      reasons.push(`article_miss:${key}`);
    } else if (rank > hitExpectation.max_rank) {
      reasons.push(`rank_miss:${key}:${rank}>${hitExpectation.max_rank}`);
    }
  }

  return {
    applied: true,
    pass: reasons.length === 0,
    reasons,
    primary_rank: primaryRank,
    expected_hit_ranks: expectedHitRanks,
  };
}

async function runQuery(
  baseUrl: string,
  query: string,
  tenantId: string,
  userId: string,
  requireTerminalForScoring: boolean
): Promise<RunResult> {
  const start = Date.now();
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
      return { retrievalTrace: null, latencyMs: Date.now() - start, run_id: undefined };
    }
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { retrievalTrace: null, latencyMs: Date.now() - start, run_id: undefined };
  } catch {
    return { retrievalTrace: null, latencyMs: Date.now() - start, run_id: undefined };
  }

  const pollStart = Date.now();
  let latestPayload: RunGetPayload | null = null;
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    const payload = await fetchRunPayload(baseUrl, runId);
    if (payload) {
      latestPayload = payload;
      if (isRetrievalTraceReadyForScoring(payload.status, payload.retrieval_trace, requireTerminalForScoring)) {
        return {
          run_id: runId,
          retrievalTrace: payload.retrieval_trace ?? null,
          latencyMs: Date.now() - start,
        };
      }
    }
    await sleep(POLL_MS);
  }

  let waitResult = { terminal: false as boolean, status: undefined as string | undefined };
  if (requireTerminalForScoring) {
    waitResult = await waitRunTerminalWithRetries(baseUrl, runId);
    if (!waitResult.terminal) {
      waitResult = await waitRunTerminalViaDb(runId);
    }
  }

  if (waitResult.terminal) {
    const finalPayload = await fetchRunPayload(baseUrl, runId);
    if (
      isRetrievalTraceReadyForScoring(
        finalPayload?.status,
        finalPayload?.retrieval_trace,
        requireTerminalForScoring
      )
    ) {
      return {
        run_id: runId,
        retrievalTrace: finalPayload?.retrieval_trace ?? null,
        latencyMs: Date.now() - start,
      };
    }
    try {
      const fromDb = await runRepo.findByRunId(runId);
      const dbTrace = fromDb?.retrieval_trace as RunResult['retrievalTrace'] | undefined;
      if (isRetrievalTraceReadyForScoring(fromDb?.status, dbTrace, requireTerminalForScoring)) {
        return {
          run_id: runId,
          retrievalTrace: dbTrace ?? null,
          latencyMs: Date.now() - start,
        };
      }
    } catch {
      // DB is a verifier fallback only
    }
  }

  if (isRetrievalTraceReadyForScoring(latestPayload?.status, latestPayload?.retrieval_trace, requireTerminalForScoring)) {
    return {
      run_id: runId,
      retrievalTrace: latestPayload?.retrieval_trace ?? null,
      latencyMs: Date.now() - start,
    };
  }

  return { retrievalTrace: null, latencyMs: Date.now() - start, run_id: runId };
}

async function warmVerifierServer(baseUrl: string, tenantId: string, userId: string): Promise<void> {
  await runQuery(baseUrl, 'ККУ ст. 115 умисне вбивство', tenantId, userId, !RETRIEVAL_ONLY_MODE).catch(
    () => undefined
  );
}

export function checkActFamilyHit(rt: RunResult['retrievalTrace'], expectedFamilies: Array<{ family_id: string }>): boolean {
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
      case 'corporate':
      case 'business':
      case 'business_corporate':
        return 'business_corporate';
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
  const selectedActCategories = new Set(
    selectedActs
      .map((act) => normalizeFamilyId(act.category ?? undefined))
      .filter((category): category is string => typeof category === 'string' && category.length > 0)
  );
  const allTitles = [
    ...actCandidates.map((a) => a.title ?? ''),
    ...selectedActs.map((a) => a.act_title ?? ''),
    ...hits.map((h) => (h.act_title ?? h.title) ?? ''),
  ].filter(Boolean);
  for (const exp of expectedFamilies) {
    if (exp.family_id === 'general') return true;
    const normalizedExpected = normalizeFamilyId(exp.family_id);
    if (dominantFamilyKey && normalizedExpected && dominantFamilyKey === normalizedExpected) return true;
    if (normalizedExpected && selectedActCategories.has(normalizedExpected)) return true;
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
    console.error('[verify_retrieval_real_dev] Run brain:dataset:retrieval-real and brain:label:retrieval-expectations first.');
    process.exit(1);
  }
  const { dev } = splitLabeled(labeled);
  const onlyIndices = getOnlyIndices(dev.length);
  const caseIndices = onlyIndices === 'all' ? dev.map((_, i) => i) : onlyIndices;
  const devToRun = caseIndices.map((i) => ({ index: i, row: dev[i] }));
  const articleExpectationOverlay = loadArticleExpectationOverlay();

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(
    '[verify_retrieval_real_dev] port',
    port,
    'DEV cases',
    devToRun.length,
    onlyIndices !== 'all' ? `(--only: ${caseIndices.length} cases)` : '',
    FLAKY_CHECK_ENABLED ? 'flaky_check=ON' : '',
    ARTICLE_RANK_MODE ? 'article_rank=ON' : ''
  );

  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    LEGAL_AGENT_DISABLE_LLM: 'true',
    U10_DRY_RUN_KEEP_TRIAGE: 'true',
    U9_META_TRIAGE_ENABLED: RETRIEVAL_ONLY_MODE ? 'false' : process.env.U9_META_TRIAGE_ENABLED,
    MEMORY_RECENT_ENABLED: RETRIEVAL_ONLY_MODE ? 'false' : process.env.MEMORY_RECENT_ENABLED,
    U5_STOP_AFTER_GATE: RETRIEVAL_ONLY_MODE ? 'true' : process.env.U5_STOP_AFTER_GATE,
  };
  if (!serverEnv.REDIS_QUEUE_NAMESPACE) {
    serverEnv.REDIS_QUEUE_NAMESPACE = `lexery:verify:retrieval-real-dev:${randomUUID()}`;
  }
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  let healthOk = false;
  type ResultRow = {
    pass: boolean;
    actFamilyHit: boolean;
    multiGoalCorrect: boolean;
    multiActCorrect: boolean;
    lowConf?: boolean;
    softFail?: boolean;
    latencyMs: number;
    hasTrace: boolean;
    run_id?: string;
    qdrantCalls?: number;
    goalsCount?: number;
    hitsCapApplied?: boolean;
    plannerTier?: number;
    llmPlannerUsed?: boolean;
    actPlannerUsed?: boolean;
    actListSize?: number;
    plannerDurationMs?: number;
    promptTokens?: number;
    failReasons?: string[];
    routingHintsCalled?: boolean;
    routingHintsUsed?: boolean;
    retrievalTrace?: RunResult['retrievalTrace'];
    articleExpectationApplied?: boolean;
    articleTraceReady?: boolean;
    articleTraceSource?: 'db' | 'r2' | 'fallback';
    articleStrictPass?: boolean;
    articleStrictReasons?: string[];
    articlePrimaryRank?: number;
    articleExpectedHitRanks?: Record<string, number | null>;
    /** Set after first pass; when flaky check ON, FAIL cases get re-run and status becomes FAIL_STABLE or FAIL_FLAKY. */
    status?: 'PASS' | 'FAIL_STABLE' | 'FAIL_FLAKY';
  };
  const results: ResultRow[] = [];
  let u10PostCheckFail = 0;
  const postCheckReasonCodes: string[] = [];
  const incompleteRunIds: string[] = [];

  try {
    healthOk = await waitHealth(baseUrl);
    if (!healthOk) {
      console.error('[verify_retrieval_real_dev] Health failed');
      process.exit(1);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    await warmVerifierServer(baseUrl, tenantId, userId);
    for (const { index: i, row } of devToRun) {
      const run = await runQuery(
        baseUrl,
        row.query,
        tenantId,
        userId,
        ARTICLE_RANK_MODE ? true : !RETRIEVAL_ONLY_MODE
      );
      const articleOverlay = ARTICLE_RANK_MODE ? articleExpectationOverlay.get(row.fingerprint) : undefined;
      const articleTraceHydration =
        ARTICLE_RANK_MODE && articleOverlay
          ? await hydrateTraceForArticleScoring(run.run_id, run.retrievalTrace)
          : { trace: run.retrievalTrace, ready: true, source: 'fallback' as const };
      const rt = articleTraceHydration.trace;
      const exp = row.expectations;
      const actFamilyHit = checkActFamilyHit(rt, exp.expected_act_families);
      const multiGoalCorrect = checkMultiGoalCorrect(rt, exp.must_have_multi_goal);
      const multiActCorrect = checkMultiActCorrect(rt, exp.must_have_multi_act);
      const articleEval =
        articleOverlay && !articleTraceHydration.ready
          ? {
              applied: false,
              pass: true,
              reasons: ['ARTICLE_TRACE_NOT_READY'],
              expected_hit_ranks: {},
            }
          : evaluateArticleExpectations(rt, articleOverlay);
      const pass =
        actFamilyHit &&
        multiGoalCorrect &&
        multiActCorrect &&
        (!ARTICLE_RANK_MODE || !articleEval.applied || articleEval.pass);
      const expectedConf = exp.heuristic_confidence ?? 0.5;
      const softFail =
        !pass && !actFamilyHit && (multiGoalCorrect && multiActCorrect) && expectedConf < EXPECTED_CONFIDENCE_HARD_THRESHOLD;
      const lowConf = !!rt?.meta?.low_confidence;
      let promptTokens: number | undefined;
      if (run.run_id) {
        try {
          const fullRun = await runRepo.findByRunId(run.run_id);
          const pt = fullRun?.prompt_tokens;
          if (typeof pt === 'number') promptTokens = pt;
        } catch { /* best-effort */ }
      }
      results.push({
        pass,
        actFamilyHit,
        multiGoalCorrect,
        multiActCorrect,
        lowConf,
        softFail,
        latencyMs: run.latencyMs,
        hasTrace: rt != null,
        run_id: run.run_id,
        qdrantCalls: rt?.meta?.qdrant_calls_count_total,
        goalsCount: rt?.meta?.goals_summary?.length,
        hitsCapApplied: rt?.meta?.hits_cap_applied,
        plannerTier: rt?.meta?.planner?.tier,
        llmPlannerUsed: rt?.meta?.stage_decisions?.used_llm_planner,
        actPlannerUsed: rt?.meta?.stage_decisions?.used_act_planner,
        actListSize: (rt?.meta?.selected_acts ?? rt?.meta?.act_candidates_top ?? []).length,
        plannerDurationMs: rt?.meta?.planner?.duration_ms,
        promptTokens,
        failReasons: pass ? [] : [(!actFamilyHit && 'act_family_miss'), (!multiGoalCorrect && 'multi_goal_miss'), (!multiActCorrect && 'multi_act_miss')].filter(Boolean) as string[],
        routingHintsCalled: rt?.meta?.routing_hints?.called === true,
        routingHintsUsed:
          (rt?.meta?.selected_acts_sources_breakdown?.from_routing_hints?.length ?? 0) > 0,
        retrievalTrace: rt ?? undefined,
        articleExpectationApplied: articleEval.applied,
        articleTraceReady: articleTraceHydration.ready,
        articleTraceSource: articleTraceHydration.source,
        articleStrictPass: articleEval.applied ? articleEval.pass : undefined,
        articleStrictReasons: articleEval.applied ? articleEval.reasons : undefined,
        articlePrimaryRank: articleEval.applied ? articleEval.primary_rank : undefined,
        articleExpectedHitRanks: articleEval.applied ? articleEval.expected_hit_ranks : undefined,
        status: pass ? 'PASS' : undefined,
      });
      const label = `#${i + 1} "${row.query.slice(0, 50)}..."`;
      if (pass) {
        if (articleEval.applied && !articleEval.pass) {
          console.log('[verify_retrieval_real_dev]', label, 'PASS', `ARTICLE_FAIL(${articleEval.reasons.join(', ')})`);
        } else if (articleEval.applied) {
          console.log(
            '[verify_retrieval_real_dev]',
            label,
            'PASS',
            articleEval.primary_rank != null ? `article_primary_rank=${articleEval.primary_rank}` : 'ARTICLE_PASS'
          );
        } else if (articleOverlay && !articleTraceHydration.ready) {
          console.log('[verify_retrieval_real_dev]', label, `PASS ARTICLE_SKIPPED(${articleTraceHydration.source})`);
        } else {
          console.log('[verify_retrieval_real_dev]', label, 'PASS');
        }
      } else {
        const reasons: string[] = [];
        if (!actFamilyHit) reasons.push('act_family_miss');
        if (!multiGoalCorrect) reasons.push('multi_goal_miss');
        if (!multiActCorrect) reasons.push('multi_act_miss');
        if (articleEval.applied && !articleEval.pass) reasons.push(...articleEval.reasons);
        console.error('[verify_retrieval_real_dev]', label, 'FAIL', reasons.join(', '));
      }
    }

    if (SKIP_U10_POSTCHECK) {
      console.log('[verify_retrieval_real_dev] U10 post-check skipped (retrieval-only mode)');
    } else {
      // U10 post-check: wait for terminal status (with retries) then GET ?include_snapshot=1 (canonical).
      for (const r of results) {
        if (!r.run_id) continue;
        let waitResult = await waitRunTerminalWithRetries(baseUrl, r.run_id);
        if (!waitResult.terminal) {
          waitResult = await waitRunTerminalViaDb(r.run_id);
        }
        if (!waitResult.terminal) {
          incompleteRunIds.push(r.run_id);
          console.error('[verify_retrieval_real_dev] U10 post-check: run_not_terminal run_id=', r.run_id);
          u10PostCheckFail++;
          postCheckReasonCodes.push('run_not_terminal');
          continue;
        }
        try {
          const getRes = await fetch(`${baseUrl}/v1/runs/${r.run_id}?include_snapshot=1`, {
            headers: { 'X-Dev-API-Key': DEV_KEY },
          });
          if (getRes.status !== 200) {
            u10PostCheckFail++;
            postCheckReasonCodes.push('API_NON_200');
            console.error('[verify_retrieval_real_dev] U10 post-check: GET /v1/runs/:id returned', getRes.status, 'run_id=', r.run_id);
            continue;
          }
          let runBody = (await getRes.json()) as { snapshot?: { u10_selection?: { triage_used?: boolean; triage_attempt_trail?: unknown[] } } };
          if (runBody.snapshot == null) {
            const fromDb = await runRepo.findByRunId(r.run_id);
            if (fromDb?.snapshot != null && typeof fromDb.snapshot === 'object') {
              runBody = { snapshot: fromDb.snapshot as { u10_selection?: { triage_used?: boolean; triage_attempt_trail?: unknown[] } } };
            }
          }
          const u10 = runBody.snapshot?.u10_selection;
          if (r.hasTrace && !u10) {
            console.error('[verify_retrieval_real_dev] U10 post-check: snapshot_missing_on_completed run_id=', r.run_id);
            u10PostCheckFail++;
            postCheckReasonCodes.push('snapshot_missing_on_completed');
          } else if (u10?.triage_used && (!u10.triage_attempt_trail || u10.triage_attempt_trail.length === 0)) {
            console.error('[verify_retrieval_real_dev] U10 post-check: triage_trail_empty_when_triage_used run_id=', r.run_id);
            u10PostCheckFail++;
            postCheckReasonCodes.push('triage_trail_empty_when_triage_used');
          }
        } catch (err) {
          u10PostCheckFail++;
          postCheckReasonCodes.push('POST_CHECK_EXCEPTION');
          console.error('[verify_retrieval_real_dev] U10 post-check: exception run_id=', r.run_id, err);
        }
      }
      if (u10PostCheckFail > 0) {
        console.error('[verify_retrieval_real_dev] U10 post-check failed:', u10PostCheckFail, 'runs');
      } else if (results.some((r) => r.run_id && r.hasTrace)) {
        console.log('[verify_retrieval_real_dev] U10 post-check: u10_selection present and triage_attempt_trail ok for triage-eligible runs');
      }
      const postCheckReasonCounts: Record<string, number> = {};
      for (const code of postCheckReasonCodes) {
        postCheckReasonCounts[code] = (postCheckReasonCounts[code] ?? 0) + 1;
      }
      if (Object.keys(postCheckReasonCounts).length > 0) {
        console.log('[verify_retrieval_real_dev] U10 post-check reason_codes:', Object.entries(postCheckReasonCounts).map(([k, v]) => `${k}=${v}`).join(', '));
      }
      if (incompleteRunIds.length > 0) {
        console.log('[verify_retrieval_real_dev] Incomplete run IDs (not terminal):', incompleteRunIds.join(', '));
      }
    }

    // Flaky check: re-run each hard-fail case once; set FAIL_STABLE (2/2 fail) or FAIL_FLAKY (1st fail, 2nd pass)
    if (FLAKY_CHECK_ENABLED && healthOk) {
      const hardFailIndices = results
        .map((r, idx) => ({ idx, row: devToRun[idx].row, exp: devToRun[idx].row.expectations }))
        .filter(({ idx }) => !results[idx].pass && !results[idx].softFail);
      for (const { idx, row, exp } of hardFailIndices) {
        const run2 = await runQuery(baseUrl, row.query, tenantId, userId, !RETRIEVAL_ONLY_MODE);
        const rt2 = run2.retrievalTrace;
        const actFamilyHit2 = checkActFamilyHit(rt2, exp.expected_act_families);
        const multiGoalCorrect2 = checkMultiGoalCorrect(rt2, exp.must_have_multi_goal);
        const multiActCorrect2 = checkMultiActCorrect(rt2, exp.must_have_multi_act);
        const pass2 = actFamilyHit2 && multiGoalCorrect2 && multiActCorrect2;
        results[idx].status = pass2 ? 'FAIL_FLAKY' : 'FAIL_STABLE';
        if (pass2) {
          console.log('[verify_retrieval_real_dev]', `#${devToRun[idx].index + 1} re-run PASS → FAIL_FLAKY`);
        } else {
          console.log('[verify_retrieval_real_dev]', `#${devToRun[idx].index + 1} re-run FAIL → FAIL_STABLE`);
        }
      }
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === undefined) results[i].status = results[i].pass ? 'PASS' : 'FAIL_STABLE';
      }
    } else {
      for (let i = 0; i < results.length; i++) {
        results[i].status = results[i].pass ? 'PASS' : 'FAIL_STABLE';
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

  const total = devToRun.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failStableCount = results.filter((r) => r.status === 'FAIL_STABLE').length;
  const failFlakyCount = results.filter((r) => r.status === 'FAIL_FLAKY').length;
  const softFailCount = results.filter((r) => r.softFail).length;
  const hardPass = passCount;
  const hardFailCount = failStableCount;
  const allPass = healthOk && total > 0 && passCount === total;
  const actFamilyHitPct = total > 0 ? Math.round((results.filter((r) => r.actFamilyHit).length / total) * 100) : 0;
  const multiGoalPct = total > 0 ? Math.round((results.filter((r) => r.multiGoalCorrect).length / total) * 100) : 0;
  const multiActPct = total > 0 ? Math.round((results.filter((r) => r.multiActCorrect).length / total) * 100) : 0;
  const latenciesAll = results.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50 = latenciesAll.length ? latenciesAll[Math.floor(latenciesAll.length * 0.5)] ?? 0 : 0;
  const p95 = latenciesAll.length ? latenciesAll[Math.min(Math.ceil(latenciesAll.length * 0.95) - 1, latenciesAll.length - 1)] ?? 0 : 0;
  const latenciesPass = results.filter((r) => r.status === 'PASS').map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const latenciesFailStable = results.filter((r) => r.status === 'FAIL_STABLE').map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50Pass = latenciesPass.length ? latenciesPass[Math.floor(latenciesPass.length * 0.5)] ?? 0 : 0;
  const p95Pass = latenciesPass.length ? latenciesPass[Math.min(Math.ceil(latenciesPass.length * 0.95) - 1, latenciesPass.length - 1)] ?? 0 : 0;
  const p50FailStable = latenciesFailStable.length ? latenciesFailStable[Math.floor(latenciesFailStable.length * 0.5)] ?? 0 : 0;
  const p95FailStable = latenciesFailStable.length ? latenciesFailStable[Math.min(Math.ceil(latenciesFailStable.length * 0.95) - 1, latenciesFailStable.length - 1)] ?? 0 : 0;
  const qdrantCalls = results.map((r) => r.qdrantCalls ?? 0).filter((n) => n > 0);
  const medianQdrant = qdrantCalls.length ? qdrantCalls.slice().sort((a, b) => a - b)[Math.floor(qdrantCalls.length / 2)] ?? 0 : 0;
  const maxQdrant = qdrantCalls.length ? Math.max(...qdrantCalls) : 0;
  const hitsCapPct = total > 0 ? Math.round((results.filter((r) => r.hitsCapApplied).length / total) * 100) : 0;
  const plannerTiers = results.map((r) => r.plannerTier ?? 0);
  const tier0 = plannerTiers.filter((t) => t === 0).length;
  const tier1 = plannerTiers.filter((t) => t === 1).length;
  const tier2 = plannerTiers.filter((t) => t === 2).length;
  const llmPlannerPct = total > 0 ? Math.round((results.filter((r) => r.llmPlannerUsed).length / total) * 100) : 0;
  const actPlannerPct = total > 0 ? Math.round((results.filter((r) => r.actPlannerUsed).length / total) * 100) : 0;
  const lowConfPct = total > 0 ? Math.round((results.filter((r) => r.lowConf).length / total) * 100) : 0;
  const actListSizes = results.map((r) => r.actListSize ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const actListSizeMedian = actListSizes.length ? actListSizes[Math.floor(actListSizes.length / 2)] ?? 0 : 0;
  const actListSizeP95 = actListSizes.length ? actListSizes[Math.min(Math.ceil(actListSizes.length * 0.95) - 1, actListSizes.length - 1)] ?? 0 : 0;

  const failReasonsAll = results.flatMap((r) => r.failReasons ?? []);
  const failReasonsStable = results.filter((r) => r.status === 'FAIL_STABLE').flatMap((r) => r.failReasons ?? []);
  const actFamilyMissCount = failReasonsAll.filter((x) => x === 'act_family_miss').length;
  const multiGoalMissCount = failReasonsAll.filter((x) => x === 'multi_goal_miss').length;
  const multiActMissCount = failReasonsAll.filter((x) => x === 'multi_act_miss').length;
  const actFamilyMissStable = failReasonsStable.filter((x) => x === 'act_family_miss').length;
  const multiGoalMissStable = failReasonsStable.filter((x) => x === 'multi_goal_miss').length;
  const multiActMissStable = failReasonsStable.filter((x) => x === 'multi_act_miss').length;
  const flakyDenom = failStableCount + failFlakyCount;
  const flakyPct = flakyDenom > 0 ? Math.round((failFlakyCount / flakyDenom) * 100) : 0;
  const articleApplicable = results.filter((r) => r.articleExpectationApplied).length;
  const articleStrictPassCount = results.filter((r) => r.articleExpectationApplied && r.articleStrictPass).length;
  const articleStrictFailCount = results.filter((r) => r.articleExpectationApplied && r.articleStrictPass === false).length;
  const articleTraceSkippedCount = results.filter((r) => r.articleTraceReady === false).length;
  const articleReasonCounts: Record<string, number> = {};
  for (const result of results) {
    for (const reason of result.articleStrictReasons ?? []) {
      const key = reason.startsWith('article_miss:')
        ? 'article_miss'
        : reason.startsWith('rank_miss:')
          ? 'rank_miss'
          : reason;
      articleReasonCounts[key] = (articleReasonCounts[key] ?? 0) + 1;
    }
  }

  console.log('\n--- DEV Summary ---');
  console.log('Health:', healthOk ? 'PASS' : 'FAIL');
  console.log('retrieval_only_mode:', RETRIEVAL_ONLY_MODE ? 'ON' : 'OFF');
  console.log('Cases:', `${passCount}/${total}`, allPass ? 'PASS' : 'FAIL');
  console.log('status: PASS=', passCount, 'FAIL_STABLE=', failStableCount, 'FAIL_FLAKY=', failFlakyCount, 'soft_fail=', softFailCount);
  console.log('hard_pass:', hardPass, 'hard_fail (stable only):', hardFailCount);
  if (flakyDenom > 0) console.log('% flaky (of fail re-runs):', flakyPct);
  console.log('% act_family_hit:', actFamilyHitPct);
  console.log('% multi_goal_correct:', multiGoalPct);
  console.log('% multi_act_correct:', multiActPct);
  console.log('% low_confidence:', lowConfPct);
  console.log('act_list_size median:', actListSizeMedian, 'p95:', actListSizeP95);
  console.log('p50 latency ms (all):', Math.round(p50), '| PASS p50:', Math.round(p50Pass), 'p95:', Math.round(p95Pass), '| FAIL_STABLE p50:', Math.round(p50FailStable), 'p95:', Math.round(p95FailStable));
  console.log('p95 latency ms (all):', Math.round(p95));
  console.log('qdrant_calls median:', medianQdrant, 'max:', maxQdrant);
  console.log('planner tier: 0=', tier0, '1=', tier1, '2=', tier2);
  console.log('% llm_planner_used:', llmPlannerPct);
  console.log('% act_planner_used:', actPlannerPct);
  console.log('% hits_cap_applied:', hitsCapPct);
  const routingCalledCount = results.filter((r) => r.routingHintsCalled).length;
  const routingUsedCount = results.filter((r) => r.routingHintsUsed).length;
  const routingCalledPct = total > 0 ? Math.round((routingCalledCount / total) * 100) : 0;
  const routingUsedPct = total > 0 ? Math.round((routingUsedCount / total) * 100) : 0;
  console.log('% routing_hints_called:', routingCalledPct, `(${routingCalledCount}/${total})`);
  console.log('% routing_hints_used:', routingUsedPct, `(${routingUsedCount}/${total})`);
  const notUsedByReason: Record<string, number> = {};
  for (const r of results) {
    const codes = r.retrievalTrace?.meta?.routing_hints?.not_used_reason_codes ?? [];
    for (const c of codes) {
      notUsedByReason[c] = (notUsedByReason[c] ?? 0) + 1;
    }
  }
  const topNotUsedReasons = Object.entries(notUsedByReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Stage latency breakdown
  const plannerDurations = results.map((r) => r.plannerDurationMs ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const plannerP50 = plannerDurations.length ? plannerDurations[Math.floor(plannerDurations.length * 0.5)] ?? 0 : 0;
  const plannerP95 = plannerDurations.length ? plannerDurations[Math.min(Math.ceil(plannerDurations.length * 0.95) - 1, plannerDurations.length - 1)] ?? 0 : 0;
  const promptTokensAll = results.map((r) => r.promptTokens ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const ptMedian = promptTokensAll.length ? promptTokensAll[Math.floor(promptTokensAll.length / 2)] ?? 0 : 0;
  const ptP95 = promptTokensAll.length ? promptTokensAll[Math.min(Math.ceil(promptTokensAll.length * 0.95) - 1, promptTokensAll.length - 1)] ?? 0 : 0;
  const plannerPctOfLatency = total > 0 && p50 > 0 ? Math.round((plannerP50 / p50) * 100) : 0;
  console.log('--- Stage Latency Breakdown ---');
  console.log('planner_duration_ms p50:', Math.round(plannerP50), 'p95:', Math.round(plannerP95), `(${plannerPctOfLatency}% of p50 total latency)`);
  console.log('prompt_tokens median:', ptMedian, 'p95:', ptP95);
  const bottleneckCases = results
    .filter((r) => r.latencyMs > 20_000)
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, 3);
  if (bottleneckCases.length > 0) {
    console.log('Top slow cases (>20s):');
    for (const bc of bottleneckCases) {
      const plannerPct = bc.plannerDurationMs && bc.latencyMs ? Math.round((bc.plannerDurationMs / bc.latencyMs) * 100) : 0;
      console.log(`  run=${bc.run_id?.slice(0, 8)} latency=${Math.round(bc.latencyMs / 1000)}s planner=${Math.round((bc.plannerDurationMs ?? 0) / 1000)}s(${plannerPct}%) qdrant=${bc.qdrantCalls ?? 0} tokens=${bc.promptTokens ?? '?'} planner_used=${bc.llmPlannerUsed ? 'llm' : bc.actPlannerUsed ? 'act' : 'none'}`);
    }
  }
  if (topNotUsedReasons.length) {
    console.log('routing_hints top not_used_reason_codes:', topNotUsedReasons.map(([k, v]) => `${k}=${v}`).join(', '));
  }
  const routingPathCounts: Record<string, number> = {};
  for (const r of results) {
    const path = r.retrievalTrace?.meta?.routing_hints?.routing_path ?? 'NONE';
    routingPathCounts[path] = (routingPathCounts[path] ?? 0) + 1;
  }
  if (Object.keys(routingPathCounts).length) {
    console.log('routing_path distribution:', Object.entries(routingPathCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  console.log('--- Top failure reasons (all) ---');
  console.log('act_family_miss:', actFamilyMissCount);
  console.log('multi_goal_miss:', multiGoalMissCount);
  console.log('multi_act_miss:', multiActMissCount);
  console.log('--- Top failure reasons (FAIL_STABLE only) ---');
  console.log('act_family_miss:', actFamilyMissStable);
  console.log('multi_goal_miss:', multiGoalMissStable);
  console.log('multi_act_miss:', multiActMissStable);
  if (ARTICLE_RANK_MODE) {
    console.log('--- Article strict overlay ---');
    console.log('cases_with_article_expectations:', articleApplicable);
    console.log('article_strict_pass:', articleStrictPassCount);
    console.log('article_strict_fail:', articleStrictFailCount);
    console.log('article_trace_skipped:', articleTraceSkippedCount);
    if (Object.keys(articleReasonCounts).length > 0) {
      console.log(
        'article_failure_reasons:',
        Object.entries(articleReasonCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `${reason}=${count}`)
          .join(', ')
      );
    }
  }

  const isLimitedRun = Array.isArray(onlyIndices) && onlyIndices.length > 0;
  const isSmokeRun = process.argv.some((a) => a.startsWith('--only=SMOKE'));
  const { minHardPass, maxHardFail } = getRetrievalGateThresholds(total, isSmokeRun, isLimitedRun);
  const gatePass = hardPass >= minHardPass && hardFailCount <= maxHardFail;
  console.log('--- Quality gate ---');
  if (isSmokeRun) console.log('(smoke run: 0 stable fails required; gate = 7/7 PASS)');
  else if (isLimitedRun) console.log('(limited run: proportional gate 60% pass / 30% max fail)');
  console.log('thresholds: MIN_HARD_PASS=', minHardPass, 'MAX_HARD_FAIL=', maxHardFail);
  console.log('gate:', gatePass ? 'PASS' : 'FAIL', `(hard_pass=${hardPass} >= ${minHardPass} && hard_fail_stable=${hardFailCount} <= ${maxHardFail})`);

  if (isLimitedRun) {
    const reportsDir = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_reports');
    try {
      mkdirSync(reportsDir, { recursive: true });
      const onlyArg = process.argv.find((a) => a.startsWith('--only='));
      const fastResults = {
        run_at: new Date().toISOString(),
        only_mode: onlyArg?.slice('--only='.length) ?? 'custom',
        total,
        pass_count: passCount,
        fail_stable_count: failStableCount,
        fail_flaky_count: failFlakyCount,
        flaky_check_enabled: FLAKY_CHECK_ENABLED,
        cases: devToRun.map(({ index: i, row }, idx) => {
          const r = results[idx];
          const rt = r?.retrievalTrace;
          const meta = rt?.meta;
          return {
            index: i,
            query: row.query.slice(0, 120),
            status: r?.status ?? 'PASS',
            selected_acts: meta?.selected_acts?.map((a) => ({ rada_nreg: a.rada_nreg, act_title: a.act_title })) ?? [],
            reason_codes: meta?.reason_codes ?? meta?.selected_acts_decision?.reason_codes ?? [],
            routing_not_used_reason_codes: meta?.routing_hints?.not_used_reason_codes ?? [],
            routing_path: meta?.routing_hints?.routing_path,
            routing_called: meta?.routing_hints?.called,
            routing_used: (meta?.selected_acts_sources_breakdown?.from_routing_hints?.length ?? 0) > 0,
            dominant_family_key: meta?.family_evidence_summary?.dominant_family_key,
            article_expectation_applied: r?.articleExpectationApplied ?? false,
            article_trace_ready: r?.articleTraceReady ?? true,
            article_trace_source: r?.articleTraceSource,
            article_strict_pass: r?.articleStrictPass,
            article_primary_rank: r?.articlePrimaryRank,
            article_expected_hit_ranks: r?.articleExpectedHitRanks ?? {},
            article_fail_reasons: r?.articleStrictReasons ?? [],
          };
        }),
      };
      writeFileSync(resolve(reportsDir, 'retrieval_real_dev_fast_results.json'), JSON.stringify(fastResults, null, 2), 'utf8');
      console.log('[verify_retrieval_real_dev] wrote _reports/retrieval_real_dev_fast_results.json');
    } catch (e) {
      console.warn('[verify_retrieval_real_dev] could not write fast results:', e);
    }
  }

  const qualityGatePass = allPass || gatePass;
  const exitCode =
    !SKIP_U10_POSTCHECK && u10PostCheckFail > 0
      ? 1
      : qualityGatePass
        ? 0
        : 1;
  if (!SKIP_U10_POSTCHECK && u10PostCheckFail > 0) {
    console.error('[verify_retrieval_real_dev] exit 1: U10 post-check failed on', u10PostCheckFail, 'runs');
  }
  process.exit(exitCode);
}

const isEntry = typeof process !== 'undefined' && process.argv[1] != null && /verify_retrieval_real_dev\.(ts|js)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
