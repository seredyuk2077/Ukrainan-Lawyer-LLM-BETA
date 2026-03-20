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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';
import { RunRepository } from '../../gateway/storage.js';
import { getRetrievalTraceHitsForForensics } from '../../retrieval/retrieval-trace-r2.js';
import { tolerantNormalizeToStrings } from '../../retrieval/tolerant-normalizer.js';
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
  probe_kind: 'alias' | 'title_fragment';
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
};

function getArgValue(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const idx = process.argv.findIndex((arg) => arg === name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
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

function pickBestAlias(title: string, aliases: unknown): string | null {
  const normalizedTitle = normalizeKey(title);
  const candidates = tolerantNormalizeToStrings(aliases)
    .map((alias) => alias.trim())
    .filter(Boolean)
    .filter((alias) => normalizeKey(alias) !== normalizedTitle);
  const ranked = candidates.sort((left, right) => {
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

function buildProbe(doc: DocRow): ProbeRow {
  const alias = pickBestAlias(doc.title, doc.aliases);
  if (alias) {
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

async function main(): Promise<void> {
  const limit = parseInt(getArgValue('--limit') ?? '60', 10);
  const offset = parseInt(getArgValue('--offset') ?? '0', 10);
  const maxRank = parseInt(getArgValue('--max-rank') ?? '12', 10);
  const reportPath = resolve(
    process.cwd(),
    'scripts/lexery-legal-agent/tools/_reports/lldbi_act_coverage_audit.json'
  );

  const docs = await fetchIndexedDocs(limit, offset);
  const probes = docs.map(buildProbe);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('[audit_lldbi_act_coverage] port', port, 'probes', probes.length);

  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    LEGAL_AGENT_DISABLE_LLM: 'true',
    USE_RULE_BASED_CLASSIFIER: 'true',
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

  const results: AuditResult[] = [];
  try {
    const healthOk = await waitHealth(baseUrl);
    if (!healthOk) throw new Error('Health failed');

    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    for (const probe of probes) {
      const { runId, latencyMs, retrievalTrace } = await runQuery(baseUrl, probe.query, tenantId, userId);
      const trace = await loadTrace(runId, retrievalTrace);
      const rank = findHitRank(trace, probe.rada_nreg);
      const selected = selectedActHit(trace, probe.rada_nreg);
      const pass = selected || (rank != null && rank <= maxRank);
      results.push({
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
        low_confidence: trace?.meta?.low_confidence === true,
        coverage_gap: trace?.meta?.coverage_gap ?? 'none',
      });
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

  const report = {
    generated_at: new Date().toISOString(),
    total: results.length,
    pass: passCount,
    fail: failCount,
    max_rank: maxRank,
    offset,
    limit,
    latency_p50_ms: p50Latency,
    latency_p95_ms: p95Latency,
    qdrant_calls_median: medianQdrant,
    category_summary: [...byCategory.entries()]
      .sort((left, right) => right[1].total - left[1].total)
      .map(([category, stats]) => ({ category, ...stats })),
    failures: results.filter((result) => !result.pass),
    results,
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\n--- LLDBI Act Coverage Summary ---');
  console.log(`pass: ${passCount} / ${results.length}`);
  console.log(`fail: ${failCount}`);
  console.log(`latency p50 ms: ${p50Latency}`);
  console.log(`latency p95 ms: ${p95Latency}`);
  console.log(`qdrant_calls median: ${medianQdrant}`);
  if (failCount > 0) {
    console.log('sample failures:');
    for (const failure of results.filter((result) => !result.pass).slice(0, 12)) {
      console.log(
        `- ${failure.rada_nreg} | probe=${failure.probe_kind} | rank=${failure.top_hit_rank ?? 'miss'} | low_conf=${failure.low_confidence} | gap=${failure.coverage_gap} | query=${failure.query}`
      );
    }
  }
  console.log(`[audit_lldbi_act_coverage] report: ${reportPath}`);
  if (failCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[audit_lldbi_act_coverage] fatal:', error);
  process.exit(1);
});
