#!/usr/bin/env node
/**
 * Phase 5.1 — Weak-labeling for real retrieval dataset (read-only taxonomy + optional LLM).
 * Builds expectations: expected_act_families, expected_domains, must_have_multi_act, must_have_multi_goal.
 * LLM labeler only when heuristic_confidence < threshold (U4_LABELER_ENABLED, off by default).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { getTaxonomyCandidates } from '../../retrieval/act-taxonomy-store.js';
import { heuristicGoalSplit } from '../../retrieval/goal-splitter.js';
import { openRouterChat } from '../../lib/openrouter.js';
import { config } from '../../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LABELER_RESPONSE_SCHEMA = z.object({
  act_families: z.array(z.string()).min(0).max(5).optional().default([]),
  search_terms: z.array(z.string()).min(0).max(15).optional().default([]),
});

type LabelerResponse = z.infer<typeof LABELER_RESPONSE_SCHEMA>;

export interface ActFamilyExpectation {
  family_id: string;
  stems_or_signals: string[];
  confidence: number;
}

export interface LabeledExpectations {
  expected_act_families: ActFamilyExpectation[];
  expected_domains: string[];
  must_have_multi_act: boolean;
  must_have_multi_goal: boolean;
  heuristic_confidence: number;
  low_confidence: boolean;
  /** Alias for heuristic_confidence (for verifier hard/soft split). */
  expected_confidence?: number;
  /** Source of expected_act_families: taxonomy | heuristic | llm_labeler */
  expected_family_source?: 'taxonomy' | 'heuristic' | 'llm_labeler';
  labeler_used?: boolean;
  labeler_act_families?: string[];
  labeler_search_terms?: string[];
}

export interface RealQueryRow {
  run_id: string;
  query: string;
  created_at: string | null;
  tenant_id_hash: string;
  fingerprint: string;
  flags?: { domain?: string; [k: string]: unknown };
}

export interface LabeledRow extends RealQueryRow {
  expectations: LabeledExpectations;
}

function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function buildHeuristicExpectations(row: RealQueryRow): Promise<LabeledExpectations> {
  const domainHint = row.flags?.domain;
  const taxonomy = await getTaxonomyCandidates({
    query: row.query,
    domainHint,
  });
  const split = heuristicGoalSplit(row.query, domainHint, null);
  const goals = split.goals ?? [];
  const multiGoal = goals.length >= 2;
  const categories = new Set<string>();
  const signalsByCategory = new Map<string, string[]>();
  for (const h of taxonomy.alias_hits) {
    const cat = h.category ?? 'other';
    categories.add(cat);
    const list = signalsByCategory.get(cat) ?? [];
    if (h.alias && !list.includes(h.alias)) list.push(h.alias);
    signalsByCategory.set(cat, list);
  }
  for (const c of taxonomy.category_hints) {
    categories.add(c);
    if (!signalsByCategory.has(c)) signalsByCategory.set(c, []);
  }
  const expected_act_families: ActFamilyExpectation[] = [];
  for (const cat of categories) {
    const stems = signalsByCategory.get(cat) ?? [];
    const confidence = stems.length > 0 ? 0.85 : taxonomy.rada_nreg_candidates.length > 0 ? 0.6 : 0.3;
    expected_act_families.push({
      family_id: cat,
      stems_or_signals: stems.slice(0, 10),
      confidence,
    });
  }
  if (expected_act_families.length === 0 && taxonomy.category_hints.length > 0) {
    for (const c of taxonomy.category_hints) {
      expected_act_families.push({
        family_id: c,
        stems_or_signals: [],
        confidence: 0.5,
      });
    }
  }
  const expected_domains = [...new Set(taxonomy.category_hints)];
  const must_have_multi_act = categories.size >= 2 || taxonomy.rada_nreg_candidates.length >= 2;
  const heuristic_confidence =
    taxonomy.alias_hits.length > 0 && taxonomy.rada_nreg_candidates.length > 0
      ? 0.85
      : taxonomy.rada_nreg_candidates.length > 0
        ? 0.6
        : expected_domains.length > 0
          ? 0.5
          : 0.25;
  const low_confidence = heuristic_confidence < config.u4LabelerConfidenceThreshold;
  return {
    expected_act_families,
    expected_domains,
    must_have_multi_act,
    must_have_multi_goal: multiGoal,
    heuristic_confidence,
    low_confidence,
    expected_confidence: heuristic_confidence,
    expected_family_source: 'taxonomy',
  };
}

async function callLabeler(query: string, domainHint?: string): Promise<LabelerResponse | null> {
  const apiKey = config.openRouterApiKey || config.openRouterApiKeyRag;
  if (!apiKey) return null;
  const prompt = `Запит користувача з законодавства: "${query.slice(0, 1500)}"
${domainHint ? `Домен: ${domainHint}.` : ''}

Визнач (без номерів статей):
1. act_families — 1–3 найімовірніші акти/кодекси для відповіді (наприклад: criminal, criminal_procedure, civil, civil_procedure, tax_customs, administrative_offenses, labor_social, constitutional, anti_corruption).
2. search_terms — 3–8 термінів або синонімів для пошуку.

Поверни тільки JSON: {"act_families": ["..."], "search_terms": ["..."]}`;
  try {
    const res = await openRouterChat(
      apiKey,
      {
        model: config.u4LabelerModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: config.u4LabelerMaxTokens,
        caller: 'tools-label-retrieval',
      },
      Math.min(15, 10)
    );
    const jsonMatch = res.content.trim().match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : res.content.trim();
    const parsed = JSON.parse(jsonStr) as unknown;
    return LABELER_RESPONSE_SCHEMA.parse(parsed);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const jsonlPath = resolve(__dirname, '../_datasets', 'retrieval_real_queries.jsonl');
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, 'utf8');
  } catch (e) {
    console.error('[label-expectations] Run brain:dataset:retrieval-real first. Missing:', jsonlPath);
    process.exit(1);
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const rows: RealQueryRow[] = lines.map((l) => JSON.parse(l) as RealQueryRow);
  const labeled: LabeledRow[] = [];
  let labelerCalls = 0;
  for (const row of rows) {
    const expectations = await buildHeuristicExpectations(row);
    let final = { ...expectations };
    if (expectations.low_confidence && config.u4LabelerEnabled) {
      const llm = await callLabeler(row.query, row.flags?.domain);
      if (llm) {
        labelerCalls++;
        const mergedFamilies = [...expectations.expected_act_families];
        const existingIds = new Set(mergedFamilies.map((e) => e.family_id));
        for (const f of llm.act_families) {
          if (!existingIds.has(f)) {
            mergedFamilies.push({
              family_id: f,
              stems_or_signals: llm.search_terms ?? [],
              confidence: 0.6,
            });
            existingIds.add(f);
          }
        }
        final = {
          ...expectations,
          expected_act_families: mergedFamilies,
          expected_family_source: 'llm_labeler',
          labeler_used: true,
          labeler_act_families: llm.act_families,
          labeler_search_terms: llm.search_terms,
        };
      }
    }
    labeled.push({ ...row, expectations: final });
  }
  const outDir = resolve(__dirname, '../_datasets');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'retrieval_real_labeled.json');
  writeFileSync(outPath, JSON.stringify(labeled, null, 2), 'utf8');
  console.log('[label-expectations] wrote', labeled.length, 'rows to', outPath);
  if (labelerCalls > 0) console.log('[label-expectations] LLM labeler calls:', labelerCalls);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
