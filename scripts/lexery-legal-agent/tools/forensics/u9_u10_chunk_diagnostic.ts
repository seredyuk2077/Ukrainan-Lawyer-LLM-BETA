#!/usr/bin/env node
/**
 * U9–U10 chunk diagnostic: what law text U9 loads from R2 and what U10 would send.
 * Does NOT change RAG. Uses run from DB: retrieval_trace.hits + assembled_prompt (lawSourceRefs).
 * Optionally re-loads snippets from R2 to show actual text (length, preview, keyword match).
 *
 * Usage:
 *   pnpm exec tsx scripts/lexery-legal-agent/tools/forensics/u9_u10_chunk_diagnostic.ts -- --run-id <uuid>
 *   pnpm exec tsx scripts/lexery-legal-agent/tools/forensics/u9_u10_chunk_diagnostic.ts -- --run-id <uuid> --load-r2
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

import { parseArgs } from 'node:util';
import { RunRepository } from '../../gateway/storage.js';
import type { RawHit } from '../../retrieval/types.js';
import { getRetrievalTraceHitsForForensics } from '../../retrieval/retrieval-trace-r2.js';
import { gapFreeDeterministicFallback, extractArticleNumbersFromQuery } from '../../assemble/metaTriage.js';
import { loadCanonicalSnippet } from '../../retrieval/r2-fragment.js';
import { config } from '../../lib/config.js';

function dedupAndSortHits(rawHits: RawHit[]): RawHit[] {
  const map = new Map<string, RawHit>();
  for (const h of rawHits) {
    const key = `${h.r2_key}::${h.json_path}`;
    const existing = map.get(key);
    if (!existing || h.score > existing.score) map.set(key, h);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ka = `${a.r2_key}::${a.json_path}`;
    const kb = `${b.r2_key}::${b.json_path}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

const PREVIEW_LEN = 380;

/** Unicode-safe tokenize (Cyrillic/Latin/digits). */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Generic stopwords (UA/EN) to avoid inflated overlap from common words. */
const STOPWORDS = new Set([
  'та', 'і', 'в', 'на', 'з', 'до', 'для', 'у', 'про', 'від', 'за', 'не', 'що', 'як', 'але', 'або', 'це', 'було', 'буде', 'є',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'have', 'has', 'had', 'been', 'being',
]);

/** Raw overlap: count of query tokens that appear in text (token-based, not substring). */
function rawTokenOverlap(query: string, text: string): number {
  const qSet = new Set(tokenize(query));
  const tSet = new Set(tokenize(text));
  return [...qSet].filter((t) => tSet.has(t)).length;
}

/** Filtered overlap: exclude stopwords (min 2 chars), then count + Jaccard. */
function filteredOverlap(query: string, text: string): { count: number; jaccard: number } {
  const qSet = new Set(tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length >= 2));
  const tSet = new Set(tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length >= 2));
  if (qSet.size === 0) return { count: 0, jaccard: 0 };
  const inter = [...qSet].filter((t) => tSet.has(t)).length;
  const union = qSet.size + tSet.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  return { count: inter, jaccard };
}

/** Legacy: token overlap count (query tokens appearing in text). Domain-agnostic. */
function tokenOverlapCount(query: string, text: string): number {
  return rawTokenOverlap(query, text);
}

/** Source diversity: unique r2_key count / selected count (1 = all from different sources). */
function sourceDiversityIndex(hits: Array<{ r2_key?: string }>): number {
  if (hits.length === 0) return 0;
  const keys = new Set(hits.map((h) => h.r2_key ?? '').filter(Boolean));
  return keys.size / hits.length;
}

/** Rank histogram: counts in bins [0-9], [10-19], ... */
function rankHistogram(indices: number[]): string {
  const bins = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 0-9, 10-19, ..., 90-99
  for (const i of indices) {
    const bin = Math.min(9, Math.floor(i / 10));
    bins[bin]++;
  }
  return bins.map((c, i) => `${i * 10}-${i * 10 + 9}:${c}`).join(' ');
}

async function main() {
  if (process.argv[2] === '--') process.argv.splice(2, 1);
  const { values } = parseArgs({
    options: { 'run-id': { type: 'string', short: 'r' }, 'load-r2': { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const runId = values['run-id'];
  const loadR2 = values['load-r2'] ?? false;
  if (!runId) {
    console.error('Usage: --run-id <uuid> [--load-r2]');
    process.exit(1);
  }

  const repo = new RunRepository();
  const run = await repo.findByRunId(runId);
  if (!run) {
    console.error('Run not found:', runId);
    process.exit(1);
  }

  const query = (run.query ?? '').slice(0, 200);
  const { hits: rawHitsArray, source: hitsSource } = await getRetrievalTraceHitsForForensics(
    run as { retrieval_trace?: { hits?: unknown[]; meta?: { full_trace_r2_key?: string } } | null }
  );
  const rawHits = rawHitsArray as RawHit[];
  // Support both assembled_prompt.meta.lawSourceRefs and legacy top-level lawSourceRefs
  const assembled = run.assembled_prompt as {
    lawSourceRefs?: Array<{ r2_key?: string; json_path?: string; article_number?: string | null; rank?: number }>;
    meta?: { lawSourceRefs?: Array<{ r2_key?: string; json_path?: string; article_number?: string | null; rank?: number }> };
  } | undefined;
  const lawRefs = assembled?.meta?.lawSourceRefs ?? assembled?.lawSourceRefs ?? [];

  console.log('=== U9–U10 Chunk Diagnostic ===');
  console.log('run_id:', runId);
  console.log('query:', query);
  console.log('');

  if (rawHits.length === 0) {
    console.log('No retrieval_trace.hits (DB or R2). Cannot simulate U9.');
    process.exit(0);
  }
  console.log('hits source:', hitsSource === 'r2' ? 'R2 (full trace)' : 'DB (compact)');
  console.log('');

  const deduped = dedupAndSortHits(rawHits);
  const queryNumbers = extractArticleNumbersFromQuery(query);
  const maxSelect = Math.min(config.u9MaxLawSnippets, 20);
  const fallbackIndices = gapFreeDeterministicFallback(deduped, query, maxSelect);
  const simulatedHits = fallbackIndices.map((i) => deduped[i]!);

  console.log('--- U4 → U9 ---');
  console.log('raw_hits count:', rawHits.length);
  console.log('deduped count:', deduped.length);
  console.log('query article numbers (from query text):', queryNumbers.size ? [...queryNumbers].join(', ') : '(none)');
  console.log('');

  console.log('--- ACTUAL selected from snapshot (DB) ---');
  console.log('lawSourceRefs count:', lawRefs.length);
  lawRefs.slice(0, 25).forEach((ref, i) => {
    const art = ref.article_number ?? '—';
    console.log(`  [${i}] rank=${ref.rank ?? '—'} art=${art} ${ref.r2_key ?? ''} ${ref.json_path ?? ''}`);
  });
  if (lawRefs.length > 25) console.log(`  ... and ${lawRefs.length - 25} more`);
  console.log('');

  console.log('--- SIMULATED fallback (deterministic, not from DB) ---');
  console.log('gap-free deterministic fallback: selected', fallbackIndices.length, 'indices');
  console.log('fallback indices (ranks):', fallbackIndices.join(', '));
  console.log('source diversity index:', sourceDiversityIndex(simulatedHits).toFixed(3), '(1 = all different sources)');
  console.log('selected rank histogram:', rankHistogram(fallbackIndices));
  console.log('');

  // Query article-number overlap: which hits have article_number in query numbers
  const articleMatchIndices = new Set<number>();
  if (queryNumbers.size > 0) {
    for (let i = 0; i < deduped.length; i++) {
      const art = deduped[i]?.article_number;
      if (art != null && queryNumbers.has(String(art))) articleMatchIndices.add(i);
    }
  }
  console.log('--- Query article-number overlap (in deduped list) ---');
  if (articleMatchIndices.size === 0) {
    console.log('  (no hits with article_number in query digits)');
  } else {
    for (const i of [...articleMatchIndices].sort((a, b) => a - b)) {
      const h = deduped[i]!;
      const inSimulated = fallbackIndices.includes(i);
      console.log(`  rank=${i} in_simulated_fallback=${inSimulated} score=${h.score?.toFixed(4)} art=${h.article_number} r2_key=${h.r2_key}`);
    }
  }
  console.log('');

  console.log('--- SIMULATED selected refs (first 25) ---');
  simulatedHits.slice(0, 25).forEach((h, i) => {
    const art = h.article_number ?? '—';
    console.log(`  [${i}] art=${art} score=${h.score?.toFixed(4)} ${h.r2_key} ${h.json_path}`);
  });
  if (simulatedHits.length > 25) console.log(`  ... and ${simulatedHits.length - 25} more`);
  console.log('');

  if (!loadR2) {
    console.log('--- To see actual snippet text, run with --load-r2 ---');
    process.exit(0);
  }

  console.log('--- Loading snippets from R2 (max ' + config.u9MaxSnippetChars + ' chars each) ---');
  type RefLike = { r2_key: string; json_path: string; article_number?: string | null; rank?: number };
  // Prefer ACTUAL snapshot refs for R2 load; fallback to SIMULATED only when snapshot has no law refs
  const lawPartsFromRefs: RefLike[] = lawRefs.length
    ? lawRefs.map((r) => ({ r2_key: r.r2_key!, json_path: r.json_path!, article_number: r.article_number ?? null, rank: r.rank ?? 0 }))
    : simulatedHits.map((h, i) => ({ r2_key: h.r2_key, json_path: h.json_path, article_number: h.article_number ?? null, rank: i }));
  console.log('Loading', lawPartsFromRefs.length, 'chunks from', lawRefs.length ? 'ACTUAL snapshot' : 'SIMULATED fallback (no snapshot refs)');
  let withRawOverlap = 0;
  let withFilteredOverlap = 0;
  let sumJaccard = 0;
  let countJaccard = 0;
  for (let i = 0; i < lawPartsFromRefs.length; i++) {
    const r = lawPartsFromRefs[i]!;
    const sourceRef = { r2_key: r.r2_key, json_path: r.json_path, score: 0, rank: r.rank ?? i, loaded: false, article_number: r.article_number ?? null };
    const result = await loadCanonicalSnippet(sourceRef, config.u9MaxSnippetChars);
    const art = r.article_number ?? '—';
    if (result.ok) {
      const raw = rawTokenOverlap(query, result.text);
      const filtered = filteredOverlap(query, result.text);
      if (raw > 0) withRawOverlap++;
      if (filtered.count > 0) withFilteredOverlap++;
      if (filtered.jaccard > 0) {
        sumJaccard += filtered.jaccard;
        countJaccard++;
      }
      const preview = result.text.slice(0, PREVIEW_LEN).replace(/\n/g, ' ');
      console.log(`\n[${i}] art=${art} len=${result.text.length} raw_overlap=${raw} filtered_overlap=${filtered.count} jaccard=${filtered.jaccard.toFixed(3)}`);
      console.log(`    preview: ${preview}${result.text.length > PREVIEW_LEN ? '...' : ''}`);
    } else {
      console.log(`\n[${i}] art=${art} LOAD_ERR: ${result.error}`);
    }
  }
  const n = lawPartsFromRefs.length;
  const pctRaw = n ? ((100 * withRawOverlap) / n).toFixed(1) : '0';
  const pctFiltered = n ? ((100 * withFilteredOverlap) / n).toFixed(1) : '0';
  const avgJaccard = countJaccard > 0 ? (sumJaccard / countJaccard).toFixed(3) : '—';
  console.log('\n--- Summary (domain-agnostic) ---');
  console.log('% selected chunks with non-zero raw lexical overlap:', pctRaw + '%');
  console.log('% selected chunks with non-zero filtered overlap (no stopwords):', pctFiltered + '%');
  console.log('avg Jaccard (filtered) over chunks with overlap:', avgJaccard);
  console.log('source diversity index:', sourceDiversityIndex(lawRefs.length ? lawRefs.map((x) => ({ r2_key: x.r2_key })) : simulatedHits).toFixed(3));
  console.log('\n--- Done ---');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
