import type { RawHit } from './types.js';

export interface BuildWithinActPoolInput {
  groundedNregs?: string[];
  taxonomyNregs?: string[];
  actSearchNregs?: string[];
  bootstrapActNregs?: string[];
  chunkEvidenceNregs?: string[];
  plannerPreferredNregs?: string[];
  categoryHintCount?: number;
  preferChunkEvidence?: boolean;
  explicitActScopeCue?: boolean;
  limit: number;
}

export interface ChunkEvidenceActSummary {
  ordered_nregs: string[];
  act_count: number;
  top_nreg: string | null;
  top_hit_count: number;
  top_best_score: number | null;
}

function uniqueOrdered(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function extractActSearchNregsFromHits(hits: Array<Pick<RawHit, 'source' | 'rada_nreg'>>): string[] {
  return uniqueOrdered(
    hits
      .filter((hit) => hit.source === 'lldbi_acts')
      .map((hit) => hit.rada_nreg)
  );
}

export function extractChunkEvidenceNregsFromHits(
  hits: Array<Pick<RawHit, 'source' | 'rada_nreg' | 'score'>>
): string[] {
  return summarizeChunkEvidenceActs(hits).ordered_nregs;
}

export function summarizeChunkEvidenceActs(
  hits: Array<Pick<RawHit, 'source' | 'rada_nreg' | 'score'>>
): ChunkEvidenceActSummary {
  const stats = new Map<string, { count: number; bestScore: number; firstIndex: number }>();
  hits.forEach((hit, index) => {
    if (hit.source !== 'lldbi_chunks') return;
    const radaNreg = hit.rada_nreg?.trim();
    if (!radaNreg) return;
    const current = stats.get(radaNreg) ?? {
      count: 0,
      bestScore: Number.NEGATIVE_INFINITY,
      firstIndex: index,
    };
    current.count += 1;
    current.bestScore = Math.max(current.bestScore, hit.score ?? Number.NEGATIVE_INFINITY);
    current.firstIndex = Math.min(current.firstIndex, index);
    stats.set(radaNreg, current);
  });

  const ordered = [...stats.entries()]
    .sort((left, right) => {
      const [, leftStats] = left;
      const [, rightStats] = right;
      const countDiff = rightStats.count - leftStats.count;
      if (countDiff !== 0) return countDiff;
      const scoreDiff = rightStats.bestScore - leftStats.bestScore;
      if (scoreDiff !== 0) return scoreDiff;
      return leftStats.firstIndex - rightStats.firstIndex;
    })
    .map(([radaNreg, value]) => ({ radaNreg, value }));
  const topEntry = ordered[0];
  const topBestScore = topEntry?.value.bestScore;
  return {
    ordered_nregs: ordered.map((entry) => entry.radaNreg),
    act_count: ordered.length,
    top_nreg: topEntry?.radaNreg ?? null,
    top_hit_count: topEntry?.value.count ?? 0,
    top_best_score:
      typeof topBestScore === 'number' && Number.isFinite(topBestScore) ? topBestScore : null,
  };
}

export function buildWithinActPool(input: BuildWithinActPoolInput): string[] {
  const {
    groundedNregs = [],
    taxonomyNregs = [],
    actSearchNregs = [],
    bootstrapActNregs = [],
    chunkEvidenceNregs = [],
    plannerPreferredNregs = [],
    categoryHintCount = 0,
    preferChunkEvidence = false,
    explicitActScopeCue = false,
    limit,
  } = input;

  if (limit <= 0) return [];

  const groundedSingleAct = groundedNregs.length === 1 ? groundedNregs : [];

  const evidenceFirstOrder = uniqueOrdered([
    ...groundedSingleAct,
    ...chunkEvidenceNregs,
    ...bootstrapActNregs,
    ...actSearchNregs,
    ...taxonomyNregs,
  ]);

  const taxonomyLedOrder =
    categoryHintCount > 0
      ? uniqueOrdered([
          ...groundedSingleAct,
          ...taxonomyNregs,
          ...bootstrapActNregs,
          ...actSearchNregs,
          ...chunkEvidenceNregs,
        ])
      : uniqueOrdered([
          ...groundedSingleAct,
          ...bootstrapActNregs,
          ...actSearchNregs,
          ...chunkEvidenceNregs,
          ...taxonomyNregs,
        ]);

  const explicitActScopeOrder =
    explicitActScopeCue && groundedSingleAct.length === 0 && taxonomyNregs.length > 0
      ? uniqueOrdered([
          ...taxonomyNregs,
          ...bootstrapActNregs,
          ...actSearchNregs,
          ...chunkEvidenceNregs,
        ])
      : [];

  const baseOrder =
    explicitActScopeOrder.length > 0
      ? explicitActScopeOrder
      : preferChunkEvidence && evidenceFirstOrder.length > 0
        ? evidenceFirstOrder
        : taxonomyLedOrder;

  if (plannerPreferredNregs.length === 0) {
    return baseOrder.slice(0, limit);
  }

  const preferredSet = new Set(plannerPreferredNregs.map((nreg) => nreg.trim()).filter(Boolean));
  const preferred = baseOrder.filter((nreg) => preferredSet.has(nreg));
  const rest = baseOrder.filter((nreg) => !preferredSet.has(nreg));
  return [...preferred, ...rest].slice(0, limit);
}
