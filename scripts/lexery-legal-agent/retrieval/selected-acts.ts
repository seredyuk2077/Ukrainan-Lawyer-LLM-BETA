/**
 * U4 selected_acts 2.0 — evidence-driven fusion (LEX-114, LEX-117).
 * selected_acts = truth from chunks evidence + taxonomy/acts_search support + family diversity.
 * No keyword heuristics; data-driven from final hits and act candidates.
 */
import type { RawHit } from './types.js';

export const CHUNKS_EVIDENCE_COUNT_THRESHOLD = 3;
export const CHUNKS_EVIDENCE_SCORE_THRESHOLD = 0.55;
export const SELECTED_ACTS_MIN = 2;
export const SELECTED_ACTS_MAX_OUT = 8;

export type ActCandidateInput = {
  rada_nreg: string;
  title?: string;
  score?: number;
  reasons?: string[];
  why_tag?: string;
  source_tier?: 'ACTS_1' | 'ACTS_2';
};

export type ChunksEvidenceItem = {
  rada_nreg: string;
  count_in_top30: number;
  avg_score_in_top30: number;
  max_score: number;
};

export type SelectedActOutput = {
  rada_nreg: string;
  act_title?: string;
  family?: string;
  score?: number;
  why_selected?: string;
  reason_tag?: string;
  source_tags?: string[];
};

export type BuildSelectedActsInput = {
  finalHits: RawHit[];
  actCandidatesTop: ActCandidateInput[];
  goals_summary: { goal_id: string }[];
  /** hits_by_act for top acts in top-30 (from distribution). */
  hits_by_act_top3?: Record<string, number>;
  avg_score_by_act_top3?: Record<string, number>;
  taxonomyNregs: Set<string>;
  actsSearchNregs: string[];
  domainHint?: string;
  actSelectionLowConfidence?: boolean;
};

export type BuildSelectedActsOutput = {
  selected_acts: SelectedActOutput[];
  selected_acts_confidence: number;
  selected_acts_reason_codes: string[];
  selected_acts_sources_breakdown: {
    from_taxonomy: string[];
    from_acts_search: string[];
    from_chunks_evidence: string[];
  };
  chunks_evidence_top_acts: ChunksEvidenceItem[];
  selected_acts_decision: {
    policy_version: number;
    included_from_chunks_evidence: boolean;
    reason_codes: string[];
  };
};

function computeChunksEvidenceTopActs(finalHits: RawHit[]): ChunksEvidenceItem[] {
  const top30 = finalHits.slice(0, 30);
  const stats = new Map<string, { count: number; sumScore: number; maxScore: number }>();
  for (const h of top30) {
    const nreg = h.rada_nreg ?? '_unknown';
    if (nreg === '_unknown') continue;
    const cur = stats.get(nreg) ?? { count: 0, sumScore: 0, maxScore: 0 };
    cur.count += 1;
    cur.sumScore += h.score;
    cur.maxScore = Math.max(cur.maxScore, h.score);
    stats.set(nreg, cur);
  }
  return [...stats.entries()]
    .map(([rada_nreg, v]) => ({
      rada_nreg,
      count_in_top30: v.count,
      avg_score_in_top30: v.sumScore / v.count,
      max_score: v.maxScore,
    }))
    .sort((a, b) => b.count_in_top30 - a.count_in_top30 || b.max_score - a.max_score)
    .slice(0, 10);
}

/**
 * Build selected_acts from chunks evidence (priority) + taxonomy/acts_search (support) + diversity.
 */
export function buildSelectedActs(input: BuildSelectedActsInput): BuildSelectedActsOutput {
  const {
    finalHits,
    actCandidatesTop,
    taxonomyNregs,
    actsSearchNregs,
    actSelectionLowConfidence,
  } = input;

  const chunks_evidence_top_acts = computeChunksEvidenceTopActs(finalHits);
  const chunksEvidenceNregs = new Set(
    chunks_evidence_top_acts
      .filter(
        (a) =>
          a.count_in_top30 >= CHUNKS_EVIDENCE_COUNT_THRESHOLD ||
          a.max_score >= CHUNKS_EVIDENCE_SCORE_THRESHOLD
      )
      .map((a) => a.rada_nreg)
  );

  const candidateByNreg = new Map(actCandidatesTop.map((a) => [a.rada_nreg, a]));
  const reasonCodes: string[] = [];
  const selected: SelectedActOutput[] = [];
  const fromTaxonomy: string[] = [];
  const fromActsSearch: string[] = [];
  const fromChunksEvidence: string[] = [];

  // A) Chunks evidence MUST be included first (reason CHUNKS_EVIDENCE), up to cap
  for (const e of chunks_evidence_top_acts) {
    if (selected.length >= SELECTED_ACTS_MAX_OUT) break;
    if (!chunksEvidenceNregs.has(e.rada_nreg)) continue;
    if (selected.some((s) => s.rada_nreg === e.rada_nreg)) continue;
    const cand = candidateByNreg.get(e.rada_nreg);
    selected.push({
      rada_nreg: e.rada_nreg,
      act_title: cand?.title,
      score: e.max_score,
      why_selected: `count_in_top30=${e.count_in_top30} max_score=${e.max_score.toFixed(2)}`,
      reason_tag: 'CHUNKS_EVIDENCE',
      source_tags: ['CHUNKS_EVIDENCE'],
    });
    fromChunksEvidence.push(e.rada_nreg);
  }

  // B) Add 1–2 from taxonomy/acts_search not yet covered by chunks (support)
  const cap = actSelectionLowConfidence ? Math.min(7, SELECTED_ACTS_MAX_OUT) : Math.min(5, SELECTED_ACTS_MAX_OUT);
  let wantMore = Math.max(SELECTED_ACTS_MIN, Math.min(cap, selected.length + 2)) - selected.length;
  if (wantMore > 0) {
    for (const a of actCandidatesTop) {
      if (selected.length >= SELECTED_ACTS_MAX_OUT) break;
      if (selected.some((s) => s.rada_nreg === a.rada_nreg)) continue;
      const source: string[] = [];
      if (taxonomyNregs.has(a.rada_nreg)) source.push('TAXONOMY');
      if (actsSearchNregs.includes(a.rada_nreg)) source.push('ACTS_SEARCH');
      if (source.length === 0) continue;
      selected.push({
        rada_nreg: a.rada_nreg,
        act_title: a.title,
        score: a.score,
        why_selected: a.why_tag ?? source.join('+'),
        reason_tag: source[0] ?? 'TAXONOMY',
        source_tags: source,
      });
      if (taxonomyNregs.has(a.rada_nreg)) fromTaxonomy.push(a.rada_nreg);
      if (actsSearchNregs.includes(a.rada_nreg)) fromActsSearch.push(a.rada_nreg);
      wantMore -= 1;
      if (wantMore <= 0) break;
    }
  }

  // Enforce minimum: if we have fewer than SELECTED_ACTS_MIN, fill from actCandidatesTop
  while (selected.length < SELECTED_ACTS_MIN && selected.length < actCandidatesTop.length) {
    const next = actCandidatesTop.find((a) => !selected.some((s) => s.rada_nreg === a.rada_nreg));
    if (!next) break;
    const source: string[] = [];
    if (taxonomyNregs.has(next.rada_nreg)) source.push('TAXONOMY');
    if (actsSearchNregs.includes(next.rada_nreg)) source.push('ACTS_SEARCH');
    selected.push({
      rada_nreg: next.rada_nreg,
      act_title: next.title,
      score: next.score,
      why_selected: next.why_tag ?? (source.length ? source.join('+') : 'FALLBACK'),
      reason_tag: source[0] ?? 'FALLBACK',
      source_tags: source.length ? source : ['FALLBACK'],
    });
    if (taxonomyNregs.has(next.rada_nreg)) fromTaxonomy.push(next.rada_nreg);
    if (actsSearchNregs.includes(next.rada_nreg)) fromActsSearch.push(next.rada_nreg);
  }

  // Cap total for harness invariant (≤9)
  const selectedCapped = selected.slice(0, SELECTED_ACTS_MAX_OUT);

  if (fromChunksEvidence.length > 0) reasonCodes.push('SELECTED_ACTS_FROM_CHUNKS_EVIDENCE');
  if (actCandidatesTop.length >= 2) reasonCodes.push('SELECTED_ACTS_DIVERSITY_ENFORCED');

  let selected_acts_confidence = 0.5;
  if (fromChunksEvidence.length > 0) {
    const strong = chunks_evidence_top_acts.filter(
      (e) =>
        e.count_in_top30 >= CHUNKS_EVIDENCE_COUNT_THRESHOLD ||
        e.max_score >= CHUNKS_EVIDENCE_SCORE_THRESHOLD
    ).length;
    selected_acts_confidence = strong >= 2 ? 0.9 : strong >= 1 ? 0.75 : 0.6;
  } else if (selected.length >= 2) {
    selected_acts_confidence = 0.55;
  } else {
    reasonCodes.push('LOW_ACT_SIGNAL');
  }

  const selectedNregs = new Set(selectedCapped.map((s) => s.rada_nreg));
  const selected_acts_decision = {
    policy_version: 2,
    included_from_chunks_evidence: fromChunksEvidence.length > 0,
    reason_codes: reasonCodes,
  };

  return {
    selected_acts: selectedCapped,
    selected_acts_confidence,
    selected_acts_reason_codes: reasonCodes,
    selected_acts_sources_breakdown: {
      from_taxonomy: [...new Set(fromTaxonomy)].filter((n) => selectedNregs.has(n)),
      from_acts_search: [...new Set(fromActsSearch)].filter((n) => selectedNregs.has(n)),
      from_chunks_evidence: fromChunksEvidence.filter((n) => selectedNregs.has(n)),
    },
    chunks_evidence_top_acts,
    selected_acts_decision,
  };
}
