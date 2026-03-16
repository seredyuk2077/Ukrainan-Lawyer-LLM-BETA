#!/usr/bin/env node
/**
 * Forensics: print law refs + gate decision for a run (from Supabase).
 * Usage: pnpm brain:forensics:law-refs -- --run-id <uuid>
 */
import { parseArgs } from 'node:util';
import { RunRepository } from '../../gateway/storage.js';

interface LawRefRow {
  rank?: number;
  score?: number;
  r2_key?: string;
  json_path?: string;
  normRef?: { heading?: string; articleNumber?: number; partNumber?: string };
  act_title?: string;
  article_number?: string;
}

async function main() {
  if (process.argv[2] === '--') process.argv.splice(2, 1);
  const { values } = parseArgs({
    options: { 'run-id': { type: 'string' } },
    allowPositionals: true,
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('Usage: pnpm brain:forensics:law-refs -- --run-id <uuid>');
    process.exit(1);
  }

  const repo = new RunRepository();
  const run = await repo.findByRunId(runId);
  if (!run) {
    console.error('Run not found:', runId);
    process.exit(1);
  }

  const ap = run.assembled_prompt as Record<string, unknown> | undefined;
  const lawRefs = (ap?.lawSourceRefs as LawRefRow[] | undefined) ?? [];
  const gate = run.gate_decision as { expand?: boolean; reason_codes?: string[] } | undefined;

  const snapshot = run.snapshot as Record<string, unknown> | undefined;
  const u10Sel = snapshot?.u10_selection as Record<string, unknown> | undefined;

  console.log('--- Run law refs report ---');
  console.log('run_id:', run.run_id);
  console.log('status:', run.status);
  console.log('query:', (run.query ?? '').slice(0, 120) + (run.query && run.query.length > 120 ? '...' : ''));
  console.log('');
  console.log('gate_decision: expand =', gate?.expand ?? '—', ', reason_codes =', gate?.reason_codes ?? '—');
  console.log('');

  // DEV RUN v16: show meta-triage info if available in snapshot
  const metaTriage = snapshot?.u9_meta_triage as Record<string, unknown> | undefined;
  if (metaTriage) {
    console.log('u9_meta_triage:', JSON.stringify(metaTriage, null, 2));
    console.log('');
  }

  console.log('lawSourceRefs count:', lawRefs.length);
  console.log('All law refs (sourceId, score, heading, articleNumber):');
  for (const ref of lawRefs) {
    const sourceId = ref.r2_key && ref.json_path ? `${ref.r2_key}::${ref.json_path}` : '—';
    const heading = ref.normRef?.heading ? ref.normRef.heading.slice(0, 70) + (ref.normRef.heading.length > 70 ? '...' : '') : '—';
    console.log(`  [${ref.rank ?? '?'}] score=${ref.score ?? '—'} art=${ref.normRef?.articleNumber ?? ref.article_number ?? '—'} | ${heading}`);
    console.log(`      sourceId: ${sourceId}`);
  }
  console.log('');
  console.log('--- U10 Selection ---');
  if (u10Sel) {
    console.log('evidence_insufficient:', u10Sel.evidence_insufficient);
    console.log('triage_used:', u10Sel.triage_used, '| triage_model:', u10Sel.triage_model ?? '—');
    console.log('law_before:', Array.isArray(u10Sel.law_source_ids_before) ? (u10Sel.law_source_ids_before as unknown[]).length : '—');
    console.log('law_selected:', Array.isArray(u10Sel.law_source_ids_selected) ? (u10Sel.law_source_ids_selected as unknown[]).length : '—');
    console.log('law_final:', Array.isArray(u10Sel.law_source_ids_final) ? (u10Sel.law_source_ids_final as unknown[]).length : '—');
    if (Array.isArray(u10Sel.reasons) && (u10Sel.reasons as unknown[]).length > 0) {
      console.log('reasons:', u10Sel.reasons);
    }
  } else {
    console.log('(no u10_selection snapshot)');
  }
  console.log('');
  console.log('--- Summary ---');
  console.log('total refs:', lawRefs.length);
  if (ap?.sources && typeof ap.sources === 'object') {
    const src = ap.sources as Record<string, unknown>;
    console.log('sources.lawCount:', src.lawCount ?? '—');
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
