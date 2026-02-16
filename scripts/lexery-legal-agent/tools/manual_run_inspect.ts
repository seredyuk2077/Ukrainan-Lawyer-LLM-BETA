#!/usr/bin/env node
/**
 * Dev utility: read-only Supabase runs by run_id; print compact retrieval report.
 * Usage: pnpm exec tsx scripts/lexery-legal-agent/tools/manual_run_inspect.ts <run_id>
 */
import { createClient } from '@supabase/supabase-js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { config } from '../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

type QueryProfile = {
  domain?: string;
  domainHint?: string;
  domain_confidence?: number;
  domain_candidates_top2?: Array<{ key?: string; confidence?: number }>;
} | null;

type Meta = {
  selected_acts?: Array<{ rada_nreg?: string; act_title?: string; score?: number; source?: string }>;
  chunks_evidence_top_acts?: Array<{ rada_nreg?: string; act_title?: string; count_in_top30?: number }>;
  act_candidates_top?: Array<{ rada_nreg?: string; act_title?: string }>;
  reference_expansion?: {
    attempted?: boolean;
    added_count?: number;
    referenced_acts?: string[];
    skipped_reason_codes?: string[];
  };
  low_confidence?: boolean;
  reason_codes?: string[];
  qdrant_calls_count_total?: number;
  selected_acts_sources_breakdown?: Record<string, unknown>;
  selected_acts_decision?: { reason_codes?: string[] };
};

type RunRow = {
  run_id: string;
  query: string | null;
  query_profile: QueryProfile;
  retrieval_trace: { meta?: Meta; latency_ms?: number } | null;
};

async function main(): Promise<void> {
  const runId = process.argv[2]?.trim();
  if (!runId) {
    console.error('Usage: manual_run_inspect.ts <run_id>');
    process.exit(1);
  }

  const url = config.supabaseUrl?.trim();
  const key = config.supabaseServiceKey?.trim();
  if (!url || !key) {
    console.error('SUPABASE_LEXERY_LEGAL_AGENT_DB_URL and SERVICE_KEY required');
    process.exit(1);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await client
    .from('runs')
    .select('run_id, query, query_profile, retrieval_trace')
    .eq('run_id', runId)
    .maybeSingle();

  if (error) {
    console.error('Supabase error:', error.message);
    process.exit(1);
  }
  if (!data) {
    console.error('Run not found:', runId);
    process.exit(1);
  }

  const row = data as RunRow;
  const profile = row.query_profile ?? {};
  const rt = row.retrieval_trace;
  const meta = rt?.meta ?? ({} as Meta);

  console.log('--- query');
  console.log(row.query ?? '');

  console.log('\n--- query_profile (domain / domainHint / domain_confidence / domain_candidates_top2)');
  console.log(
    'domain:',
    (profile as QueryProfile)?.domain ?? '—',
    '| domainHint:',
    (profile as QueryProfile)?.domainHint ?? '—',
    '| domain_confidence:',
    (profile as QueryProfile)?.domain_confidence ?? '—'
  );
  const top2 = (profile as QueryProfile)?.domain_candidates_top2 ?? [];
  console.log('domain_candidates_top2:', JSON.stringify(top2.slice(0, 2)));

  console.log('\n--- retrieval_trace.meta.selected_acts (rada_nreg, title, score, source)');
  const selected = meta.selected_acts ?? [];
  selected.slice(0, 12).forEach((a) => {
    console.log(' ', a.rada_nreg ?? '—', '|', (a.act_title ?? '').slice(0, 60), '|', a.score ?? '—', '|', a.source ?? '—');
  });
  if (selected.length > 12) console.log(' ... +', selected.length - 12, 'more');

  console.log('\n--- meta.chunks_evidence_top_acts (top5)');
  const chunksEv = meta.chunks_evidence_top_acts ?? [];
  chunksEv.slice(0, 5).forEach((c) => {
    console.log(' ', c.rada_nreg ?? '—', '|', (c.act_title ?? '').slice(0, 50), '| count:', c.count_in_top30 ?? '—');
  });

  console.log('\n--- meta.act_candidates_top (top5)');
  const actCand = meta.act_candidates_top ?? [];
  actCand.slice(0, 5).forEach((a) => {
    console.log(' ', a.rada_nreg ?? '—', '|', (a.act_title ?? '').slice(0, 50));
  });

  console.log('\n--- meta.reference_expansion');
  const refEx = meta.reference_expansion ?? {};
  console.log(
    ' attempted:',
    refEx.attempted ?? '—',
    '| added_count:',
    refEx.added_count ?? '—',
    '| referenced_acts:',
    JSON.stringify(refEx.referenced_acts ?? []),
    '| skipped_reason_codes:',
    JSON.stringify(refEx.skipped_reason_codes ?? [])
  );

  console.log('\n--- low_confidence | reason_codes');
  console.log(' low_confidence:', meta.low_confidence ?? '—');
  console.log(' reason_codes:', JSON.stringify(meta.reason_codes ?? []));

  console.log('\n--- qdrant_calls_count_total | latency_ms');
  console.log(' qdrant_calls_count_total:', meta.qdrant_calls_count_total ?? '—');
  console.log(' latency_ms:', (rt as { latency_ms?: number })?.latency_ms ?? '—');
}

main();
