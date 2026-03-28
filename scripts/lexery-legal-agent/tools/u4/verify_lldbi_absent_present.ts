#!/usr/bin/env node
import { createServer } from 'net';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { normalizeStructuredActIdentifier } from '../../lib/structured-act-identifier.js';
import { createSupabaseAdminClient } from '../../../legislation/Lexery Legislation DB Infra/src/lib/supabaseAdmin.js';
import {
  createQdrantClient,
  countByNreg,
  QDRANT_COLLECTION_ACTS,
  QDRANT_COLLECTION_CHUNKS,
} from '../../../legislation/Lexery Legislation DB Infra/src/lib/qdrantAdmin.js';
import { getR2AdminClient, headObject } from '../../../legislation/Lexery Legislation DB Infra/src/lib/r2Admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;
const INSPECT_PRESENCE_RETRIES = 3;
const INSPECT_PRESENCE_RETRY_DELAY_MS = 1_000;
const DEFAULT_CASES_PATH = resolve(
  process.cwd(),
  'scripts/lexery-legal-agent/tools/_datasets/lldbi_absent_present_seed_cases.json'
);

interface QueryExpectation {
  query_id: string;
  style: string;
  text: string;
  expected_pre_low_confidence?: boolean;
  expected_pre_coverage_gap?: string[];
}

interface CaseSpec {
  case_id: string;
  rada_nreg: string;
  title: string;
  bucket?: string;
  acceptable_post_selected_acts?: string[];
  queries: QueryExpectation[];
}

interface RetrievalTraceLike {
  hits?: Array<{
    rada_nreg?: string;
    title?: string;
    act_title?: string;
    article_number?: string | null;
    citation_path?: string | null;
    unit_type?: string | null;
    ordering_score?: number;
    score?: number;
  }>;
  meta?: {
    hits_count?: number;
    low_confidence?: boolean;
    coverage_gap?: string;
    reason_codes?: string[];
    qdrant_calls_count_total?: number;
    selected_acts?: Array<{
      rada_nreg?: string;
      act_title?: string;
      act_kind?: string;
      score?: number;
    }>;
  };
}

interface RetrievalSummary {
  latency_ms: number;
  hits_count: number;
  low_confidence: boolean;
  coverage_gap: string;
  reason_codes: string[];
  qdrant_calls: number | null;
  selected_acts: string[];
  top_hits: Array<{
    rada_nreg: string;
    citation: string | null;
    unit_type: string | null;
  }>;
}

interface PresenceSummary {
  supabase_document_found: boolean;
  qdrant_acts: number;
  qdrant_chunks: number;
  retrieval_surface_present: boolean;
  title: string | null;
  r2_key: string | null;
  r2_exists: boolean | null;
  validity_status: string | null;
  nreg_variants_checked: string[];
}

interface CliStepResult {
  ok: boolean;
  exit_code: number | null;
  duration_ms: number;
  output_tail: string;
}

interface QueryPhaseResult {
  query_id: string;
  style: string;
  text: string;
  retrieval: RetrievalSummary | null;
  pass: boolean;
  failures: string[];
  skipped?: boolean;
  skip_reason?: string;
}

function isInfraOnlyFailure(result: QueryPhaseResult): boolean {
  return result.pass === false && result.failures.length > 0 && result.failures.every((failure) => failure === 'no_retrieval_trace');
}

function caseHasInfraOnlyFailure(results: QueryPhaseResult[]): boolean {
  const failed = results.filter((result) => result.pass === false);
  return failed.length > 0 && failed.every((result) => isInfraOnlyFailure(result));
}

function getArgValue(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.findIndex((arg) => arg === name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return null;
}

function getCsvArgValues(name: string): string[] {
  const value = getArgValue(name);
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
  retries = INSPECT_PRESENCE_RETRIES,
  delayMs = INSPECT_PRESENCE_RETRY_DELAY_MS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      console.warn(
        `[verify_lldbi_absent_present] retry ${attempt + 1}/${retries} for ${label}: ${toErrorMessage(error)}`
      );
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function normalizeNregForComparison(value: string | null | undefined): string {
  const normalized = normalizeStructuredActIdentifier(String(value ?? ''));
  return normalized || String(value ?? '').normalize('NFC').toLowerCase().trim();
}

function buildNregPresenceVariants(value: string | null | undefined): string[] {
  const raw = String(value ?? '').normalize('NFC').trim();
  const normalized = normalizeNregForComparison(value);
  const variants = new Set<string>();
  for (const candidate of [raw, normalized, raw.toLowerCase(), raw.toUpperCase(), normalized.toLowerCase(), normalized.toUpperCase()]) {
    const trimmed = candidate.trim();
    if (trimmed) variants.add(trimmed);
  }
  return [...variants];
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address?.port ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : rejectPort(new Error('no port'))));
    });
  });
}

async function waitHealth(baseUrl: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < HEALTH_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const json = (await response.json()) as { status?: string };
      if (response.ok && json.status === 'healthy') return true;
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

async function startServer(): Promise<{ baseUrl: string; child: ReturnType<typeof spawn> }> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const queueNamespace = `lexery:debug:absent-present:${randomUUID()}`;
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BRAIN_PORT: String(port),
        DEV_API_KEY: DEV_KEY,
        LEGAL_AGENT_DISABLE_LLM: 'true',
        USE_RULE_BASED_CLASSIFIER: 'true',
        DOCLIST_ENABLED: 'false',
        U9_META_TRIAGE_ENABLED: 'false',
        MEMORY_RECENT_ENABLED: 'false',
        U5_STOP_AFTER_GATE: 'true',
        REDIS_QUEUE_NAMESPACE: queueNamespace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  if (!(await waitHealth(baseUrl))) {
    child.kill('SIGTERM');
    throw new Error('retrieval server health timeout');
  }
  return { baseUrl, child };
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill('SIGTERM');
  await sleep(SHUTDOWN_WAIT_MS).catch(() => undefined);
}

async function runQuery(baseUrl: string, query: string): Promise<RetrievalSummary | null> {
  const started = Date.now();
  let runId = '';
  try {
    const postResponse = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query,
        tenant_id: '00000000-0000-0000-0000-000000000001',
        user_id: '00000000-0000-0000-0000-000000000002',
      }),
    });
    if (postResponse.status !== 202) return null;
    const postJson = (await postResponse.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return null;
  } catch {
    return null;
  }

  const pollStarted = Date.now();
  while (Date.now() - pollStarted < POLL_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (response.status === 200) {
        const body = (await response.json()) as { retrieval_trace?: RetrievalTraceLike | null };
        const trace = body.retrieval_trace;
        if (trace?.meta?.hits_count != null || trace?.meta?.low_confidence === true) {
          const hits = trace.hits ?? [];
          const meta = trace.meta ?? {};
          return {
            latency_ms: Date.now() - started,
            hits_count: meta.hits_count ?? hits.length,
            low_confidence: meta.low_confidence === true,
            coverage_gap: meta.coverage_gap ?? 'none',
            reason_codes: meta.reason_codes ?? [],
            qdrant_calls: typeof meta.qdrant_calls_count_total === 'number' ? meta.qdrant_calls_count_total : null,
            selected_acts: (meta.selected_acts ?? []).map((act) => act.rada_nreg ?? '').filter(Boolean),
            top_hits: hits.slice(0, 5).map((hit) => ({
              rada_nreg: hit.rada_nreg ?? '',
              citation: hit.citation_path ?? hit.article_number ?? null,
              unit_type: hit.unit_type ?? null,
            })),
          };
        }
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }

  return null;
}

async function runQueryWithRetry(baseUrl: string, query: string, retryNullTraceCount: number): Promise<RetrievalSummary | null> {
  let attempt = 0;
  let result: RetrievalSummary | null = null;
  while (attempt <= retryNullTraceCount) {
    result = await runQuery(baseUrl, query);
    if (result) return result;
    attempt += 1;
    if (attempt <= retryNullTraceCount) {
      await sleep(POLL_MS);
    }
  }
  return result;
}

async function inspectPresence(radaNreg: string): Promise<PresenceSummary> {
  return await withRetries(`inspectPresence:${radaNreg}`, async () => {
    const normalizedRadaNreg = normalizeNregForComparison(radaNreg);
    const variants = buildNregPresenceVariants(radaNreg);
    const supabase = createSupabaseAdminClient();
    const qdrant = createQdrantClient();
    const { data: docs, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,title,r2_key,validity_status')
      .in('rada_nreg', variants);
    if (error) throw error;
    const doc =
      (docs ?? []).find((entry) => normalizeNregForComparison(entry.rada_nreg) === normalizedRadaNreg) ??
      (docs ?? [])[0] ??
      null;

    const [qdrantActsByVariant, qdrantChunksByVariant] = await Promise.all([
      Promise.all(variants.map((variant) => countByNreg(qdrant, QDRANT_COLLECTION_ACTS, variant))),
      Promise.all(variants.map((variant) => countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, variant))),
    ]);
    const qdrantActs = qdrantActsByVariant.reduce((sum, value) => sum + value, 0);
    const qdrantChunks = qdrantChunksByVariant.reduce((sum, value) => sum + value, 0);

    let r2Exists: boolean | null = null;
    if (doc?.r2_key) {
      const { client, bucket } = getR2AdminClient();
      const head = await headObject(client, bucket, doc.r2_key);
      r2Exists = head.exists;
    }

    return {
      supabase_document_found: Boolean(doc),
      qdrant_acts: qdrantActs,
      qdrant_chunks: qdrantChunks,
      retrieval_surface_present: Boolean(doc) || qdrantActs > 0 || qdrantChunks > 0,
      title: doc?.title ?? null,
      r2_key: doc?.r2_key ?? null,
      r2_exists: r2Exists,
      validity_status: doc?.validity_status ?? null,
      nreg_variants_checked: variants,
    };
  });
}

function buildSkippedPhaseResult(expectation: QueryExpectation, reason: string): QueryPhaseResult {
  return {
    query_id: expectation.query_id,
    style: expectation.style,
    text: expectation.text,
    retrieval: null,
    pass: true,
    failures: [],
    skipped: true,
    skip_reason: reason,
  };
}

async function runCliStep(args: string[]): Promise<CliStepResult> {
  const started = Date.now();
  return await new Promise((resolvePromise) => {
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsx', 'scripts/legislation/admin-cli.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.length > 16000) {
        output = output.slice(output.length - 16000);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('close', (code) => {
      resolvePromise({
        ok: code === 0,
        exit_code: code,
        duration_ms: Date.now() - started,
        output_tail: output.trim().slice(-4000),
      });
    });
  });
}

function evaluatePre(expectation: QueryExpectation, retrieval: RetrievalSummary | null): QueryPhaseResult {
  const failures: string[] = [];
  if (!retrieval) {
    failures.push('no_retrieval_trace');
  } else {
    if (expectation.expected_pre_low_confidence === true && retrieval.low_confidence !== true) {
      failures.push('expected_pre_low_confidence=true');
    }
    const allowedCoverageGaps = expectation.expected_pre_coverage_gap ?? ['likely_missing_act'];
    if (!allowedCoverageGaps.includes(retrieval.coverage_gap)) {
      failures.push(`coverage_gap=${retrieval.coverage_gap} not in [${allowedCoverageGaps.join(', ')}]`);
    }
  }
  return {
    query_id: expectation.query_id,
    style: expectation.style,
    text: expectation.text,
    retrieval,
    pass: failures.length === 0,
    failures,
  };
}

function evaluatePost(caseSpec: CaseSpec, expectation: QueryExpectation, retrieval: RetrievalSummary | null): QueryPhaseResult {
  const expectedSelectedActs = [caseSpec.rada_nreg, ...(caseSpec.acceptable_post_selected_acts ?? [])];
  const normalizedExpectedSelectedActs = expectedSelectedActs.map((value) => normalizeNregForComparison(value));
  const failures: string[] = [];
  if (!retrieval) {
    failures.push('no_retrieval_trace');
  } else {
    if (retrieval.low_confidence) failures.push('expected_post_low_confidence=false');
    if (retrieval.coverage_gap !== 'none') failures.push(`expected_post_coverage_gap=none got ${retrieval.coverage_gap}`);
    const normalizedSelectedActs = retrieval.selected_acts.map((value) => normalizeNregForComparison(value));
    if (!normalizedExpectedSelectedActs.some((value) => normalizedSelectedActs.includes(value))) {
      failures.push(`selected_acts_missing_any_of_${expectedSelectedActs.join('|')}`);
    }
  }
  return {
    query_id: expectation.query_id,
    style: expectation.style,
    text: expectation.text,
    retrieval,
    pass: failures.length === 0,
    failures,
  };
}

function summarizeCase(caseSpec: CaseSpec, pre: QueryPhaseResult[], post: QueryPhaseResult[]) {
  const preEligible = pre.some((result) => result.skipped !== true);
  return {
    pre_all_pass: preEligible ? pre.every((result) => result.skipped === true || result.pass) : null,
    pre_skipped: !preEligible,
    post_all_pass: post.every((result) => result.pass),
    case_id: caseSpec.case_id,
    rada_nreg: caseSpec.rada_nreg,
  };
}

function loadCases(pathValue: string): CaseSpec[] {
  return JSON.parse(readFileSync(pathValue, 'utf8')) as CaseSpec[];
}

async function main(): Promise<void> {
  const casesPath = resolve(process.cwd(), getArgValue('--cases') ?? DEFAULT_CASES_PATH);
  const caseIdsFilter = new Set(getCsvArgValues('--case-ids'));
  const nregsFilter = new Set(getCsvArgValues('--nregs'));
  const limit = Number(getArgValue('--limit') ?? '0') || undefined;
  const retryNullTraceCount = Math.max(0, Number(getArgValue('--retry-null-trace') ?? '1') || 0);
  const skipImport = hasFlag('--skip-import');
  const reportPath =
    getArgValue('--report-path') ??
    resolve(
      process.cwd(),
      'runs/audit',
      `LLDBI_ABSENT_PRESENT_${sanitizeFilename(new Date().toISOString())}.json`
    );

  let cases = loadCases(casesPath);
  if (caseIdsFilter.size > 0) {
    cases = cases.filter((caseSpec) => caseIdsFilter.has(caseSpec.case_id));
  }
  if (nregsFilter.size > 0) {
    cases = cases.filter((caseSpec) => nregsFilter.has(caseSpec.rada_nreg));
  }
  cases = cases.slice(0, limit ?? Number.MAX_SAFE_INTEGER);
  mkdirSync(dirname(reportPath), { recursive: true });

  const beforePresence: Record<string, PresenceSummary> = {};
  for (const caseSpec of cases) {
    beforePresence[caseSpec.case_id] = await inspectPresence(caseSpec.rada_nreg);
  }

  const prePhaseResults: Record<string, QueryPhaseResult[]> = {};
  const preServer = await startServer();
  try {
    for (const caseSpec of cases) {
      const queryResults: QueryPhaseResult[] = [];
      const before = beforePresence[caseSpec.case_id];
      for (const query of caseSpec.queries) {
        if (before.retrieval_surface_present) {
          queryResults.push(buildSkippedPhaseResult(query, 'already_present_before_run'));
          continue;
        }
        const retrieval = await runQueryWithRetry(preServer.baseUrl, query.text, retryNullTraceCount);
        queryResults.push(evaluatePre(query, retrieval));
      }
      prePhaseResults[caseSpec.case_id] = queryResults;
    }
  } finally {
    await stopServer(preServer.child);
  }

  const cliSteps: Record<string, Record<string, CliStepResult | null>> = {};
  const afterPresence: Record<string, PresenceSummary> = {};
  for (const caseSpec of cases) {
    cliSteps[caseSpec.case_id] = { add: null, verify: null, audit_qdrant_payload: null };
    if (!skipImport && !beforePresence[caseSpec.case_id].retrieval_surface_present) {
      cliSteps[caseSpec.case_id].add = await runCliStep(['add', '--nreg', caseSpec.rada_nreg]);
      cliSteps[caseSpec.case_id].verify = await runCliStep(['verify', '--nreg', caseSpec.rada_nreg, '--write-health']);
      cliSteps[caseSpec.case_id].audit_qdrant_payload = await runCliStep([
        'audit-qdrant-payload',
        '--nregs',
        caseSpec.rada_nreg,
        '--output',
        resolve(process.cwd(), 'runs/audit', `QDRANT_PAYLOAD_${sanitizeFilename(caseSpec.rada_nreg)}.json`),
        '--output-markdown',
        resolve(process.cwd(), 'runs/audit', `QDRANT_PAYLOAD_${sanitizeFilename(caseSpec.rada_nreg)}.md`),
      ]);
    }
    afterPresence[caseSpec.case_id] = await inspectPresence(caseSpec.rada_nreg);
  }

  const postPhaseResults: Record<string, QueryPhaseResult[]> = {};
  const postServer = await startServer();
  try {
    for (const caseSpec of cases) {
      const queryResults: QueryPhaseResult[] = [];
      for (const query of caseSpec.queries) {
        const retrieval = await runQueryWithRetry(postServer.baseUrl, query.text, retryNullTraceCount);
        queryResults.push(evaluatePost(caseSpec, query, retrieval));
      }
      postPhaseResults[caseSpec.case_id] = queryResults;
    }
  } finally {
    await stopServer(postServer.child);
  }

  const report = {
    generated_at: new Date().toISOString(),
    cases_path: casesPath,
    case_ids_filter: caseIdsFilter.size > 0 ? Array.from(caseIdsFilter) : null,
    nregs_filter: nregsFilter.size > 0 ? Array.from(nregsFilter) : null,
    retry_null_trace_count: retryNullTraceCount,
    skip_import: skipImport,
    totals: {
      cases: cases.length,
      pre_eligible_cases: cases.filter((caseSpec) =>
        prePhaseResults[caseSpec.case_id].some((result) => result.skipped !== true)
      ).length,
      pre_pass: cases.filter((caseSpec) => {
        const results = prePhaseResults[caseSpec.case_id];
        return results.some((result) => result.skipped !== true) && results.every((result) => result.skipped === true || result.pass);
      }).length,
      pre_skipped_cases: cases.filter((caseSpec) =>
        prePhaseResults[caseSpec.case_id].every((result) => result.skipped === true)
      ).length,
      pre_infra_only_cases: cases.filter((caseSpec) =>
        caseHasInfraOnlyFailure(prePhaseResults[caseSpec.case_id])
      ).length,
      post_pass: cases.filter((caseSpec) => postPhaseResults[caseSpec.case_id].every((result) => result.pass)).length,
      post_infra_only_cases: cases.filter((caseSpec) =>
        caseHasInfraOnlyFailure(postPhaseResults[caseSpec.case_id])
      ).length,
      stale_pre_dataset: cases.every((caseSpec) =>
        prePhaseResults[caseSpec.case_id].every((result) => result.skipped === true)
      ),
    },
    cases: cases.map((caseSpec) => ({
      case_id: caseSpec.case_id,
      rada_nreg: caseSpec.rada_nreg,
      title: caseSpec.title,
      bucket: caseSpec.bucket ?? null,
      before_presence: beforePresence[caseSpec.case_id],
      pre_phase: prePhaseResults[caseSpec.case_id],
      cli_steps: cliSteps[caseSpec.case_id],
      after_presence: afterPresence[caseSpec.case_id],
      post_phase: postPhaseResults[caseSpec.case_id],
      summary: summarizeCase(caseSpec, prePhaseResults[caseSpec.case_id], postPhaseResults[caseSpec.case_id]),
    })),
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n=== LLDBI absent→present report ===');
  console.log(`report_path: ${reportPath}`);
  console.log(`cases: ${report.totals.cases}`);
  console.log(`pre_pass: ${report.totals.pre_pass}/${report.totals.pre_eligible_cases}`);
  console.log(`pre_skipped: ${report.totals.pre_skipped_cases}`);
  console.log(`pre_infra_only: ${report.totals.pre_infra_only_cases}`);
  console.log(`post_pass: ${report.totals.post_pass}/${report.totals.cases}`);
  console.log(`post_infra_only: ${report.totals.post_infra_only_cases}`);
  if (report.totals.stale_pre_dataset) {
    console.log('warning: stale_pre_dataset=true (all cases were already present before the run)');
  }
  for (const caseEntry of report.cases) {
    console.log(
      `- ${caseEntry.rada_nreg} | pre=${
        caseEntry.summary.pre_skipped
          ? 'SKIP_PRESENT'
          : caseEntry.summary.pre_all_pass
            ? 'PASS'
            : 'FAIL'
      } | post=${caseEntry.summary.post_all_pass ? 'PASS' : 'FAIL'} | before=${caseEntry.before_presence.retrieval_surface_present ? 'present' : 'absent'} | after=${caseEntry.after_presence.retrieval_surface_present ? 'present' : 'absent'}`
    );
  }
}

main().catch((error) => {
  console.error('[verify_lldbi_absent_present] fatal:', error);
  process.exit(1);
});
