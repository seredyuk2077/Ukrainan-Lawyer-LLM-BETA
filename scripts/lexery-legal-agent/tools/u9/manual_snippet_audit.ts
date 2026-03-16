/**
 * U9 Snippet Fidelity Audit — re-loads up to 5 law snippets from R2 and verifies correctness.
 * Run: pnpm brain:u9:snippet-audit
 *
 * Checks per snippet:
 *   1) ok=true (R2 load succeeds)
 *   2) text is non-empty (not an error placeholder)
 *   3) text does not start with '[Норма недоступна' (no stale placeholders in DB refs)
 *   4) json_path resolves: matches $.content.chunks[N].text
 *   5) truncation: if loaded text was truncated → ends with '…'
 *   6) prefix stability: re-loading same ref → same first 120 chars
 */
import { getSupabaseClient } from '../../lib/supabase.js';
import { loadCanonicalSnippet } from '../../retrieval/r2-fragment.js';
import type { LawSourceRef } from '../../lib/pipeline/contracts.js';
import { config } from '../../lib/config.js';

const MAX_SNIPPETS = 5;
const MAX_SNIPPET_CHARS = config.u9MaxSnippetChars ?? 3000;
const PREFIX_LENGTH = 120;

interface AuditResult {
  rank: number;
  r2_key: string;
  json_path: string;
  passed: boolean;
  failures: string[];
  textLength?: number;
  truncated?: boolean;
  prefixStable?: boolean;
}

async function auditRef(ref: LawSourceRef, idx: number): Promise<AuditResult> {
  const failures: string[] = [];

  const load1 = await loadCanonicalSnippet(ref, MAX_SNIPPET_CHARS);
  if (!load1.ok) {
    return {
      rank: idx,
      r2_key: ref.r2_key,
      json_path: ref.json_path,
      passed: false,
      failures: [`R2 load failed: ${load1.error}`],
    };
  }

  const text = load1.text;

  if (!text || text.length === 0) {
    failures.push('text is empty');
  }

  if (text.startsWith('[Норма недоступна') || text.startsWith('[R2')) {
    failures.push(`text looks like an error placeholder: "${text.slice(0, 60)}"`);
  }

  const jsonPathPattern = /^\$\.content\.chunks\[\d+\]\.text$/;
  if (!jsonPathPattern.test(ref.json_path)) {
    failures.push(`json_path format unexpected: "${ref.json_path}"`);
  }

  if (load1.truncated && !text.endsWith('…')) {
    failures.push('text is truncated but missing trailing ellipsis marker');
  }

  // Prefix stability: re-load and compare first 120 chars
  const load2 = await loadCanonicalSnippet(ref, MAX_SNIPPET_CHARS);
  let prefixStable = false;
  if (load2.ok) {
    const prefix1 = load1.text.slice(0, PREFIX_LENGTH);
    const prefix2 = load2.text.slice(0, PREFIX_LENGTH);
    prefixStable = prefix1 === prefix2;
    if (!prefixStable) {
      failures.push('prefix instability: re-loading returned different first 120 chars');
    }
  } else {
    failures.push(`second load failed: ${load2.error}`);
  }

  return {
    rank: idx,
    r2_key: ref.r2_key,
    json_path: ref.json_path,
    passed: failures.length === 0,
    failures,
    textLength: text.length,
    truncated: load1.truncated,
    prefixStable,
  };
}

async function main(): Promise<void> {
  console.log('=== U9 Snippet Fidelity Audit ===\n');

  const sb = getSupabaseClient();

  // Find the most recent run with law snippets
  const { data: rows, error } = await sb
    .from('runs')
    .select('run_id, assembled_prompt')
    .not('assembled_prompt', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !rows || rows.length === 0) {
    console.error('FAIL: could not fetch runs from DB:', error?.message ?? 'no rows');
    process.exit(1);
  }

  let runId: string | null = null;
  let lawSourceRefs: LawSourceRef[] = [];

  for (const row of rows) {
    const meta = row.assembled_prompt as Record<string, unknown> | null;
    const refs = meta?.lawSourceRefs as LawSourceRef[] | undefined;
    if (refs && refs.length > 0 && refs.some((r) => r.loaded)) {
      runId = row.run_id as string;
      lawSourceRefs = refs.filter((r) => r.loaded).slice(0, MAX_SNIPPETS);
      break;
    }
  }

  if (!runId || lawSourceRefs.length === 0) {
    console.warn('SKIP: no runs found with loaded law snippets. Run a real pipeline first.');
    console.log('\n[SKIP] No audit data available — system has not processed any runs with law snippets yet.');
    process.exit(0);
  }

  console.log(`Run ID: ${runId}`);
  console.log(`Auditing ${lawSourceRefs.length} snippet(s) (max ${MAX_SNIPPETS})...\n`);

  const results: AuditResult[] = [];
  for (const ref of lawSourceRefs) {
    const r = await auditRef(ref, ref.rank);
    results.push(r);

    const status = r.passed ? '[OK]' : '[FAIL]';
    const extra = r.passed
      ? `len=${r.textLength}, truncated=${r.truncated}, prefix_stable=${r.prefixStable}`
      : r.failures.join('; ');
    console.log(`${status} rank=${r.rank} ${r.r2_key} ${r.json_path}`);
    if (!r.passed) {
      for (const f of r.failures) console.log(`       ↳ ${f}`);
    } else {
      console.log(`       ↳ ${extra}`);
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n--- Summary ---`);
  console.log(`Total audited: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.error('\nFAIL — snippet fidelity issues detected.');
    process.exit(1);
  } else {
    console.log('\nPASS — all snippets fidelity OK.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
