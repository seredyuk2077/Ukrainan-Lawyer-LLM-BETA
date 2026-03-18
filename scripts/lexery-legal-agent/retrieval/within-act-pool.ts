import type { RawHit } from './types.js';

export interface BuildWithinActPoolInput {
  taxonomyNregs?: string[];
  actSearchNregs?: string[];
  bootstrapActNregs?: string[];
  plannerPreferredNregs?: string[];
  categoryHintCount?: number;
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

export function buildWithinActPool(input: BuildWithinActPoolInput): string[] {
  const {
    taxonomyNregs = [],
    actSearchNregs = [],
    bootstrapActNregs = [],
    plannerPreferredNregs = [],
    categoryHintCount = 0,
    limit,
  } = input;

  const baseOrder =
    categoryHintCount > 0
      ? uniqueOrdered([...taxonomyNregs, ...bootstrapActNregs, ...actSearchNregs])
      : uniqueOrdered([...bootstrapActNregs, ...actSearchNregs, ...taxonomyNregs]);

  if (plannerPreferredNregs.length === 0) {
    return baseOrder.slice(0, limit);
  }

  const preferredSet = new Set(plannerPreferredNregs.map((nreg) => nreg.trim()).filter(Boolean));
  const preferred = baseOrder.filter((nreg) => preferredSet.has(nreg));
  const rest = baseOrder.filter((nreg) => !preferredSet.has(nreg));
  return [...preferred, ...rest].slice(0, limit);
}
