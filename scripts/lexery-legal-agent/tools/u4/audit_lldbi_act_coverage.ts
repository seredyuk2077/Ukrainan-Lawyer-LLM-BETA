#!/usr/bin/env node
/**
 * Broad LLDBI act-coverage audit.
 *
 * Purpose:
 * - probe many indexed LLDBI acts beyond curated golden cases
 * - verify that U4 can still recover the target act on generic act-centric probes
 * - surface category/doc-type slices where retrieval quality or honesty degrades
 *
 * Default policy is intentionally cheap and generic:
 * - use one "best" probe per act (preferred alias, otherwise compact title fragment)
 * - assert the target act is present either in selected_acts or within top-N hits
 * - record low_confidence / coverage_gap / latency / qdrant_calls for every run
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';
import { RunRepository } from '../../gateway/storage.js';
import { looksLikeStructuredActIdentifier } from '../../lib/structured-act-identifier.js';
import { getRetrievalTraceHitsForForensics } from '../../retrieval/retrieval-trace-r2.js';
import { tolerantNormalizeToStrings } from '../../retrieval/tolerant-normalizer.js';
import { isAmendmentLikeActTitle } from '../../retrieval/act-taxonomy-store.js';
import { createSupabaseAdminClient } from '../../../legislation/Lexery Legislation DB Infra/src/lib/supabaseAdmin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 5_000;
const runRepo = new RunRepository();

type RetrievalHitLike = {
  rada_nreg?: string;
};

type RetrievalTraceLike = {
  hits?: RetrievalHitLike[];
  meta?: {
    hits_count?: number;
    low_confidence?: boolean;
    coverage_gap?: string;
    qdrant_calls_count_total?: number;
    selected_acts?: Array<{ rada_nreg?: string }>;
  };
};

type DocRow = {
  rada_nreg: string;
  title: string;
  aliases: unknown;
  category: string | null;
  storage_category: string | null;
  document_type: string | null;
  document_type_slug: string | null;
  validity_status: string | null;
};

type ProbeRow = {
  rada_nreg: string;
  title: string;
  category: string | null;
  document_type: string | null;
  validity_status: string | null;
  probe_kind: 'alias' | 'title_fragment' | 'nreg' | 'anchored_title' | 'cued_number';
  query: string;
};

type AuditResult = {
  rada_nreg: string;
  title: string;
  category: string | null;
  document_type: string | null;
  validity_status: string | null;
  probe_kind: ProbeRow['probe_kind'];
  query: string;
  run_id: string;
  pass: boolean;
  selected_act_hit: boolean;
  top_hit_rank: number | null;
  latency_ms: number;
  qdrant_calls: number | null;
  low_confidence: boolean;
  coverage_gap: string;
  failure_mode: 'retrieval_miss' | 'selection_drift' | 'honesty_fail' | 'trace_anomaly' | null;
};

type ProbeMode = 'best' | 'generalized';

type ActSummary = {
  rada_nreg: string;
  title: string;
  category: string | null;
  document_type: string | null;
  validity_status: string | null;
  total_probes: number;
  pass_probes: number;
  pass_any: boolean;
  grounded_probes_total: number;
  grounded_probes_pass: number;
  grounded_probe_pass_any: boolean;
  alias_probes_total: number;
  alias_probes_pass: number;
  low_confidence_probes: number;
  coverage_gaps_seen: string[];
};

type AuditReport = {
  generated_at: string;
  completed_at?: string;
  status: 'in_progress' | 'complete';
  total: number;
  docs_total: number;
  pass: number;
  fail: number;
  max_rank: number;
  offset: number;
  limit: number;
  only_nregs?: string[];
  probe_mode: ProbeMode;
  processed_probes: number;
  remaining_probes: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  qdrant_calls_median: number;
  probe_summary: Array<{ probe_kind: ProbeRow['probe_kind']; total: number; pass: number }>;
  category_summary: Array<{ category: string; total: number; pass: number }>;
  failure_mode_summary: Array<{ failure_mode: NonNullable<AuditResult['failure_mode']>; total: number }>;
  act_summary: ActSummary[];
  failures: AuditResult[];
  results: AuditResult[];
};

const GROUNDED_PROBE_KINDS = new Set<ProbeRow['probe_kind']>([
  'nreg',
  'anchored_title',
  'title_fragment',
  'cued_number',
]);

function normalizeActReferenceCue(value: string | null | undefined): string | null {
  const firstToken = String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .find(Boolean);
  if (!firstToken) return null;
  if (firstToken.startsWith('указ')) return 'указ';
  if (firstToken.startsWith('постан')) return 'постанова';
  if (firstToken.startsWith('наказ')) return 'наказ';
  if (firstToken.startsWith('розпоряджен')) return 'розпорядження';
  if (firstToken.startsWith('рішен')) return 'рішення';
  if (firstToken.startsWith('закон')) return 'закон';
  if (firstToken.startsWith('кодекс')) return 'кодекс';
  if (firstToken.startsWith('правил')) return 'правила';
  if (firstToken.startsWith('поряд')) return 'порядок';
  if (firstToken.startsWith('інструкц')) return 'інструкція';
  if (firstToken.startsWith('положен')) return 'положення';
  if (firstToken.startsWith('регламент')) return 'регламент';
  if (firstToken.startsWith('конвенц')) return 'конвенція';
  if (firstToken.startsWith('договор') || firstToken.startsWith('договір')) return 'договір';
  if (firstToken.startsWith('статут')) return 'статут';
  return null;
}

function extractLeadingNumericStem(value: string | null | undefined): string | null {
  const normalized = String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .trim();
  const match = normalized.match(/(\d{1,8})/u);
  const digits = match?.[1]?.replace(/^0+/u, '');
  return digits || null;
}

function createActSummary(result: AuditResult): ActSummary {
  const groundedProbe = GROUNDED_PROBE_KINDS.has(result.probe_kind);
  return {
    rada_nreg: result.rada_nreg,
    title: result.title,
    category: result.category,
    document_type: result.document_type,
    validity_status: result.validity_status,
    total_probes: 1,
    pass_probes: result.pass ? 1 : 0,
    pass_any: result.pass,
    grounded_probes_total: groundedProbe ? 1 : 0,
    grounded_probes_pass: groundedProbe && result.pass ? 1 : 0,
    grounded_probe_pass_any: groundedProbe && result.pass,
    alias_probes_total: result.probe_kind === 'alias' ? 1 : 0,
    alias_probes_pass: result.probe_kind === 'alias' && result.pass ? 1 : 0,
    low_confidence_probes: result.low_confidence ? 1 : 0,
    coverage_gaps_seen: result.coverage_gap ? [result.coverage_gap] : [],
  };
}

function mergeActSummary(summary: ActSummary, result: AuditResult): ActSummary {
  const groundedProbe = GROUNDED_PROBE_KINDS.has(result.probe_kind);
  const coverageGaps = new Set(summary.coverage_gaps_seen);
  if (result.coverage_gap) coverageGaps.add(result.coverage_gap);
  return {
    ...summary,
    total_probes: summary.total_probes + 1,
    pass_probes: summary.pass_probes + (result.pass ? 1 : 0),
    pass_any: summary.pass_any || result.pass,
    grounded_probes_total: summary.grounded_probes_total + (groundedProbe ? 1 : 0),
    grounded_probes_pass: summary.grounded_probes_pass + (groundedProbe && result.pass ? 1 : 0),
    grounded_probe_pass_any: summary.grounded_probe_pass_any || (groundedProbe && result.pass),
    alias_probes_total: summary.alias_probes_total + (result.probe_kind === 'alias' ? 1 : 0),
    alias_probes_pass: summary.alias_probes_pass + (result.probe_kind === 'alias' && result.pass ? 1 : 0),
    low_confidence_probes: summary.low_confidence_probes + (result.low_confidence ? 1 : 0),
    coverage_gaps_seen: [...coverageGaps].sort(),
  };
}

function buildActSummary(results: AuditResult[]): ActSummary[] {
  const byAct = new Map<string, ActSummary>();
  for (const result of results) {
    const current = byAct.get(result.rada_nreg);
    byAct.set(
      result.rada_nreg,
      current ? mergeActSummary(current, result) : createActSummary(result)
    );
  }
  return [...byAct.values()].sort((left, right) => left.rada_nreg.localeCompare(right.rada_nreg));
}

function buildProbeKey(probe: Pick<ProbeRow, 'rada_nreg' | 'probe_kind' | 'query'>): string {
  return `${probe.rada_nreg}::${probe.probe_kind}::${probe.query.normalize('NFC').trim()}`;
}

function createAuditReport(input: {
  docs: DocRow[];
  results: AuditResult[];
  maxRank: number;
  offset: number;
  limit: number;
  onlyNregs?: string[];
  probeMode: ProbeMode;
  expectedTotal: number;
  status: 'in_progress' | 'complete';
}): AuditReport {
  const { docs, results, maxRank, offset, limit, onlyNregs, probeMode, expectedTotal, status } = input;
  const passCount = results.filter((result) => result.pass).length;
  const failCount = results.length - passCount;
  const latencies = [...results.map((result) => result.latency_ms)].sort((left, right) => left - right);
  const qdrantCalls = results
    .map((result) => result.qdrant_calls)
    .filter((value): value is number => typeof value === 'number')
    .sort((left, right) => left - right);
  const p50Latency = latencies.length ? latencies[Math.floor(latencies.length / 2)] ?? 0 : 0;
  const p95Latency = latencies.length
    ? latencies[Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1)] ?? 0
    : 0;
  const medianQdrant = qdrantCalls.length ? qdrantCalls[Math.floor(qdrantCalls.length / 2)] ?? 0 : 0;

  const byCategory = new Map<string, { total: number; pass: number }>();
  for (const result of results) {
    const key = result.category ?? 'unknown';
    const bucket = byCategory.get(key) ?? { total: 0, pass: 0 };
    bucket.total += 1;
    if (result.pass) bucket.pass += 1;
    byCategory.set(key, bucket);
  }

  return {
    generated_at: new Date().toISOString(),
    completed_at: status === 'complete' ? new Date().toISOString() : undefined,
    status,
    total: results.length,
    docs_total: docs.length,
    pass: passCount,
    fail: failCount,
    max_rank: maxRank,
    offset,
    limit,
    only_nregs: onlyNregs?.length ? [...onlyNregs] : undefined,
    probe_mode: probeMode,
    processed_probes: results.length,
    remaining_probes: Math.max(0, expectedTotal - results.length),
    latency_p50_ms: p50Latency,
    latency_p95_ms: p95Latency,
    qdrant_calls_median: medianQdrant,
    probe_summary: (['nreg', 'alias', 'anchored_title', 'title_fragment', 'cued_number'] as ProbeRow['probe_kind'][])
      .map((probeKind) => {
        const probeResults = results.filter((result) => result.probe_kind === probeKind);
        return {
          probe_kind: probeKind,
          total: probeResults.length,
          pass: probeResults.filter((result) => result.pass).length,
        };
      })
      .filter((bucket) => bucket.total > 0),
    category_summary: [...byCategory.entries()]
      .sort((left, right) => right[1].total - left[1].total)
      .map(([category, stats]) => ({ category, ...stats })),
    failure_mode_summary: (['retrieval_miss', 'selection_drift', 'honesty_fail', 'trace_anomaly'] as const)
      .map((failureMode) => ({
        failure_mode: failureMode,
        total: results.filter((result) => result.failure_mode === failureMode).length,
      }))
      .filter((bucket) => bucket.total > 0),
    act_summary: buildActSummary(results),
    failures: results.filter((result) => !result.pass),
    results,
  };
}

function writeAuditReport(reportPath: string, report: AuditReport): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  const tempPath = `${reportPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(tempPath, reportPath);
}

function getArgValue(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const idx = process.argv.findIndex((arg) => arg === name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

function classifyFailureMode(input: {
  pass: boolean;
  selectedActHit: boolean;
  topHitRank: number | null;
  lowConfidence: boolean;
  coverageGap: string;
}): AuditResult['failure_mode'] {
  if (input.pass) return null;
  if (input.topHitRank == null) return 'retrieval_miss';
  if (!input.selectedActHit) return 'selection_drift';
  if (input.lowConfidence || input.coverageGap !== 'none') return 'honesty_fail';
  return 'trace_anomaly';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      server.close(() => (port ? resolvePort(port) : rejectPort(new Error('no port'))));
    });
  });
}

async function waitHealth(baseUrl: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok && (await response.json() as { status?: string })?.status === 'healthy') return true;
    } catch {
      // ignore
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

async function runQuery(
  baseUrl: string,
  query: string,
  tenantId: string,
  userId: string
): Promise<{ runId: string; latencyMs: number; retrievalTrace: RetrievalTraceLike | null }> {
  const started = Date.now();
  let runId = '';
  try {
    const postRes = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
    });
    if (postRes.status !== 202) return { runId, latencyMs: Date.now() - started, retrievalTrace: null };
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) return { runId, latencyMs: Date.now() - started, retrievalTrace: null };
  } catch {
    return { runId, latencyMs: Date.now() - started, retrievalTrace: null };
  }

  const pollStart = Date.now();
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
      if (getRes.status === 200) {
        const run = (await getRes.json()) as { retrieval_trace?: RetrievalTraceLike | null };
        const trace = run.retrieval_trace;
        if (trace?.meta?.hits_count != null || trace?.meta?.low_confidence === true) {
          return { runId, latencyMs: Date.now() - started, retrievalTrace: trace };
        }
      }
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }

  return { runId, latencyMs: Date.now() - started, retrievalTrace: null };
}

async function loadTrace(runId: string, fallbackTrace: RetrievalTraceLike | null): Promise<RetrievalTraceLike | null> {
  if (!runId) return fallbackTrace;
  const persisted = await runRepo.findByRunId(runId);
  if (!persisted?.retrieval_trace || typeof persisted.retrieval_trace !== 'object') return fallbackTrace;
  const persistedTrace = persisted.retrieval_trace as RetrievalTraceLike;
  const { hits } = await getRetrievalTraceHitsForForensics(
    persisted as { retrieval_trace?: { hits?: unknown[]; meta?: { full_trace_r2_key?: string } } | null }
  );
  return {
    ...persistedTrace,
    hits: hits as RetrievalHitLike[],
  };
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(title: string): string[] {
  return title
    .normalize('NFC')
    .split(/[^\p{L}\p{N}-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function looksLikeStructuredActReferenceToken(token: string): boolean {
  return looksLikeStructuredActIdentifier(token.normalize('NFC').trim());
}

function titleSupportsCompactAcronym(title: string): boolean {
  return /(кодекс|конституц|конвенц)/iu.test(title.normalize('NFC'));
}

const GENERIC_ACT_ALIAS_TOKENS = new Set([
  'акт',
  'закон',
  'кодекс',
  'конституція',
  'конвенція',
  'постанова',
  'розпорядження',
  'наказ',
  'рішення',
  'правила',
  'порядок',
  'інструкція',
  'положення',
  'регламент',
  'указ',
  'кму',
  'вру',
  'мінукра',
  'моз',
  'мінфіну',
  'мінфін',
]);

const GENERIC_ACT_ACTION_TOKENS = new Set([
  'внесення',
  'внесенні',
  'зміни',
  'змін',
  'визнання',
  'таким',
  'такими',
  'втрата',
  'втрати',
  'втрату',
  'втратило',
  'втратили',
  'чинність',
  'чинності',
  'чинним',
  'чинними',
  'скасування',
  'скасувати',
  'скасовано',
  'припинення',
  'припинити',
  'припинено',
  'призначення',
  'призначити',
  'призначено',
  'звільнення',
  'звільнити',
  'звільнено',
  'схвалення',
  'схвалити',
  'затвердження',
  'затвердити',
  'утворення',
  'утворити',
  'ліквідації',
  'ліквідація',
  'реорганізації',
  'реорганізація',
]);

function softTokenOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 5 || right.length < 5) return false;
  return left.startsWith(right.slice(0, 5)) || right.startsWith(left.slice(0, 5));
}

function informativeAliasTokens(value: string): string[] {
  return tokenizeTitle(value).filter((token) => !GENERIC_ACT_ALIAS_TOKENS.has(token));
}

function durableAliasTokens(value: string): string[] {
  return informativeAliasTokens(value).filter((token) => !GENERIC_ACT_ACTION_TOKENS.has(token));
}

function aliasOverlapsActIdentity(doc: DocRow, alias: string): boolean {
  const aliasTokens = informativeAliasTokens(alias);
  if (aliasTokens.length === 0) return false;
  const titleTokens = informativeAliasTokens(doc.title);
  return aliasTokens.some((aliasToken) =>
    titleTokens.some((titleToken) => softTokenOverlap(aliasToken, titleToken))
  );
}

function isWeakAuditAlias(doc: DocRow, alias: string): boolean {
  const normalizedAlias = normalizeKey(alias);
  if (!normalizedAlias) return true;
  if (normalizedAlias === normalizeKey(doc.title)) return true;
  if (normalizedAlias === normalizeKey(doc.rada_nreg)) return true;
  if (looksLikeStructuredActReferenceToken(alias)) return true;

  const compactLettersOnly = /^[\p{L}]{1,6}$/u.test(alias.normalize('NFC').trim());
  if (compactLettersOnly && alias.trim().length <= 2) return true;
  if (compactLettersOnly && alias.trim().length <= 4 && !titleSupportsCompactAcronym(doc.title)) return true;

  const cue = normalizeActReferenceCue(alias);
  const numericStem = extractLeadingNumericStem(alias);
  if (cue && numericStem && numericStem.length < 3) return true;
  if (!compactLettersOnly && !numericStem && !aliasOverlapsActIdentity(doc, alias)) return true;

  return false;
}

function aliasHasDurableIdentity(doc: DocRow, alias: string): boolean {
  const distinctAliasTokens = durableAliasTokens(alias);
  if (distinctAliasTokens.length < 2) return false;
  const distinctTitleTokens = durableAliasTokens(doc.title);
  return distinctAliasTokens.some((aliasToken) =>
    distinctTitleTokens.some((titleToken) => softTokenOverlap(aliasToken, titleToken))
  );
}

function aliasNumericStemMatchesOwnAct(doc: DocRow, alias: string): boolean {
  const aliasStem = extractLeadingNumericStem(alias);
  const ownStem = extractLeadingNumericStem(doc.rada_nreg);
  if (!aliasStem || !ownStem) return true;
  return aliasStem === ownStem;
}

export function pickBestAlias(doc: DocRow, aliases: unknown): string | null {
  const normalizedTitle = normalizeKey(doc.title);
  const candidates = tolerantNormalizeToStrings(aliases)
    .map((alias) => alias.trim())
    .filter(Boolean)
    .filter((alias) => normalizeKey(alias) !== normalizedTitle);
  const usable = candidates.filter((alias) => !isWeakAuditAlias(doc, alias));
  const ranked = usable.sort((left, right) => {
    const leftWords = left.split(/\s+/).length;
    const rightWords = right.split(/\s+/).length;
    const leftAbbrev = /^[\p{Lu}\d./-]{2,20}$/u.test(left) ? 1 : 0;
    const rightAbbrev = /^[\p{Lu}\d./-]{2,20}$/u.test(right) ? 1 : 0;
    if (leftAbbrev !== rightAbbrev) return rightAbbrev - leftAbbrev;
    if (leftWords !== rightWords) return leftWords - rightWords;
    return left.length - right.length;
  });
  return ranked[0] ?? null;
}

function buildTitleFragment(title: string): string {
  const tokens = tokenizeTitle(title);
  if (tokens.length <= 8) return title.trim();
  return tokens.slice(0, 8).join(' ').trim();
}

function buildAnchoredTitle(doc: DocRow): string | null {
  const fragment = buildTitleFragment(doc.title);
  const documentType = doc.document_type?.trim();
  if (!documentType) return null;
  const normalizedFragment = normalizeKey(fragment);
  const normalizedDocumentType = normalizeKey(documentType);
  if (normalizedFragment.startsWith(normalizedDocumentType)) return fragment;
  return `${documentType} ${fragment}`.trim();
}

function buildCuedNumberProbe(doc: DocRow): string | null {
  const cue =
    normalizeActReferenceCue(doc.document_type) ??
    normalizeActReferenceCue(doc.document_type_slug) ??
    normalizeActReferenceCue(doc.title);
  const numericStem = extractLeadingNumericStem(doc.rada_nreg);
  if (!cue || !numericStem || numericStem.length < 3) return null;
  return `${cue} №${numericStem}`;
}

function canUseNregProbe(radaNreg: string): boolean {
  const normalized = radaNreg.normalize('NFC').trim();
  return normalized.length >= 3 && /\d/.test(normalized);
}

function dedupeProbes(probes: ProbeRow[]): ProbeRow[] {
  const seen = new Set<string>();
  const deduped: ProbeRow[] = [];
  for (const probe of probes) {
    const key = `${probe.probe_kind}::${normalizeKey(probe.query)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(probe);
  }
  return deduped;
}

export function buildBestProbe(doc: DocRow): ProbeRow {
  const alias = pickBestAlias(doc, doc.aliases);
  const nregProbeAvailable = canUseNregProbe(doc.rada_nreg);
  const amendmentLikeAct = isAmendmentLikeActTitle(doc.title);
  const compactCodeAlias =
    alias != null &&
    /^[\p{L}]{3,8}$/u.test(alias.normalize('NFC').trim()) &&
    titleSupportsCompactAcronym(doc.title);
  const strongAlias =
    alias != null &&
    (
      compactCodeAlias ||
      aliasHasDurableIdentity(doc, alias) ||
      (extractLeadingNumericStem(alias)?.length ?? 0) >= 3
    );
  if (
    amendmentLikeAct &&
    nregProbeAvailable &&
    alias != null &&
    (
      !compactCodeAlias &&
      (extractLeadingNumericStem(alias)?.length ?? 0) < 3 ||
      !aliasNumericStemMatchesOwnAct(doc, alias)
    )
  ) {
    return {
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'nreg',
      query: doc.rada_nreg,
    };
  }
  if (alias && (strongAlias || !nregProbeAvailable)) {
    return {
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'alias',
      query: alias,
    };
  }
  if (nregProbeAvailable) {
    return {
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'nreg',
      query: doc.rada_nreg,
    };
  }
  const anchoredTitle = buildAnchoredTitle(doc);
  if (anchoredTitle) {
    return {
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'anchored_title',
      query: anchoredTitle,
    };
  }
  return {
    rada_nreg: doc.rada_nreg,
    title: doc.title,
    category: doc.category,
    document_type: doc.document_type,
    validity_status: doc.validity_status,
    probe_kind: 'title_fragment',
    query: buildTitleFragment(doc.title),
  };
}

function buildProbes(doc: DocRow, probeMode: ProbeMode): ProbeRow[] {
  if (probeMode === 'best') return [buildBestProbe(doc)];

  const probes: ProbeRow[] = [];
  if (canUseNregProbe(doc.rada_nreg)) {
    probes.push({
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'nreg',
      query: doc.rada_nreg,
    });
  }

  const alias = pickBestAlias(doc, doc.aliases);
  if (alias) {
    probes.push({
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'alias',
      query: alias,
    });
  }

  const anchoredTitle = buildAnchoredTitle(doc);
  if (anchoredTitle) {
    probes.push({
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'anchored_title',
      query: anchoredTitle,
    });
  }

  const cuedNumber = buildCuedNumberProbe(doc);
  if (cuedNumber) {
    probes.push({
      rada_nreg: doc.rada_nreg,
      title: doc.title,
      category: doc.category,
      document_type: doc.document_type,
      validity_status: doc.validity_status,
      probe_kind: 'cued_number',
      query: cuedNumber,
    });
  }

  probes.push({
    rada_nreg: doc.rada_nreg,
    title: doc.title,
    category: doc.category,
    document_type: doc.document_type,
    validity_status: doc.validity_status,
    probe_kind: 'title_fragment',
    query: buildTitleFragment(doc.title),
  });

  return dedupeProbes(probes);
}

function findHitRank(trace: RetrievalTraceLike | null, radaNreg: string): number | null {
  const hits = trace?.hits ?? [];
  const index = hits.findIndex((hit) => hit.rada_nreg === radaNreg);
  return index >= 0 ? index + 1 : null;
}

function selectedActHit(trace: RetrievalTraceLike | null, radaNreg: string): boolean {
  return (trace?.meta?.selected_acts ?? []).some((act) => act.rada_nreg === radaNreg);
}

async function fetchIndexedDocs(limit: number, offset: number): Promise<DocRow[]> {
  const supabase = createSupabaseAdminClient();
  const pageSize = 1000;
  const rows: DocRow[] = [];
  let cursor = offset;
  while (rows.length < limit) {
    const upper = cursor + Math.min(pageSize, limit - rows.length) - 1;
    const { data, error } = await supabase
      .from('legislation_documents')
      .select(
        'rada_nreg,title,aliases,category,storage_category,document_type,document_type_slug,validity_status'
      )
      .eq('qdrant_status', 'indexed')
      .order('rada_nreg', { ascending: true })
      .range(cursor, upper);
    if (error) throw new Error(`Failed to fetch legislation_documents: ${error.message}`);
    const batch = (data ?? []) as DocRow[];
    if (batch.length === 0) break;
    rows.push(...batch);
    cursor += batch.length;
  }
  return rows;
}

async function fetchIndexedDocsByNregs(radaNregs: string[]): Promise<DocRow[]> {
  const normalized = [...new Set(radaNregs.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('legislation_documents')
    .select(
      'rada_nreg,title,aliases,category,storage_category,document_type,document_type_slug,validity_status'
    )
    .eq('qdrant_status', 'indexed')
    .in('rada_nreg', normalized);
  if (error) throw new Error(`Failed to fetch legislation_documents by nregs: ${error.message}`);
  const byNreg = new Map(((data ?? []) as DocRow[]).map((row) => [row.rada_nreg, row] as const));
  return normalized.map((radaNreg) => byNreg.get(radaNreg)).filter((row): row is DocRow => row != null);
}

async function main(): Promise<void> {
  const limit = parseInt(getArgValue('--limit') ?? '60', 10);
  const offset = parseInt(getArgValue('--offset') ?? '0', 10);
  const maxRank = parseInt(getArgValue('--max-rank') ?? '12', 10);
  const probeMode = (getArgValue('--probe-mode') ?? 'best') as ProbeMode;
  const onlyNregs = (getArgValue('--only-nregs') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const resume = process.argv.includes('--resume');
  if (!['best', 'generalized'].includes(probeMode)) {
    throw new Error(`Unsupported --probe-mode=${probeMode}; expected best|generalized`);
  }
  const reportPath = resolve(
    process.cwd(),
    getArgValue('--report-path') ?? 'scripts/lexery-legal-agent/tools/_reports/lldbi_act_coverage_audit.json'
  );

  const onlyNregSet = new Set(onlyNregs);
  const docs =
    onlyNregSet.size > 0
      ? await fetchIndexedDocsByNregs([...onlyNregSet])
      : await fetchIndexedDocs(limit, offset);
  const probes = docs.flatMap((doc) => buildProbes(doc, probeMode));
  const probeKeySet = new Set(probes.map((probe) => buildProbeKey(probe)));
  const completedProbeKeys = new Set<string>();
  const results: AuditResult[] = [];
  if (resume && existsSync(reportPath)) {
    const existing = JSON.parse(readFileSync(reportPath, 'utf8')) as Partial<AuditReport>;
    if (
      existing.offset !== offset ||
      existing.limit !== limit ||
      existing.max_rank !== maxRank ||
      existing.probe_mode !== probeMode ||
      JSON.stringify((existing.only_nregs ?? []).slice().sort()) !== JSON.stringify([...onlyNregSet].sort())
    ) {
      throw new Error(
        `Resume report mismatch for ${reportPath}: expected offset=${offset} limit=${limit} max_rank=${maxRank} probe_mode=${probeMode} only_nregs=${[...onlyNregSet].sort().join(',')}`
      );
    }
    for (const result of existing.results ?? []) {
      const auditResult = result as AuditResult;
      const probeKey = buildProbeKey(auditResult);
      if (!probeKeySet.has(probeKey)) {
        throw new Error(
          `Resume report contains stale probe not present in current run: ${probeKey}`
        );
      }
      results.push(auditResult);
      completedProbeKeys.add(probeKey);
    }
  }
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(
    '[audit_lldbi_act_coverage] port',
    port,
    'docs',
    docs.length,
    'probes',
    probes.length,
    `mode=${probeMode}`,
    resume ? `resume=${results.length}` : 'resume=0'
  );

  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    LEGAL_AGENT_DISABLE_LLM: 'true',
    USE_RULE_BASED_CLASSIFIER: 'true',
    DOCLIST_ENABLED: 'false',
    U10_DRY_RUN_KEEP_TRIAGE: 'true',
    U9_META_TRIAGE_ENABLED: 'false',
    MEMORY_RECENT_ENABLED: 'false',
    U5_STOP_AFTER_GATE: 'true',
    REDIS_QUEUE_NAMESPACE: `lexery:audit:lldbi-act-coverage:${randomUUID()}`,
  };

  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));

  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) throw new Error('Health failed');

    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const probe of probes) {
      const probeKey = buildProbeKey(probe);
      if (completedProbeKeys.has(probeKey)) continue;
      const { runId, latencyMs, retrievalTrace } = await runQuery(baseUrl, probe.query, tenantId, userId);
      const trace = await loadTrace(runId, retrievalTrace);
      const rank = findHitRank(trace, probe.rada_nreg);
      const selected = selectedActHit(trace, probe.rada_nreg);
      const groundedProbe = GROUNDED_PROBE_KINDS.has(probe.probe_kind);
      const honestyOk = trace?.meta?.low_confidence !== true && (trace?.meta?.coverage_gap ?? 'none') === 'none';
      const recovered = selected || (rank != null && rank <= maxRank);
      const pass = groundedProbe
        ? selected && honestyOk
        : recovered && (!selected || honestyOk);
      const lowConfidence = trace?.meta?.low_confidence === true;
      const coverageGap = trace?.meta?.coverage_gap ?? 'none';
      const result: AuditResult = {
        rada_nreg: probe.rada_nreg,
        title: probe.title,
        category: probe.category,
        document_type: probe.document_type,
        validity_status: probe.validity_status,
        probe_kind: probe.probe_kind,
        query: probe.query,
        run_id: runId,
        pass,
        selected_act_hit: selected,
        top_hit_rank: rank,
        latency_ms: latencyMs,
        qdrant_calls: trace?.meta?.qdrant_calls_count_total ?? null,
        low_confidence: lowConfidence,
        coverage_gap: coverageGap,
        failure_mode: classifyFailureMode({
          pass,
          selectedActHit: selected,
          topHitRank: rank,
          lowConfidence,
          coverageGap,
        }),
      };
      results.push(result);
      completedProbeKeys.add(probeKey);
      writeAuditReport(
        reportPath,
        createAuditReport({
          docs,
          results,
          maxRank,
          offset,
          limit,
          onlyNregs,
          probeMode,
          expectedTotal: probes.length,
          status: 'in_progress',
        })
      );
      console.log(
        '[audit_lldbi_act_coverage]',
        probe.rada_nreg,
        pass ? 'PASS' : 'FAIL',
        `probe=${probe.probe_kind}`,
        `rank=${rank ?? 'miss'}`,
        `selected=${selected ? 'yes' : 'no'}`
      );
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(SHUTDOWN_WAIT_MS).catch(() => undefined);
  }

  const report = createAuditReport({
    docs,
    results,
    maxRank,
    offset,
    limit,
    onlyNregs,
    probeMode,
    expectedTotal: probes.length,
    status: 'complete',
  });
  writeAuditReport(reportPath, report);

  console.log('\n--- LLDBI Act Coverage Summary ---');
  console.log(`pass: ${report.pass} / ${results.length}`);
  console.log(`fail: ${report.fail}`);
  console.log(`latency p50 ms: ${report.latency_p50_ms}`);
  console.log(`latency p95 ms: ${report.latency_p95_ms}`);
  console.log(`qdrant_calls median: ${report.qdrant_calls_median}`);
  for (const bucket of report.probe_summary) {
    console.log(`probe ${bucket.probe_kind}: ${bucket.pass}/${bucket.total} PASS`);
  }
  for (const bucket of report.failure_mode_summary) {
    console.log(`failure_mode ${bucket.failure_mode}: ${bucket.total}`);
  }
  const actPassAny = report.act_summary.filter((item) => item.pass_any).length;
  const groundedActPassAny = report.act_summary.filter((item) => item.grounded_probe_pass_any).length;
  console.log(`act pass_any: ${actPassAny}/${report.act_summary.length}`);
  console.log(`act grounded_probe_pass_any: ${groundedActPassAny}/${report.act_summary.length}`);
  if (report.fail > 0) {
    console.log('sample failures:');
    for (const failure of results.filter((result) => !result.pass).slice(0, 12)) {
      console.log(
        `- ${failure.rada_nreg} | probe=${failure.probe_kind} | rank=${failure.top_hit_rank ?? 'miss'} | low_conf=${failure.low_confidence} | gap=${failure.coverage_gap} | query=${failure.query}`
      );
    }
  }
  console.log(`[audit_lldbi_act_coverage] report: ${reportPath}`);
  if (report.fail > 0) process.exitCode = 1;
}

const isMainModule =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error('[audit_lldbi_act_coverage] fatal:', error);
    process.exit(1);
  });
}
