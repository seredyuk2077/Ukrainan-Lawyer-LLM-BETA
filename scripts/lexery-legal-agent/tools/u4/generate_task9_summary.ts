#!/usr/bin/env node
/**
 * One-off: з дампу task9_runs_dump_YYYY-MM-DD.json згенерувати task9_runs_summary_YYYY-MM-DD.md
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const reportDir = resolve(process.cwd(), 'scripts/lexery-legal-agent/tools/_reports');
const date = new Date().toISOString().slice(0, 10);
const dumpPath = resolve(reportDir, `task9_runs_dump_${date}.json`);
const outPath = resolve(reportDir, `task9_runs_summary_${date}.md`);

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const expectedDomain: Record<number, string> = {
  1: 'healthcare', 2: 'civil', 3: 'civil', 4: 'civil', 5: 'civil', 6: 'civil', 7: 'civil',
  8: 'education', 9: 'civil', 10: 'criminal', 11: 'criminal', 12: 'criminal', 13: 'criminal',
  14: 'criminal', 15: 'criminal', 16: 'criminal', 17: 'criminal', 18: 'criminal',
  19: 'civil', 20: 'civil', 21: 'civil', 22: 'civil', 23: 'civil', 24: 'civil',
};

const lines: string[] = [
  `# Task9 runs summary (${date})`,
  '',
  'Джерело: `task9_runs_dump_' + date + '.json`.',
  '',
  '| idx | query (short) | run_id | U2 domain / domainHint | lldbi cat / doc_type | selected_acts (rada/kind/cat) | low_conf | reason_codes | вердикт | root-cause bucket |',
  '|-----|---------------|--------|------------------------|----------------------|------------------------------|---------|--------------|---------|-------------------|',
];

for (const r of dump.runs as Array<{
  task_index: number;
  run_id: string;
  query_preview: string;
  query_profile?: { domain?: string; domainHint?: string; lldbi?: { categories_ranked_top3?: string[]; document_types_ranked_top3?: string[] }; meta?: { domain?: string } };
  selected_acts?: Array<{ rada_nreg?: string; act_kind?: string; category?: string; document_type?: string }>;
  low_confidence?: boolean;
  reason_codes?: string[];
}>) {
  const d = r.query_profile?.domain ?? r.query_profile?.meta?.domain ?? '—';
  const h = r.query_profile?.domainHint ?? '—';
  const cat = (r.query_profile?.lldbi?.categories_ranked_top3 ?? [])?.slice(0, 2).join(', ') || '—';
  const doc = (r.query_profile?.lldbi?.document_types_ranked_top3 ?? [])?.slice(0, 2).join(', ') || '—';
  const sel = (r.selected_acts ?? []).map((a) => `${a.rada_nreg ?? '—'}/${(a.act_kind ?? '').slice(0, 4)}/${(a.category ?? '').slice(0, 8)}`).join('; ');
  const exp = expectedDomain[r.task_index] ?? '';
  const hintOk = !exp || h === exp || (exp === 'criminal' && (d === 'criminal' || cat?.includes('criminal'))) || (exp === 'civil' && (d === 'civil' || cat?.includes('civil'))) || (exp === 'education' && (h === 'education_science' || cat?.includes('education'))) || (exp === 'healthcare' && (h === 'healthcare' || cat?.includes('health')));
  let verdict = 'OK';
  if (r.selected_acts?.length <= 1) verdict = 'FAIL';
  else if (!hintOk && r.task_index >= 10 && r.task_index <= 18) verdict = 'FAIL';
  else if (r.low_confidence && (r.selected_acts?.length ?? 0) <= 2) verdict = 'PARTIAL';
  else if (r.low_confidence || !hintOk) verdict = 'PARTIAL';
  let bucket = '—';
  if (verdict === 'FAIL') {
    if (!hintOk && r.task_index >= 10 && r.task_index <= 18) bucket = 'U2 domain/routing';
    else if (r.selected_acts?.length <= 1) bucket = 'U4 taxonomy / selected-acts policy';
  } else if (verdict === 'PARTIAL') bucket = 'ranking / selected-acts / metadata';
  const shortQuery = (r.query_preview ?? '').replace(/\n/g, ' ').slice(0, 50) + '…';
  const reasons = (r.reason_codes ?? []).slice(0, 2).join(', ') || '—';
  lines.push(`| ${r.task_index} | ${shortQuery} | ${r.run_id?.slice(0, 8)}… | ${d} / ${h} | ${cat} / ${doc} | ${sel.slice(0, 80)} | ${r.low_confidence ?? false} | ${reasons} | ${verdict} | ${bucket} |`);
}

lines.push('', '---', '', '**Легенда:** OK = writer може відповісти; PARTIAL = база є, ranking/coverage шумить; FAIL = ключовий акт/домен відсутні.');
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log('Wrote', outPath);
