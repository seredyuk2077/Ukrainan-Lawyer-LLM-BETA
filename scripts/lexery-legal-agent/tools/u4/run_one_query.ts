#!/usr/bin/env node
/**
 * One-off: run one query through full pipeline, print retrieval hits (act_title, article_ref, score).
 * Usage:
 *   pnpm exec tsx scripts/lexery-legal-agent/tools/run_one_query.ts "Ваш запит"
 *   pnpm exec tsx scripts/lexery-legal-agent/tools/run_one_query.ts --task 1   # повний текст Задачі 1 з task9_query.txt
 *   pnpm exec tsx scripts/lexery-legal-agent/tools/run_one_query.ts --batch 1 5  # задачі 1–5 з task9, дамп у _reports/task9_runs_dump_YYYY-MM-DD.json
 */
import { createServer } from 'net';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '.env.local') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';

const TASK9_PATH = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_datasets/task9_query.txt');

function loadTask9Blocks(): string[] {
  const content = readFileSync(TASK9_PATH, 'utf8');
  return content.split(/\n(?=Задача \d+\.)/).filter(Boolean).map((b) => b.trim());
}

function getQueryFromArgs(): string {
  if (process.argv[2] === '--task' && process.argv[3]) {
    const taskNum = parseInt(process.argv[3], 10);
    const blocks = loadTask9Blocks();
    const task = blocks[taskNum - 1] ?? blocks[0];
    return (task ?? '').trim();
  }
  return process.argv[2] ?? 'Водіння машиною в нетверезому стані, яка відповідальність?';
}

/** --batch from to → [from, to] (1-based inclusive); інакше null */
function getBatchRange(): [number, number] | null {
  if (process.argv[2] !== '--batch' || !process.argv[3] || !process.argv[4]) return null;
  const from = parseInt(process.argv[3], 10);
  const to = parseInt(process.argv[4], 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) return null;
  return [from, to];
}

const BATCH = getBatchRange();
const QUERY = BATCH ? '' : getQueryFromArgs();

interface RunWithTrace {
  run_id?: string;
  query_profile?: {
    domain?: string;
    domainHint?: string;
    domain_confidence?: number;
    routing_source?: string;
    lldbi?: { categories_ranked_top3?: string[]; document_types_ranked_top3?: string[] };
  } | null;
  retrieval_trace?: {
    hits?: Array<{ title?: string; act_title?: string; article_number?: string | null; article_ref?: string | null; score?: number; source?: string }>;
    meta?: {
      sample_hits?: Array<{ act_title?: string; article_ref?: string | null; score?: number }>;
      hits_count?: number;
      selected_acts?: Array<{ rada_nreg?: string; act_title?: string; act_kind?: string; category?: string; document_type?: string }>;
      chunks_evidence_top_acts?: Array<{ rada_nreg?: string; act_title?: string; count_in_top30?: number }>;
      reference_expansion?: { attempted?: boolean; added_count?: number; referenced_acts?: string[]; skipped_reason_codes?: string[] };
      low_confidence?: boolean;
      reason_codes?: string[];
      qdrant_calls_count_total?: number;
      lldbi_hints_present?: boolean;
      lldbi_hints_used?: { categories_used_count?: number; doc_types_used_count?: number; injected_acts_count?: number };
      query_rewrite?: { called?: boolean; used?: boolean; confidence?: number; rewritten_query?: string };
    };
  };
}

/** Один запис для task9_runs_dump_YYYY-MM-DD.json */
export type Task9RunDumpEntry = {
  task_index: number;
  run_id: string;
  query_preview: string;
  query_profile: RunWithTrace['query_profile'];
  selected_acts: Array<{ rada_nreg?: string; act_title?: string; act_kind?: string; category?: string; document_type?: string }>;
  reason_codes: string[];
  low_confidence: boolean;
  query_rewrite?: { called?: boolean; used?: boolean; confidence?: number; rewritten_query?: string };
  top_hits_20: Array<{ act_title?: string; article_number?: string | null; score?: number; source?: string }>;
};

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(baseUrl: string, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      const j = (await r.json()) as { status?: string };
      if (r.ok && j.status === 'healthy') return true;
    } catch {
      void 0;
    }
    await sleep(250);
  }
  return false;
}

/** Відправити один запит, дочекатись retrieval_trace, повернути run або null. */
async function runOneTask(baseUrl: string, query: string): Promise<RunWithTrace | null> {
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
    console.error('POST failed', postRes.status, await postRes.text());
    return null;
  }
  const { run_id } = (await postRes.json()) as { run_id?: string };
  if (!run_id) return null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const getRes = await fetch(`${baseUrl}/v1/runs/${run_id}`, { headers: { 'X-Dev-API-Key': DEV_KEY } });
    if (getRes.status !== 200) continue;
    const body = (await getRes.json()) as RunWithTrace | null;
    const rt = body?.retrieval_trace;
    if (rt && (rt.hits?.length !== undefined || (rt.meta?.hits_count != null && rt.meta.hits_count >= 0)))
      return body;
  }
  return null;
}

function toDumpEntry(run: RunWithTrace, taskIndex: number, query: string): Task9RunDumpEntry {
  const rt = run.retrieval_trace;
  const meta = rt?.meta;
  const hits = (rt?.hits ?? meta?.sample_hits ?? []) as Array<{ act_title?: string; title?: string; article_number?: string | null; article_ref?: string | null; score?: number; source?: string }>;
  const top20 = hits.slice(0, 20).map((h) => ({
    act_title: h.act_title ?? h.title,
    article_number: h.article_number ?? h.article_ref ?? null,
    score: h.score,
    source: h.source,
  }));
  return {
    task_index: taskIndex,
    run_id: run.run_id ?? '',
    query_preview: query.slice(0, 300),
    query_profile: run.query_profile ?? undefined,
    selected_acts: meta?.selected_acts ?? [],
    reason_codes: meta?.reason_codes ?? [],
    low_confidence: meta?.low_confidence ?? false,
    query_rewrite: meta?.query_rewrite,
    top_hits_20: top20,
  };
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnv = { ...process.env, BRAIN_PORT: String(port), DEV_API_KEY: DEV_KEY };
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', resolve(process.cwd(), 'scripts/lexery-legal-agent/server.ts')],
    { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (c) => process.stdout.write(c));
  child.stderr?.on('data', (c) => process.stderr.write(c));

  try {
    if (!(await waitHealth(baseUrl))) {
      console.error('Health timeout');
      process.exit(1);
    }

    if (BATCH) {
      const [from, to] = BATCH;
      const blocks = loadTask9Blocks();
      const results: Task9RunDumpEntry[] = [];
      for (let i = from; i <= to; i++) {
        const query = blocks[i - 1] ?? '';
        if (!query) {
          console.log(`[${i}] skip: no block`);
          continue;
        }
        process.stdout.write(`[${i}/${to}] run… `);
        const run = await runOneTask(baseUrl, query);
        if (run) {
          const entry = toDumpEntry(run, i, query);
          results.push(entry);
          console.log(`run_id=${run.run_id} hits=${run.retrieval_trace?.meta?.hits_count ?? run.retrieval_trace?.hits?.length ?? 0} sel=${entry.selected_acts.length} low_conf=${entry.low_confidence}`);
        } else {
          console.log('timeout/fail');
        }
      }
      const reportDir = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_reports');
      mkdirSync(reportDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const dumpPath = resolve(reportDir, `task9_runs_dump_${date}.json`);
      writeFileSync(dumpPath, JSON.stringify({ generated_at: new Date().toISOString(), from, to, runs: results }, null, 2), 'utf8');
      console.log('\nDump:', dumpPath);
      return;
    }

    const run = await runOneTask(baseUrl, QUERY);
    if (!run?.retrieval_trace) {
      console.error('Timeout: no retrieval_trace');
      process.exit(1);
    }
    const runData: RunWithTrace = run;
    const rt = runData.retrieval_trace!;
    const fullHits = rt.hits ?? [];
    const hitsForDisplay =
      fullHits.length > 0
        ? fullHits.map((h) => ({
            act_title: h.title,
            article_ref: h.article_number ?? null,
            score: h.score,
          }))
        : rt.meta?.sample_hits ?? [];
    if (runData.run_id) console.log('\n--- run_id ---\n' + runData.run_id);
    console.log('\n--- Запит ---');
    console.log(QUERY);
    const profile = runData.query_profile;
    if (profile) {
      console.log('\n--- query_profile (audit) ---');
      console.log('domain:', profile.domain ?? '—');
      console.log('domainHint:', profile.domainHint ?? '—');
      console.log('domain_confidence:', profile.domain_confidence ?? '—');
      const lldbi = profile.lldbi;
      if (lldbi) {
        console.log('lldbi.categories_ranked_top3:', (lldbi.categories_ranked_top3 ?? []).join(', ') || '—');
        console.log('lldbi.document_types_ranked_top3:', (lldbi.document_types_ranked_top3 ?? []).join(', ') || '—');
      }
    }
    const meta = rt.meta;
    if (meta) {
      console.log('\n--- retrieval_trace.meta (audit) ---');
      console.log('low_confidence:', meta.low_confidence ?? false);
      console.log('reason_codes:', (meta.reason_codes ?? []).join(', ') || '—');
      console.log('qdrant_calls_count_total:', meta.qdrant_calls_count_total ?? '—');
      console.log('lldbi_hints_present:', meta.lldbi_hints_present ?? false);
      if (meta.lldbi_hints_used) console.log('lldbi_hints_used:', JSON.stringify(meta.lldbi_hints_used));
      const sel = meta.selected_acts ?? [];
      console.log('selected_acts (n=' + sel.length + '):');
      sel.forEach((a: { rada_nreg?: string; act_title?: string; act_kind?: string; category?: string }, i: number) => {
        console.log(`  ${i + 1}. ${a.rada_nreg ?? '—'} | ${(a.act_title ?? '—').slice(0, 60)} | kind=${a.act_kind ?? '—'} | cat=${a.category ?? '—'}`);
      });
      const ev = meta.chunks_evidence_top_acts ?? [];
      if (ev.length) {
        console.log('chunks_evidence_top_acts (top 5):');
        ev.slice(0, 5).forEach((e: { rada_nreg?: string; count_in_top30?: number }, i: number) => console.log(`  ${i + 1}. ${e.rada_nreg ?? '—'} count=${e.count_in_top30 ?? '—'}`));
      }
      const refEx = meta.reference_expansion;
      if (refEx) {
        console.log('reference_expansion: attempted=', refEx.attempted, 'added_count=', refEx.added_count ?? 0, 'referenced_acts=', (refEx.referenced_acts ?? []).join(', ') || '—');
        if ((refEx.skipped_reason_codes ?? []).length) console.log('  skipped_reason_codes:', refEx.skipped_reason_codes!.join(', '));
      }
      const qr = (meta as { query_rewrite?: { called?: boolean; used?: boolean; rewritten_query?: string; confidence?: number; variants?: string[]; negative_terms?: string[] } }).query_rewrite;
      if (qr) {
        console.log('query_rewrite: called=', qr.called, 'used=', qr.used, 'confidence=', qr.confidence ?? '—');
        if (qr.rewritten_query) console.log('  rewritten_query:', String(qr.rewritten_query).slice(0, 120) + (qr.rewritten_query.length > 120 ? '…' : ''));
        if (qr.variants?.length) {
          for (const v of qr.variants) console.log('  variant:', String(v).slice(0, 100));
        }
        if (qr.negative_terms?.length) console.log('  negative_terms:', qr.negative_terms.join(', '));
      }
    }
    console.log(
      '\n--- Retrieval hits (акт, стаття, score) — всі доступні hits' +
        (fullHits.length ? ` (n=${fullHits.length})` : '') +
        ' ---'
    );
    const displayLimit = Math.min(hitsForDisplay.length, 50);
    type HitLike = { act_title?: string; title?: string; article_ref?: string | null; article_number?: string | null; score?: number; source?: string };
    hitsForDisplay.slice(0, displayLimit).forEach((h: HitLike, i: number) => {
      const title = h.act_title ?? h.title ?? '—';
      const art = h.article_ref ?? h.article_number ?? '—';
      const sc = h.score;
      const src = h.source ?? '';
      console.log(`${i + 1}. ${String(title).slice(0, 55)} | ст.${art} | score=${sc != null ? sc.toFixed(4) : '—'}${src ? ' | ' + src : ''}`);
    });
    if (hitsForDisplay.length > displayLimit) console.log('... і ще ' + (hitsForDisplay.length - displayLimit) + ' hits');
    const allHitsFor130: HitLike[] = fullHits.length > 0 ? (fullHits as HitLike[]) : (hitsForDisplay as HitLike[]);
    const has130 = allHitsFor130.some((h: HitLike) => {
      const art = String(h.article_ref ?? h.article_number ?? '').trim();
      const title = String(h.act_title ?? h.title ?? '');
      return art === '130' && /КУПАП|адміністративн.*правопорушен|кодекс.*адмін/i.test(title);
    });
    const anyKupap = allHitsFor130.some((h: HitLike) => {
      const title = String(h.act_title ?? h.title ?? '');
      return /КУПАП|Кодекс України про адміністративні правопорушення/i.test(title);
    });
    console.log('\n--- Перевірка ---');
    console.log('Є КУПАП у списку:', anyKupap ? 'ТАК' : 'НІ');
    console.log('Є ст. 130 КУПАП у списку:', has130 ? 'ТАК ✓' : 'НІ');
    if (has130) console.log('\n+ Релевантна стаття ст.130 КУПАП знайдена.');
    else if (anyKupap) console.log('\nКУПАП є, але ст.130 не в топі sample_hits. Перевір повний hits у run.retrieval_trace.hits.');
    else console.log('\nКУПАП не знайдено в топ-hits — можлива проблема.');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2000));
    try {
      child.kill('SIGKILL');
    } catch {
      void child.killed;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
