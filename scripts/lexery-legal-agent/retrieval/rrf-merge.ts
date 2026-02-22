/**
 * Reciprocal Rank Fusion (RRF) — standard RAG technique for multi-query retrieval.
 * Merges ranked lists from multiple queries into one, improving recall for synonym/paraphrase variants.
 * No hardcoded terms; purely algorithmic.
 * Ref: Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
 */
const RRF_K = 60;

export type RankedItemWithKey<T> = {
  item: T;
  key: string;
  score: number;
};

/**
 * Merge multiple ranked lists using RRF. Each list is sorted by relevance (best first).
 * Returns merged list sorted by RRF score descending. For items appearing in multiple lists,
 * the original score is taken as the max across all lists (for downstream 0–1 score semantics).
 */
export function rrfMerge<T>(
  rankedLists: T[][],
  keyFn: (item: T) => string,
  scoreFn: (item: T) => number,
  k: number = RRF_K
): T[] {
  if (rankedLists.length === 0) return [];
  if (rankedLists.length === 1 && rankedLists[0].length > 0) return rankedLists[0];

  const rrfScores = new Map<string, { rrf: number; maxScore: number; item: T }>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const key = keyFn(item);
      const score = scoreFn(item);
      const contrib = 1 / (k + rank + 1);
      const existing = rrfScores.get(key);
      if (!existing) {
        rrfScores.set(key, { rrf: contrib, maxScore: score, item });
      } else {
        existing.rrf += contrib;
        existing.maxScore = Math.max(existing.maxScore, score);
      }
    }
  }

  const merged = [...rrfScores.values()].sort((a, b) => b.rrf - a.rrf);
  return merged.map(({ item, maxScore }) =>
    typeof item === 'object' && item !== null
      ? ({ ...(item as object), score: maxScore } as T)
      : item
  );
}
