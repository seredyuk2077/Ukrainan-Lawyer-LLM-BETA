#!/usr/bin/env node
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '.env.local') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const datasetArg = process.argv.find((a) => a.startsWith('--dataset='));
const DATASET_PATH = datasetArg
  ? resolve(process.cwd(), datasetArg.replace('--dataset=', ''))
  : resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_datasets/final_manual_audit_queries.json');

type DatasetCase = {
  id: string;
  query: string;
  expected?: {
    must_include?: string[];
    notes?: string;
  };
};

type RunWithTrace = {
  run_id?: string;
  query_profile?: {
    domain?: string;
    domainHint?: string;
    lldbi?: {
      categories_ranked_top3?: string[];
      document_types_ranked_top3?: string[];
    };
  } | null;
  retrieval_trace?: {
    meta?: {
      selected_acts?: Array<{
        rada_nreg?: string;
        act_title?: string;
        act_kind?: string;
        category?: string;
        document_type?: string;
        score?: number;
      }>;
      reason_codes?: string[];
      low_confidence?: boolean;
      qdrant_calls_count_total?: number;
      latency_ms?: number;
      query_rewrite?: {
        called?: boolean;
        used?: boolean;
        rewritten_query?: string;
        confidence?: number;
        variants?: string[];
        negative_terms?: string[];
      };
      reference_expansion?: {
        attempted?: boolean;
        added_count?: number;
        referenced_acts?: string[];
        skipped_reason_codes?: string[];
      };
      lldbi_hints_present?: boolean;
      lldbi_hints_used?: {
        categories_used_count?: number;
        doc_types_used_count?: number;
        injected_acts_count?: number;
      };
      stage_decisions?: {
        used_multi_query?: boolean;
      };
      multi_query_variants_count?: number;
    };
  };
};

type AuditRunEntry = {
  id: string;
  query: string;
  run_id: string;
  domain?: string;
  domainHint?: string;
  lldbi_categories_top3?: string[];
  lldbi_doc_types_top3?: string[];
  selected_acts?: Array<{
    rada_nreg?: string;
    act_title?: string;
    act_kind?: string;
    category?: string;
    document_type?: string;
    score?: number;
  }>;
  reason_codes?: string[];
  low_confidence?: boolean;
  qdrant_calls_count_total?: number;
  latency_ms?: number;
  query_rewrite?: RunWithTrace['retrieval_trace'] extends { meta?: infer M }
    ? M extends { query_rewrite?: infer Q }
      ? Q
      : never
    : never;
  multi_query_variants_count?: number;
  used_multi_query?: boolean;
  reference_expansion?: RunWithTrace['retrieval_trace'] extends { meta?: infer M }
    ? M extends { reference_expansion?: infer R }
      ? R
      : never
    : never;
  lldbi_hints_present?: boolean;
  lldbi_hints_used?: RunWithTrace['retrieval_trace'] extends { meta?: infer M }
    ? M extends { lldbi_hints_used?: infer H }
      ? H
      : never
    : never;
  expected?: DatasetCase['expected'];
};

function loadDataset(): DatasetCase[] {
  const raw = readFileSync(DATASET_PATH, 'utf8');
  const parsed = JSON.parse(raw) as DatasetCase[];
  return parsed;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      s.close(() => (port ? resolvePort(port) : reject(new Error('No free port'))));
    });
  });
}

async function waitHealth(baseUrl: string, timeoutMs = 20_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      const j = (await r.json()) as { status?: string };
      if (r.ok && j.status === 'healthy') return true;
    } catch {
      // ignore transient startup errors
    }
    await sleep(250);
  }
  return false;
}

async function runOne(baseUrl: string, query: string): Promise<RunWithTrace | null> {
  const postRes = await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
    body: JSON.stringify({
      query,
      tenant_id: '00000000-0000-0000-0000-000000000001',
      user_id: '00000000-0000-0000-0000-000000000002',
    }),
  });
  if (postRes.status !== 202) {
    const txt = await postRes.text().catch(() => '');
    console.error(`POST failed ${postRes.status}: ${txt.slice(0, 200)}`);
    return null;
  }
  const postBody = (await postRes.json()) as { run_id?: string };
  if (!postBody.run_id) return null;

  for (let i = 0; i < 150; i++) {
    await sleep(500);
    const getRes = await fetch(`${baseUrl}/v1/runs/${postBody.run_id}`, {
      headers: { 'X-Dev-API-Key': DEV_KEY },
    });
    if (getRes.status !== 200) continue;
    const run = (await getRes.json()) as RunWithTrace;
    if (run?.retrieval_trace?.meta) return run;
  }
  return null;
}

function toEntry(testCase: DatasetCase, run: RunWithTrace): AuditRunEntry {
  const meta = run.retrieval_trace?.meta;
  return {
    id: testCase.id,
    query: testCase.query,
    run_id: run.run_id ?? '',
    domain: run.query_profile?.domain,
    domainHint: run.query_profile?.domainHint,
    lldbi_categories_top3: run.query_profile?.lldbi?.categories_ranked_top3 ?? [],
    lldbi_doc_types_top3: run.query_profile?.lldbi?.document_types_ranked_top3 ?? [],
    selected_acts: meta?.selected_acts ?? [],
    reason_codes: meta?.reason_codes ?? [],
    low_confidence: meta?.low_confidence ?? false,
    qdrant_calls_count_total: meta?.qdrant_calls_count_total,
    latency_ms: meta?.latency_ms,
    query_rewrite: meta?.query_rewrite,
    multi_query_variants_count: meta?.multi_query_variants_count,
    used_multi_query: meta?.stage_decisions?.used_multi_query,
    reference_expansion: meta?.reference_expansion,
    lldbi_hints_present: meta?.lldbi_hints_present,
    lldbi_hints_used: meta?.lldbi_hints_used,
    expected: testCase.expected,
  };
}

async function main() {
  const cases = loadDataset();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')], {
    env: serverEnv,
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  try {
    const healthy = await waitHealth(baseUrl);
    if (!healthy) {
      console.error('Health timeout');
      process.exit(1);
    }

    const results: AuditRunEntry[] = [];
    for (let i = 0; i < cases.length; i++) {
      const t = cases[i];
      process.stdout.write(`[${i + 1}/${cases.length}] ${t.id}... `);
      const run = await runOne(baseUrl, t.query);
      if (!run) {
        console.log('timeout/fail');
        results.push({
          id: t.id,
          query: t.query,
          run_id: '',
          reason_codes: ['RUN_TIMEOUT_OR_FAIL'],
          expected: t.expected,
        });
        continue;
      }
      const entry = toEntry(t, run);
      results.push(entry);
      console.log(`run_id=${entry.run_id} sel=${entry.selected_acts?.length ?? 0} low_conf=${entry.low_confidence ? 'true' : 'false'}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const outDir = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_reports');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `final_manual_audit_runs_${date}.json`);
    writeFileSync(
      outPath,
      JSON.stringify({ generated_at: new Date().toISOString(), total: cases.length, runs: results }, null, 2),
      'utf8'
    );
    console.log('\nSaved:', outPath);
  } finally {
    child.kill('SIGTERM');
    await sleep(3000);
    if (!child.killed) child.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

