#!/usr/bin/env node
import { createServer } from 'net';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { RunRepository } from '../../gateway/storage.js';
import { getRetrievalTraceHitsForForensics } from '../../retrieval/retrieval-trace-r2.js';

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

interface RetrievalHitLike {
  rada_nreg?: string;
  title?: string;
  article_number?: string | null;
  unit_number?: string | null;
  unit_type?: string | null;
  citation_path?: string | null;
  act_title?: string;
  ordering_score?: number;
  score?: number;
  goal_id?: string;
}

interface RetrievalTraceLike {
  hits?: RetrievalHitLike[];
  meta?: {
    hits_count?: number;
    low_confidence?: boolean;
    coverage_gap?: string;
    reason_codes?: string[];
    qdrant_calls_count_total?: number;
    selected_acts?: Array<{
      rada_nreg?: string;
      act_title?: string;
      score?: number;
      act_kind?: string;
      source_tags?: string[];
      why_selected?: string;
    }>;
  };
}

function getArgValue(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const idx = process.argv.findIndex((arg) => arg === name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
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

function printSummary(query: string, runId: string, latencyMs: number, trace: RetrievalTraceLike | null): void {
  const meta = trace?.meta;
  const hits = trace?.hits ?? [];
  console.log('\n=== Query Retrieval Debug ===');
  console.log(`query: ${query}`);
  console.log(`run_id: ${runId || 'n/a'}`);
  console.log(`latency_ms: ${latencyMs}`);
  console.log(`hits_count: ${meta?.hits_count ?? hits.length}`);
  console.log(`low_confidence: ${String(meta?.low_confidence === true)}`);
  console.log(`coverage_gap: ${meta?.coverage_gap ?? 'none'}`);
  console.log(`qdrant_calls: ${meta?.qdrant_calls_count_total ?? 'n/a'}`);
  console.log(`reason_codes: ${(meta?.reason_codes ?? []).join(', ') || 'none'}`);

  console.log('\nSelected acts:');
  for (const [index, act] of (meta?.selected_acts ?? []).entries()) {
    console.log(
      `${index + 1}. ${act.rada_nreg ?? 'n/a'} | ${act.act_kind ?? 'UNKNOWN'} | ${act.act_title ?? 'Untitled'}`
    );
  }
  if ((meta?.selected_acts ?? []).length === 0) console.log('none');

  console.log('\nTop hits:');
  for (const [index, hit] of hits.slice(0, 12).entries()) {
    const citation = hit.citation_path ?? hit.article_number ?? hit.unit_number ?? '-';
    console.log(
      `${index + 1}. ${hit.rada_nreg ?? 'n/a'} | cite=${citation} | type=${hit.unit_type ?? '-'} | goal=${hit.goal_id ?? '-'} | ord=${typeof hit.ordering_score === 'number' ? hit.ordering_score.toFixed(3) : 'n/a'} | vec=${typeof hit.score === 'number' ? hit.score.toFixed(3) : 'n/a'} | ${hit.act_title ?? hit.title ?? 'Untitled'}`
    );
  }
  if (hits.length === 0) console.log('none');
}

async function main(): Promise<void> {
  const query = getArgValue('--query') ?? getArgValue('-q');
  if (!query) {
    console.error('Usage: pnpm exec tsx scripts/lexery-legal-agent/tools/u4/query_retrieval_debug.ts --query "..."');
    process.exit(1);
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnv = {
    ...process.env,
    BRAIN_PORT: String(port),
    DEV_API_KEY: DEV_KEY,
    LEGAL_AGENT_DISABLE_LLM: 'true',
    U9_META_TRIAGE_ENABLED: 'false',
    MEMORY_RECENT_ENABLED: 'false',
    U5_STOP_AFTER_GATE: 'true',
    REDIS_QUEUE_NAMESPACE: `lexery:debug:retrieval:${randomUUID()}`,
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
    if (!healthOk) {
      console.error('[query_retrieval_debug] Health failed');
      process.exit(1);
    }

    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    const { runId, latencyMs, retrievalTrace } = await runQuery(baseUrl, query, tenantId, userId);
    const trace = await loadTrace(runId, retrievalTrace);
    printSummary(query, runId, latencyMs, trace);
  } finally {
    child.kill('SIGTERM');
    await sleep(SHUTDOWN_WAIT_MS).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[query_retrieval_debug] fatal:', error);
  process.exit(1);
});
