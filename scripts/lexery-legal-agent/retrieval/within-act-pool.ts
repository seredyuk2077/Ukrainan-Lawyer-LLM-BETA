import type { RawHit } from './types.js';

export interface BuildWithinActPoolInput {
  taxonomyNregs?: string[];
  actSearchNregs?: string[];
  bootstrapActNregs?: string[];
  chunkEvidenceNregs?: string[];
  plannerPreferredNregs?: string[];
  categoryHintCount?: number;
  preferChunkEvidence?: boolean;
  limit: number;
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

  return [...stats.entries()]
    .sort((left, right) => {
      const [, leftStats] = left;
      const [, rightStats] = right;
      const countDiff = rightStats.count - leftStats.count;
      if (countDiff !== 0) return countDiff;
      const scoreDiff = rightStats.bestScore - leftStats.bestScore;
      if (scoreDiff !== 0) return scoreDiff;
      return leftStats.firstIndex - rightStats.firstIndex;
    })
    .map(([radaNreg]) => radaNreg);
}

export function buildWithinActPool(input: BuildWithinActPoolInput): string[] {
  const {
    taxonomyNregs = [],
    actSearchNregs = [],
    bootstrapActNregs = [],
    chunkEvidenceNregs = [],
    plannerPreferredNregs = [],
    categoryHintCount = 0,
    preferChunkEvidence = false,
    limit,
  } = input;

  if (limit <= 0) return [];

  const evidenceFirstOrder = uniqueOrdered([
    ...chunkEvidenceNregs,
    ...bootstrapActNregs,
    ...actSearchNregs,
    ...taxonomyNregs,
  ]);

  const taxonomyLedOrder =
    categoryHintCount > 0
      ? uniqueOrdered([...taxonomyNregs, ...bootstrapActNregs, ...actSearchNregs, ...chunkEvidenceNregs])
      : uniqueOrdered([...bootstrapActNregs, ...actSearchNregs, ...chunkEvidenceNregs, ...taxonomyNregs]);

  const baseOrder =
    preferChunkEvidence && evidenceFirstOrder.length > 0 ? evidenceFirstOrder : taxonomyLedOrder;

  if (plannerPreferredNregs.length === 0) {
    return baseOrder.slice(0, limit);
  }

  const preferredSet = new Set(plannerPreferredNregs.map((nreg) => nreg.trim()).filter(Boolean));
  const preferred = baseOrder.filter((nreg) => preferredSet.has(nreg));
  const rest = baseOrder.filter((nreg) => !preferredSet.has(nreg));
  return [...preferred, ...rest].slice(0, limit);
}
