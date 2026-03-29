import { normalizeStructuredActIdentifier } from '../lib/structured-act-identifier.js';

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

export function compareTrimEvidence(
  left: {
    score?: number;
    rankMassTop30?: number;
    bestRankInTop30?: number;
  },
  right: {
    score?: number;
    rankMassTop30?: number;
    bestRankInTop30?: number;
  }
): number {
  const rankMassDiff = (right.rankMassTop30 ?? 0) - (left.rankMassTop30 ?? 0);
  if (rankMassDiff !== 0) return rankMassDiff;
  const bestRankDiff =
    (left.bestRankInTop30 ?? Number.POSITIVE_INFINITY) - (right.bestRankInTop30 ?? Number.POSITIVE_INFINITY);
  if (bestRankDiff !== 0) return bestRankDiff;
  return (right.score ?? 0) - (left.score ?? 0);
}

export function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export function removeReasonCodes(reasonCodes: string[], codesToRemove: string[]): string[] {
  const blocked = new Set(codesToRemove);
  return reasonCodes.filter((code) => !blocked.has(code));
}

export function normalizeRadaNreg(value: string | null | undefined): string {
  const raw = String(value ?? '').normalize('NFC').trim();
  if (!raw) return '';
  const normalized = normalizeStructuredActIdentifier(raw);
  return normalized || raw.toLowerCase();
}

export function sameRadaNreg(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeRadaNreg(left);
  const normalizedRight = normalizeRadaNreg(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

export function buildNormalizedNregMap<T extends { rada_nreg?: string | null }>(items: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    const key = normalizeRadaNreg(item.rada_nreg);
    if (!key || out.has(key)) continue;
    out.set(key, item);
  }
  return out;
}

export function getByNormalizedNreg<T>(
  map: Map<string, T>,
  radaNreg: string | null | undefined
): T | undefined {
  const key = normalizeRadaNreg(radaNreg);
  return key ? map.get(key) : undefined;
}
