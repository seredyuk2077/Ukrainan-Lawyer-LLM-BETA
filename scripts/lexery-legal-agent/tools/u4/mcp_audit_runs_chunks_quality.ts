#!/usr/bin/env node
/**
 * MCP-style audit: runs + chunks quality (read-only).
 * Fetches runs from Supabase, optionally fetches chunk snippets from R2, writes markdown report.
 * Usage: pnpm exec tsx scripts/lexery-legal-agent/tools/mcp_audit_runs_chunks_quality.ts [--limit 15] [--since-days 3]
 */
import { createClient } from '@supabase/supabase-js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { config } from '../../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

const DEFAULT_LIMIT = 15;
const DEFAULT_SINCE_DAYS = 3;
const TOP_CHUNKS_PER_RUN = 8;
const SNIPPET_MAX_CHARS = 360;

type QueryProfile = {
  domain?: string;
  domainHint?: string;
  lldbi?: {
    categories_ranked_top3?: string[];
    document_types_ranked_top3?: string[];
  };
};

type RawHit = {
  r2_key?: string;
  json_path?: string;
  score?: number;
  rada_nreg?: string;
  title?: string;
  source?: string;
};

type Meta = {
  selected_acts?: Array<{ rada_nreg?: string; act_title?: string; score?: number; why_selected?: string; reason_tag?: string }>;
  selected_acts_sources_breakdown?: { from_taxonomy?: string[]; from_acts_search?: string[]; from_chunks_evidence?: string[] };
  low_confidence?: boolean;
  reason_codes?: string[];
  chunks_evidence_top_acts?: Array<{ rada_nreg?: string; count_in_top30?: number }>;
  lldbi_hints_present?: boolean;
  lldbi_hints_used?: { categories_used_count?: number; doc_types_used_count?: number; injected_acts_count?: number };
};

type RunRow = {
  run_id: string;
  query: string | null;
  query_profile: QueryProfile | null;
  retrieval_trace: {
    hits?: RawHit[];
    meta?: Meta;
    latency_ms?: number;
  } | null;
  updated_at?: string;
};

async function getSnippet(r2Key: string, jsonPath: string): Promise<string> {
  try {
    const { getFragmentFromR2 } = await import('../retrieval/r2-fragment.js');
    const text = await getFragmentFromR2(r2Key, jsonPath);
    if (!text) return '(empty)';
    const s = text.replace(/\s+/g, ' ').trim();
    return s.length <= SNIPPET_MAX_CHARS ? s : s.slice(0, SNIPPET_MAX_CHARS) + '…';
  } catch {
    return '(R2 unavailable or error)';
  }
}

function parseArgs(): { limit: number; sinceDays: number } {
  const args = process.argv.slice(2);
  let limit = DEFAULT_LIMIT;
  let sinceDays = DEFAULT_SINCE_DAYS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Math.max(1, parseInt(args[i + 1], 10) || DEFAULT_LIMIT);
      i++;
    } else if (args[i] === '--since-days' && args[i + 1]) {
      sinceDays = Math.max(1, parseInt(args[i + 1], 10) || DEFAULT_SINCE_DAYS);
      i++;
    }
  }
  return { limit, sinceDays };
}

async function main(): Promise<void> {
  const { limit, sinceDays } = parseArgs();

  const url = config.supabaseUrl?.trim();
  const key = config.supabaseServiceKey?.trim();
  if (!url || !key) {
    console.error('SUPABASE_LEXERY_LEGAL_AGENT_DB_URL and SERVICE_KEY required');
    process.exit(1);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const { data: rows, error } = await client
    .from('runs')
    .select('run_id, query, query_profile, retrieval_trace, updated_at')
    .not('retrieval_trace', 'is', null)
    .gte('updated_at', since.toISOString())
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Supabase error:', error.message);
    process.exit(1);
  }

  const runs = (rows ?? []) as RunRow[];
  console.log(`[mcp_audit] fetched ${runs.length} runs (since ${sinceDays} days)`);

  const reportLines: string[] = [
    `# MCP аудит runs + якість чанків (${new Date().toISOString().slice(0, 10)})`,
    '',
    '## Джерело',
    `- Supabase runs, \`retrieval_trace IS NOT NULL\`, останні ${sinceDays} дні, limit ${limit}`,
    '- Чанки: топ 5–8 hits з `retrieval_trace.hits`, snippet з R2 (якщо налаштовано)',
    '',
    '---',
    '',
    '## Таблиця runs',
    '',
    '| run_id | query | domainHint | lldbi cats | lldbi doc_types | selected_acts (n) | low_conf | reason_codes |',
    '|--------|-------|------------|------------|-----------------|-------------------|----------|---------------|',
  ];

  const runDetails: string[] = [];

  for (const run of runs) {
    const profile = run.query_profile ?? {};
    const lldbi = profile.lldbi ?? {};
    const cats = lldbi.categories_ranked_top3 ?? [];
    const docTypes = lldbi.document_types_ranked_top3 ?? [];
    const rt = run.retrieval_trace;
    const meta = rt?.meta ?? {};
    const selected = meta.selected_acts ?? [];
    const reasonCodes = meta.reason_codes ?? [];
    const lowConf = meta.low_confidence ?? false;

    const queryShort = (run.query ?? '').slice(0, 50) + (run.query && run.query.length > 50 ? '…' : '');
    const catsStr = cats.length ? cats.slice(0, 2).join(', ') : '—';
    const docStr = docTypes.length ? docTypes.slice(0, 2).join(', ') : '—';
    const reasonStr = reasonCodes.length ? reasonCodes.slice(0, 3).join(', ') : '—';

    reportLines.push(
      `| ${run.run_id.slice(0, 8)}… | ${queryShort.replace(/\|/g, '\\|')} | ${profile.domainHint ?? '—'} | ${catsStr.replace(/\|/g, '\\|')} | ${docStr.replace(/\|/g, '\\|')} | ${selected.length} | ${lowConf} | ${reasonStr.replace(/\|/g, '\\|')} |`
    );

    runDetails.push(`### Run ${run.run_id}`);
    runDetails.push('');
    runDetails.push(`**Запит:** ${run.query ?? '—'}`);
    runDetails.push(`**domainHint:** ${profile.domainHint ?? '—'} | **lldbi_hints_present:** ${meta.lldbi_hints_present ?? false}`);
    runDetails.push('');
    runDetails.push('**selected_acts:**');
    selected.slice(0, 10).forEach((a) => {
      runDetails.push(`- ${a.rada_nreg ?? '—'} | ${(a.act_title ?? '').slice(0, 70)} | ${a.reason_tag ?? '—'}`);
    });
    runDetails.push('');
    runDetails.push(`**low_confidence:** ${meta.low_confidence ?? '—'} | **reason_codes:** ${JSON.stringify(reasonCodes)}`);
    runDetails.push('');
    runDetails.push('**Топ чанки (hits):**');

    const hits = (rt?.hits ?? []).slice(0, TOP_CHUNKS_PER_RUN);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const r2Key = h.r2_key ?? '';
      const jsonPath = h.json_path ?? '';
      runDetails.push(`- **${i + 1}.** rada_nreg: ${h.rada_nreg ?? '—'}, title: ${(h.title ?? '').slice(0, 50)}, score: ${h.score ?? '—'}, source: ${h.source ?? '—'}`);
      if (r2Key && jsonPath) {
        const snippet = await getSnippet(r2Key, jsonPath);
        runDetails.push(`  - snippet: ${snippet.slice(0, 280)}${snippet.length > 280 ? '…' : ''}`);
      }
    }
    runDetails.push('');
    runDetails.push('**Юридична оцінка (коротко):**');
    runDetails.push('- Релевантність чанків до запиту: перевірити вручну');
    runDetails.push('- Шум / missing типи актів: перевірити вручну');
    runDetails.push('- Достатність даних для Writer: перевірити вручну');
    runDetails.push('');
  }

  reportLines.push('');
  reportLines.push('---');
  reportLines.push('');
  reportLines.push('## Деталі по run + чанки');
  reportLines.push('');
  reportLines.push(...runDetails);

  reportLines.push('');
  reportLines.push('---');
  reportLines.push('');
  reportLines.push('## ТОП-5 патернів багів (заповнити після аналізу)');
  reportLines.push('');
  reportLines.push('1. _Патерн 1: run_id, опис_');
  reportLines.push('2. _Патерн 2_');
  reportLines.push('3. _Патерн 3_');
  reportLines.push('4. _Патерн 4_');
  reportLines.push('5. _Патерн 5_');
  reportLines.push('');
  reportLines.push('*Звіт згенеровано скриптом mcp_audit_runs_chunks_quality.ts (read-only).*');

  const outPath = resolve(__dirname, '_reports/mcp_audit_runs_chunks_quality_' + new Date().toISOString().slice(0, 10) + '.md');
  writeFileSync(outPath, reportLines.join('\n'), 'utf-8');
  console.log('[mcp_audit] wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
