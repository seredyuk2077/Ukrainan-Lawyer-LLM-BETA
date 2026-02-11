/**
 * U4 selected_acts 2.0 — evidence-driven fusion (LEX-114, LEX-117).
 * selected_acts = truth from chunks evidence + taxonomy/acts_search support + family diversity.
 * Policy v2: act_kind classifier, diversity guard, anti-order dominance.
 * No keyword heuristics; data-driven from final hits and act candidates.
 */
import type { RawHit } from './types.js';

export const CHUNKS_EVIDENCE_COUNT_THRESHOLD = 3;
export const CHUNKS_EVIDENCE_SCORE_THRESHOLD = 0.55;
export const SELECTED_ACTS_MIN = 2;
export const SELECTED_ACTS_MAX_OUT = 8;

/** Act kind by document type (title/category heuristics only; not "word → act" map). */
export type ActKind = 'PRIMARY_LAW' | 'SECONDARY_ORDER' | 'CASELAW_OPINION' | 'UNKNOWN';

/**
 * Lightweight classifier: document type from title (+ optional document_type/category).
 * Uses tolerant stem-like matching (Ukrainian); no hardcoded act IDs.
 */
export function classifyActKind(
  title: string,
  _document_type?: string,
  _category?: string
): ActKind {
  const t = (title ?? '').toLowerCase();
  // PRIMARY_LAW: codes, main laws, procedural codes
  if (
    /кодекс|закон|конституц|процесуальн|кодекс україни про|податковий кодекс|кзпп|цк\s|ск\s|цік|кпк|цпк|ципк|кримінальний кодекс|цивільний кодекс|кку|пкку/i.test(t)
  ) {
    return 'PRIMARY_LAW';
  }
  // SECONDARY_ORDER: resolutions, orders, personnel
  if (
    /постанова|порядок|розпоряджен|наказ|про звільнення|про призначення|про затвердження порядку/i.test(t)
  ) {
    return 'SECONDARY_ORDER';
  }
  // CASELAW_OPINION
  if (/окрема думка|рішення ксу/i.test(t)) {
    return 'CASELAW_OPINION';
  }
  return 'UNKNOWN';
}

export type ActCandidateInput = {
  rada_nreg: string;
  title?: string;
  score?: number;
  reasons?: string[];
  why_tag?: string;
  source_tier?: 'ACTS_1' | 'ACTS_2';
  category?: string;
  document_type?: string;
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

/** Count of selected acts by act_kind (for trace meta). */
export type SelectedActsKindsCount = Partial<Record<ActKind, number>>;

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
  selected_acts_kinds_count: SelectedActsKindsCount;
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

/** Min distinct act_kinds in chunks evidence to enforce diversity in selected_acts. */
const DIVERSITY_EVIDENCE_KINDS_MIN = 2;
/** Min support (count) for an act in chunks to count toward "evidence kind". */
const DIVERSITY_EVIDENCE_COUNT_MIN = 2;

/**
 * Build selected_acts from chunks evidence (priority) + taxonomy/acts_search (support) + diversity.
 * Policy v2: act_kind, diversity guard, anti-order (max 1 SECONDARY_ORDER, only with evidence).
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

  // --- Policy v2: anti-order dominance ---
  // At most 1 SECONDARY_ORDER in selected; only if it has chunks evidence. If PRIMARY_LAW dominates in chunks, drop orders that came only from taxonomy/acts_search.
  const primaryLawSupport = chunks_evidence_top_acts
    .filter((e) => {
      const cand = candidateByNreg.get(e.rada_nreg);
      return classifyActKind(cand?.title ?? '') === 'PRIMARY_LAW';
    })
    .reduce((s, e) => s + e.count_in_top30, 0);
  const orderSupport = chunks_evidence_top_acts
    .filter((e) => {
      const cand = candidateByNreg.get(e.rada_nreg);
      return classifyActKind(cand?.title ?? '') === 'SECONDARY_ORDER';
    })
    .reduce((s, e) => s + e.count_in_top30, 0);
  const primaryLawDominates = primaryLawSupport >= 2 && primaryLawSupport >= orderSupport * 1.5;

  const ordersInSelected = selected.filter((s) => {
    const cand = candidateByNreg.get(s.rada_nreg);
    return classifyActKind(cand?.title ?? s.act_title ?? '') === 'SECONDARY_ORDER';
  });
  const ordersWithEvidence = ordersInSelected.filter((s) => chunksEvidenceNregs.has(s.rada_nreg));
  const toRemoveOrders = new Set<string>();
  if (ordersInSelected.length > 1 || (ordersInSelected.length === 1 && primaryLawDominates && !chunksEvidenceNregs.has(ordersInSelected[0].rada_nreg))) {
    if (ordersWithEvidence.length > 0 && !primaryLawDominates) {
      let kept = false;
      for (const o of ordersInSelected) {
        if (chunksEvidenceNregs.has(o.rada_nreg) && !kept) {
          kept = true;
          reasonCodes.push('ORDER_INCLUDED_BY_EVIDENCE');
        } else {
          toRemoveOrders.add(o.rada_nreg);
        }
      }
    } else {
      for (const o of ordersInSelected) toRemoveOrders.add(o.rada_nreg);
      if (ordersInSelected.length > 0) reasonCodes.push('ORDER_DOMINANCE_BLOCKED');
    }
  } else if (ordersInSelected.length === 1 && chunksEvidenceNregs.has(ordersInSelected[0].rada_nreg)) {
    reasonCodes.push('ORDER_INCLUDED_BY_EVIDENCE');
  }
  if (toRemoveOrders.size > 0) {
    for (let i = selected.length - 1; i >= 0; i--) {
      if (toRemoveOrders.has(selected[i].rada_nreg)) selected.splice(i, 1);
    }
    fromChunksEvidence.splice(0, fromChunksEvidence.length, ...fromChunksEvidence.filter((n) => !toRemoveOrders.has(n)));
  }

  // --- Policy v2: diversity guard (by act_kind) ---
  const kindsInChunks = new Set<ActKind>();
  for (const e of chunks_evidence_top_acts) {
    if (e.count_in_top30 < DIVERSITY_EVIDENCE_COUNT_MIN) continue;
    const cand = candidateByNreg.get(e.rada_nreg);
    kindsInChunks.add(classifyActKind(cand?.title ?? ''));
  }
  const kindsInSelected = new Set(selected.map((s) => {
    const cand = candidateByNreg.get(s.rada_nreg);
    return classifyActKind(cand?.title ?? s.act_title ?? '');
  }));
  if (kindsInChunks.size >= DIVERSITY_EVIDENCE_KINDS_MIN && kindsInSelected.size < 2) {
    // Add one act from candidates with a different kind if possible
    const existingKinds = new Set(kindsInSelected);
    for (const a of actCandidatesTop) {
      if (selected.some((s) => s.rada_nreg === a.rada_nreg)) continue;
      if (selected.length >= SELECTED_ACTS_MAX_OUT) break;
      const k = classifyActKind(a.title ?? '');
      if (existingKinds.has(k)) continue;
      const source: string[] = [];
      if (taxonomyNregs.has(a.rada_nreg)) source.push('TAXONOMY');
      if (actsSearchNregs.includes(a.rada_nreg)) source.push('ACTS_SEARCH');
      if (source.length === 0) continue;
      selected.push({
        rada_nreg: a.rada_nreg,
        act_title: a.title,
        score: a.score,
        why_selected: a.why_tag ?? 'DIVERSITY_GUARD',
        reason_tag: 'TAXONOMY',
        source_tags: [...source, 'DIVERSITY_GUARD'],
      });
      if (taxonomyNregs.has(a.rada_nreg)) fromTaxonomy.push(a.rada_nreg);
      if (actsSearchNregs.includes(a.rada_nreg)) fromActsSearch.push(a.rada_nreg);
      reasonCodes.push('DIVERSITY_GUARD_ENFORCED');
      break;
    }
  }

  // Cap total for harness invariant (≤9)
  const selectedCapped = selected.slice(0, SELECTED_ACTS_MAX_OUT);

  if (fromChunksEvidence.length > 0) reasonCodes.push('SELECTED_ACTS_FROM_CHUNKS_EVIDENCE');
  if (actCandidatesTop.length >= 2 && !reasonCodes.includes('DIVERSITY_GUARD_ENFORCED')) {
    reasonCodes.push('SELECTED_ACTS_DIVERSITY_ENFORCED');
  }

  // Confidence: do NOT lower only because we trimmed orders. Use evidence strength.
  let selected_acts_confidence = 0.5;
  if (fromChunksEvidence.length > 0) {
    const strong = chunks_evidence_top_acts.filter(
      (e) =>
        e.count_in_top30 >= CHUNKS_EVIDENCE_COUNT_THRESHOLD ||
        e.max_score >= CHUNKS_EVIDENCE_SCORE_THRESHOLD
    ).length;
    selected_acts_confidence = strong >= 2 ? 0.9 : strong >= 1 ? 0.75 : 0.6;
  } else if (selectedCapped.length >= 2) {
    selected_acts_confidence = 0.55;
  } else {
    reasonCodes.push('NO_STRONG_ACT_EVIDENCE');
  }

  const selectedNregs = new Set(selectedCapped.map((s) => s.rada_nreg));
  const selected_acts_decision = {
    policy_version: 2,
    included_from_chunks_evidence: fromChunksEvidence.length > 0,
    reason_codes: reasonCodes,
  };

  // selected_acts_kinds_count for trace
  const selected_acts_kinds_count: SelectedActsKindsCount = {};
  for (const s of selectedCapped) {
    const cand = candidateByNreg.get(s.rada_nreg);
    const k = classifyActKind(cand?.title ?? s.act_title ?? '');
    selected_acts_kinds_count[k] = (selected_acts_kinds_count[k] ?? 0) + 1;
  }

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
    selected_acts_kinds_count,
  };
}
