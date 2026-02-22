#!/usr/bin/env node
/**
 * Phase 5.0 — Real retrieval dataset (read-only).
 * Fetches N latest runs from Supabase runs table, outputs JSONL for labeling/eval.
 * No writes to DB. Local artifact: tools/_datasets/retrieval_real_queries.jsonl
 */
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabaseClient } from '../../lib/supabase.js';
import { config } from '../../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIMIT = 200;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseLimit(): number {
  const idx = process.argv.indexOf('--limit');
  if (idx >= 0 && process.argv[idx + 1] != null) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(2000, n);
  }
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  if (arg) {
    const n = parseInt(arg.slice(8), 10);
    if (Number.isFinite(n) && n > 0) return Math.min(2000, n);
  }
  const env = process.env.BRAIN_DATASET_LIMIT;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(2000, n);
  }
  return DEFAULT_LIMIT;
}

export interface RealQueryRow {
  run_id: string;
  query: string;
  created_at: string | null;
  tenant_id_hash: string;
  fingerprint: string;
  flags?: { domain?: string; [k: string]: unknown };
}

async function main(): Promise<void> {
  const limit = parseLimit();
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    console.error('[dataset:retrieval-real] SUPABASE_LEXERY_LEGAL_AGENT_DB_URL and SERVICE_ROLE_KEY required (read-only)');
    process.exit(1);
  }
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('runs')
    .select('run_id, query, created_at, tenant_id, query_profile')
    .not('query', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[dataset:retrieval-real] DB read failed:', error.message);
    process.exit(1);
  }

  const rows: RealQueryRow[] = [];
  const seenFingerprint = new Set<string>();
  for (const r of data ?? []) {
    const query = typeof r.query === 'string' ? r.query.trim() : '';
    if (!query || query.length < 2) continue;
    const fingerprint = sha256(query).slice(0, 16);
    if (seenFingerprint.has(fingerprint)) continue;
    seenFingerprint.add(fingerprint);
    const tenantId = r.tenant_id != null ? String(r.tenant_id) : '';
    const tenantIdHash = tenantId ? sha256(tenantId).slice(0, 8) : '';
    const qp = r.query_profile as Record<string, unknown> | null | undefined;
    const flags: RealQueryRow['flags'] = {};
    if (qp?.domain != null) flags.domain = String(qp.domain);
    rows.push({
      run_id: r.run_id ?? '',
      query,
      created_at: r.created_at ?? null,
      tenant_id_hash: tenantIdHash,
      fingerprint,
      flags: Object.keys(flags).length > 0 ? flags : undefined,
    });
  }

  const outDir = resolve(__dirname, '../_datasets');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'retrieval_real_queries.jsonl');
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(outPath, jsonl, 'utf8');
  console.log('[dataset:retrieval-real] wrote', rows.length, 'rows to', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
