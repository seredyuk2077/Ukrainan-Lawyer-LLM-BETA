/**
 * U4 Family evidence scorer — runtime-only, PRIMARY_LAW acts from chunks evidence.
 * family_key = normalized category from taxonomy (no word→family dictionary).
 * Used for selected_acts coverage guard and low_confidence policy.
 */
import { classifyActKind } from './selected-acts.js';
import { incrementU4FamilyConflict, incrementU4FamilyWeakEvidence } from '../gateway/observability.js';

export type ChunksEvidenceItemInput = {
  rada_nreg: string;
  count_in_top30: number;
  avg_score_in_top30?: number;
  max_score: number;
};

export type ActMetaInput = {
  rada_nreg: string;
  title: string;
  category: string | null;
  document_type?: string | null;
  document_type_slug?: string | null;
};

const W_COUNT = 0.55;
const W_SCORE = 0.45;
const LOG1P_30 = Math.log1p(30);
const CONFLICT_DELTA = 0.08;
const CONFLICT_MIN_TOP2 = 0.35;
const WEAK_THRESHOLD = 0.45;

export type FamilyEvidenceReasonCode =
  | 'FAMILY_DOMINANT_OK'
  | 'FAMILY_WEAK_EVIDENCE'
  | 'FAMILY_CONFLICT'
  | 'NO_PRIMARY_LAW_EVIDENCE';

export type PerFamilyEvidence = {
  family_key: string;
  support_score: number;
  sources: { chunks: number; taxonomy: number; acts_search: number };
  dominant_primary_law_acts: number;
};

export type FamilyEvidence = {
  per_family: Record<string, PerFamilyEvidence>;
  dominant_family_key?: string;
  family_conflict: boolean;
  family_confidence: number;
  reason_codes: FamilyEvidenceReasonCode[];
  debug: { top_families: Array<{ family_key: string; support_score: number; acts_count: number }> };
};

function toKey(category: string): string {
  return (category ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim() || 'unknown';
}

export type ComputeFamilyEvidenceInput = {
  chunks_evidence_top_acts: ChunksEvidenceItemInput[];
  getActMeta: (rada_nreg: string) => Promise<ActMetaInput | null>;
};

/**
 * Compute family evidence from chunks evidence (PRIMARY_LAW acts only).
 * family_key = normalized category from taxonomy; support_score from count + max_score.
 */
export async function computeFamilyEvidence(input: ComputeFamilyEvidenceInput): Promise<FamilyEvidence> {
  const { chunks_evidence_top_acts, getActMeta } = input;

  const perFamilyRaw = new Map<
    string,
    { rawSum: number; chunksCount: number; actsCount: number }
  >();

  for (const e of chunks_evidence_top_acts) {
    const meta = await getActMeta(e.rada_nreg);
    if (!meta) continue;
    const kind = classifyActKind(
      meta.title,
      meta.document_type ?? undefined,
      meta.category ?? undefined,
      meta.document_type_slug ?? undefined
    );
    if (kind !== 'PRIMARY_LAW') continue;

    const family_key = toKey(meta.category ?? 'unknown');
    const countContrib = Math.log1p(e.count_in_top30) / LOG1P_30;
    const scoreContrib = Math.min(1, Math.max(0, e.max_score));
    const raw = W_COUNT * countContrib + W_SCORE * scoreContrib;

    const cur = perFamilyRaw.get(family_key) ?? { rawSum: 0, chunksCount: 0, actsCount: 0 };
    cur.rawSum += raw;
    cur.chunksCount += 1;
    cur.actsCount += 1;
    perFamilyRaw.set(family_key, cur);
  }

  const entries = [...perFamilyRaw.entries()];
  const maxRaw = entries.length > 0 ? Math.max(...entries.map(([, v]) => v.rawSum)) : 0;

  const per_family: Record<string, PerFamilyEvidence> = {};
  for (const [family_key, v] of entries) {
    const support_score = maxRaw > 0 ? v.rawSum / maxRaw : 0;
    per_family[family_key] = {
      family_key,
      support_score,
      sources: { chunks: v.chunksCount, taxonomy: 0, acts_search: 0 },
      dominant_primary_law_acts: v.actsCount,
    };
  }

  const sorted = entries
    .map(([k, v]) => ({
      family_key: k,
      support_score: maxRaw > 0 ? v.rawSum / maxRaw : 0,
      acts_count: v.actsCount,
    }))
    .sort((a, b) => b.support_score - a.support_score);

  const top1 = sorted[0];
  const top2 = sorted[1];
  const dominant_family_key = top1?.support_score > 0 ? top1.family_key : undefined;
  const family_confidence = top1?.support_score ?? 0;

  const family_conflict =
    !!top2 &&
    top2.support_score >= CONFLICT_MIN_TOP2 &&
    top2.support_score >= (top1?.support_score ?? 0) - CONFLICT_DELTA;

  const noPrimaryLaw = entries.length === 0;
  const weak = !noPrimaryLaw && family_confidence < WEAK_THRESHOLD;

  const reason_codes: FamilyEvidenceReasonCode[] = [];
  if (noPrimaryLaw) {
    reason_codes.push('NO_PRIMARY_LAW_EVIDENCE');
  } else {
    if (weak) reason_codes.push('FAMILY_WEAK_EVIDENCE');
    if (family_conflict) reason_codes.push('FAMILY_CONFLICT');
    if (!weak && !family_conflict) reason_codes.push('FAMILY_DOMINANT_OK');
  }

  if (family_conflict) incrementU4FamilyConflict();
  if (weak || noPrimaryLaw) incrementU4FamilyWeakEvidence();

  return {
    per_family,
    dominant_family_key,
    family_conflict,
    family_confidence,
    reason_codes,
    debug: {
      top_families: sorted.slice(0, 3),
    },
  };
}

export type FamilyEvidenceSummary = {
  dominant_family_key?: string;
  family_confidence: number;
  family_conflict: boolean;
  top2: Array<{ family_key: string; support_score: number }>;
};

export function toFamilyEvidenceSummary(evidence: FamilyEvidence): FamilyEvidenceSummary {
  const top2 = evidence.debug.top_families.slice(0, 2).map((t) => ({
    family_key: t.family_key,
    support_score: t.support_score,
  }));
  return {
    dominant_family_key: evidence.dominant_family_key,
    family_confidence: evidence.family_confidence,
    family_conflict: evidence.family_conflict,
    top2,
  };
}
