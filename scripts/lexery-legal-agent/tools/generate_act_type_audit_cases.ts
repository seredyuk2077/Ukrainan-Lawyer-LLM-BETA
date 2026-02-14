#!/usr/bin/env node
/**
 * Phase 1.2 — Generate act-type audit test cases from snapshot (2–3 per act, max 60).
 * A) Explicit act mention; B) Implicit domain; C) "What does it say about X".
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Shape of act entry in act_type_audit_snapshot.json (no runtime import from dataset script). */
interface SnapshotAct {
  rada_nreg: string;
  title: string;
  document_type: string | null;
  category: string | null;
  act_kind: string;
  aliases_sample: string[];
  topics_sample: string[];
  keywords_sample: string[];
}

const MAX_CASES_TOTAL = 60;
const MAX_PER_ACT = 3;

export type AssertionLevel = 'A_explicit_act' | 'B_implicit_category' | 'C_within_act';

export interface ActTypeAuditCase {
  id: string;
  query: string;
  rada_nreg: string;
  act_kind: string;
  category: string | null;
  assertion: AssertionLevel;
  /** For B: expect at least one act from same category/family. For C: expect chunks from this rada_nreg. */
  expect_in_selected_or_evidence?: boolean;
}

interface SnapshotFile {
  acts?: SnapshotAct[];
}

function pickSignal(act: SnapshotAct): string {
  const cand = [...act.keywords_sample, ...act.topics_sample, ...act.aliases_sample].filter(Boolean);
  if (cand.length) return cand[0];
  const words = act.title.split(/\s+/).filter((w) => w.length > 2 && !/^(\d+|та|і|у|в|на|про|для|зі|за)$/i.test(w));
  return words[1] ?? words[0] ?? act.rada_nreg;
}

function main(): void {
  const path = resolve(__dirname, '_datasets', 'act_type_audit_snapshot.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error('[generate_act_type_audit_cases] Run brain:dataset:act-type-audit first');
    process.exit(1);
  }
  const data = JSON.parse(raw) as SnapshotFile;
  const acts = data.acts ?? [];
  if (acts.length === 0) {
    console.error('[generate_act_type_audit_cases] No acts in snapshot');
    process.exit(1);
  }

  const cases: ActTypeAuditCase[] = [];
  for (let i = 0; i < acts.length && cases.length < MAX_CASES_TOTAL; i++) {
    const act = acts[i];
    const prefix = `act_type_audit_${i}`;

    // A) Explicit act mention
    const explicitQuery = act.aliases_sample[0] ?? act.title.slice(0, 120);
    cases.push({
      id: `${prefix}_explicit`,
      query: explicitQuery.length > 20 ? `Що регулює ${explicitQuery}?` : explicitQuery,
      rada_nreg: act.rada_nreg,
      act_kind: act.act_kind,
      category: act.category,
      assertion: 'A_explicit_act',
      expect_in_selected_or_evidence: true,
    });
    if (cases.length >= MAX_CASES_TOTAL) break;

    // B) Implicit domain (no act name; domain from signals)
    const signal = pickSignal(act);
    const implicitQuery = act.keywords_sample.length
      ? `Питання з галузі: ${act.keywords_sample[0]}`
      : act.topics_sample.length
        ? `Регулювання питань ${act.topics_sample[0]}`
        : `Норми про ${signal}`;
    cases.push({
      id: `${prefix}_implicit`,
      query: implicitQuery,
      rada_nreg: act.rada_nreg,
      act_kind: act.act_kind,
      category: act.category,
      assertion: 'B_implicit_category',
      expect_in_selected_or_evidence: true,
    });
    if (cases.length >= MAX_CASES_TOTAL) break;

    // C) "What does it say about X"
    const x = pickSignal(act);
    cases.push({
      id: `${prefix}_within`,
      query: `Що сказано про ${x}?`,
      rada_nreg: act.rada_nreg,
      act_kind: act.act_kind,
      category: act.category,
      assertion: 'C_within_act',
      expect_in_selected_or_evidence: true,
    });
  }

  const truncated = cases.slice(0, MAX_CASES_TOTAL);
  mkdirSync(resolve(__dirname, '_datasets'), { recursive: true });
  writeFileSync(
    resolve(__dirname, '_datasets', 'act_type_audit_cases.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), cases: truncated }, null, 2),
    'utf8'
  );
  console.log('[generate_act_type_audit_cases] wrote _datasets/act_type_audit_cases.json, cases=', truncated.length);
}

main();
