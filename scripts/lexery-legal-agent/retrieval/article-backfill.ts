import { extractArticleRefsStructured, type ArticleRefStructured } from '../lib/articleRefs.js';
import type { TaxonomyCandidatesResult } from './act-taxonomy-store.js';
import type { QdrantFilter, QdrantSearchOptions } from './qdrant-client.js';
import { qdrantSearch } from './qdrant-client.js';
import { payloadToRawHit } from './raw-hit-helpers.js';
import {
  countCitationMatches,
  extractQueryCitationSelectors,
  getHitCitationSelectors,
  normalizeCitationValue,
  type QueryCitationSelectors,
} from './structural-citation.js';
import type { RawHit } from './types.js';

export interface ArticleBackfillMeta {
  added_count: number;
  not_found_refs: string[];
  calls: number;
  preferred_rada_nreg?: string;
  used_structural_filter: boolean;
  used_post_filter_fallback?: boolean;
  fallback_reason_code?: string;
}

const STRUCTURAL_ONLY_BACKFILL_REF = '__structural_only__';

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

export function deriveArticleBackfillPreferredNreg(
  taxonomyResult: TaxonomyCandidatesResult
): string | undefined {
  const aliasHitNregs = uniqueStrings((taxonomyResult.alias_hits ?? []).map((hit) => hit.rada_nreg));
  if (aliasHitNregs.length === 1) return aliasHitNregs[0];
  if (aliasHitNregs.length > 1) {
    const aliasStrength = new Map<string, { count: number; scoreMass: number }>();
    for (const hit of taxonomyResult.alias_hits ?? []) {
      const radaNreg = hit.rada_nreg?.trim();
      if (!radaNreg) continue;
      const current = aliasStrength.get(radaNreg) ?? { count: 0, scoreMass: 0 };
      current.count += 1;
      current.scoreMass += typeof hit.score === 'number' ? hit.score : 1;
      aliasStrength.set(radaNreg, current);
    }
    const ranked = [...aliasStrength.entries()].sort((a, b) => {
      const countDiff = b[1].count - a[1].count;
      if (countDiff !== 0) return countDiff;
      const scoreDiff = b[1].scoreMass - a[1].scoreMass;
      if (scoreDiff !== 0) return scoreDiff;
      return a[0].localeCompare(b[0]);
    });
    const [top, second] = ranked;
    if (top) {
      const hasDominantAliasEvidence =
        top[1].count >= 2 &&
        (!second || top[1].count >= second[1].count + 2 || top[1].count >= second[1].count * 2);
      if (hasDominantAliasEvidence) return top[0];
    }
    return undefined;
  }
  const candidateNregs = uniqueStrings(taxonomyResult.rada_nreg_candidates ?? []);
  return candidateNregs.length === 1 ? candidateNregs[0] : undefined;
}

function buildMatch(key: string, value: string): { key: string; match: { value: string } } {
  return { key, match: { value } };
}

export function buildArticleBackfillFilter(input: {
  ref: ArticleRefStructured;
  selectors: QueryCitationSelectors;
  preferredRadaNreg?: string;
}): QdrantFilter {
  const must: Array<{ key: string; match: { value: string } }> = [];
  const should = input.ref.normalized_forms.map((value) => buildMatch('article_number', value));

  if (input.preferredRadaNreg) {
    must.push(buildMatch('rada_nreg', input.preferredRadaNreg));
  }
  if (input.selectors.articlePart) {
    must.push(buildMatch('article_part_number', input.selectors.articlePart));
  }
  if (input.selectors.point) {
    must.push(buildMatch('point_number', input.selectors.point));
  }
  if (input.selectors.subpoint) {
    must.push(buildMatch('subpoint_number', input.selectors.subpoint));
  }
  if (input.selectors.paragraph) {
    must.push(buildMatch('paragraph_number', input.selectors.paragraph));
  }

  return {
    ...(must.length > 0 ? { must } : {}),
    should,
  };
}

export function hasStructuralSelectors(selectors: QueryCitationSelectors): boolean {
  return Boolean(
    selectors.article ||
      selectors.articlePart ||
      selectors.point ||
      selectors.subpoint ||
      selectors.paragraph ||
      selectors.note
  );
}

export function buildStructuralOnlyBackfillFilter(input: {
  selectors: QueryCitationSelectors;
  preferredRadaNreg?: string;
}): QdrantFilter | null {
  const must: Array<{ key: string; match: { value: string } }> = [];
  if (input.preferredRadaNreg) {
    must.push(buildMatch('rada_nreg', input.preferredRadaNreg));
  }
  if (input.selectors.article) {
    must.push(buildMatch('article_number', input.selectors.article));
  }
  if (input.selectors.articlePart) {
    must.push(buildMatch('article_part_number', input.selectors.articlePart));
  }
  if (input.selectors.point) {
    must.push(buildMatch('point_number', input.selectors.point));
  }
  if (input.selectors.subpoint) {
    must.push(buildMatch('subpoint_number', input.selectors.subpoint));
  }
  if (input.selectors.paragraph) {
    must.push(buildMatch('paragraph_number', input.selectors.paragraph));
  }
  return must.length > 0 ? { must } : null;
}

function buildBroadBackfillFallbackFilter(input: {
  ref: ArticleRefStructured;
  preferredRadaNreg?: string;
}): QdrantFilter | null {
  const must: Array<{ key: string; match: { value: string } }> = [];
  const should: Array<{ key: string; match: { value: string } }> = [];
  if (input.preferredRadaNreg) {
    must.push(buildMatch('rada_nreg', input.preferredRadaNreg));
  }
  for (const form of input.ref.normalized_forms) {
    should.push(buildMatch('article_number', form));
  }
  if (must.length === 0 && should.length === 0) return null;
  return {
    ...(must.length > 0 ? { must } : {}),
    ...(should.length > 0 ? { should } : {}),
  };
}

function buildBroadStructuralFallbackFilter(input: {
  preferredRadaNreg?: string;
}): QdrantFilter | null {
  if (!input.preferredRadaNreg) return null;
  return {
    must: [buildMatch('rada_nreg', input.preferredRadaNreg)],
  };
}

function shouldFallbackToPostFilter(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Index required but not found');
}

function requiredCitationMatches(selectors: QueryCitationSelectors): number {
  const explicit = [
    selectors.article,
    selectors.articlePart,
    selectors.point,
    selectors.subpoint,
    selectors.paragraph,
    selectors.note,
  ].filter(Boolean).length;
  return Math.max(1, explicit);
}

export function hitSatisfiesStructuralSelectors(
  hit: Pick<
    RawHit,
    | 'article_number'
    | 'unit_number'
    | 'unit_type'
    | 'citation_path'
    | 'article_part_number'
    | 'point_number'
    | 'subpoint_number'
    | 'paragraph_number'
    | 'unstructured_fallback'
    | 'metadata'
  >,
  selectors: QueryCitationSelectors
): boolean {
  const matches = countCitationMatches(selectors, getHitCitationSelectors(hit));
  return matches >= requiredCitationMatches(selectors);
}

export function hitSatisfiesBackfillExpectation(
  hit: Pick<
    RawHit,
    | 'article_number'
    | 'unit_number'
    | 'unit_type'
    | 'citation_path'
    | 'article_part_number'
    | 'point_number'
    | 'subpoint_number'
    | 'paragraph_number'
    | 'unstructured_fallback'
    | 'metadata'
  >,
  ref: ArticleRefStructured,
  selectors: QueryCitationSelectors
): boolean {
  const hitArticle = normalizeCitationValue(hit.article_number);
  if (!hitArticle || !ref.normalized_forms.some((form) => normalizeCitationValue(form) === hitArticle)) {
    return false;
  }
  return hitSatisfiesStructuralSelectors(hit, selectors);
}

export async function runArticleBackfill(input: {
  enabled: boolean;
  query: string;
  vector: number[] | null;
  collection: string;
  timeoutMs: number;
  maxCalls: number;
  maxAddedHits: number;
  existingHits: RawHit[];
  taxonomyResult: TaxonomyCandidatesResult;
  callCounter?: { count: number };
}): Promise<{ addedHits: RawHit[]; meta?: ArticleBackfillMeta }> {
  if (!input.enabled || !input.vector?.length) return { addedHits: [] };

  const selectors = extractQueryCitationSelectors(input.query);
  const strongRefs = extractArticleRefsStructured(input.query).filter((ref) => ref.signal_strength === 'strong');
  const preferredRadaNreg = deriveArticleBackfillPreferredNreg(input.taxonomyResult);
  const missingRefs =
    strongRefs.length > 0
      ? strongRefs.filter((ref) => !input.existingHits.some((hit) => hitSatisfiesBackfillExpectation(hit, ref, selectors)))
      : preferredRadaNreg && hasStructuralSelectors(selectors) && !input.existingHits.some((hit) => hitSatisfiesStructuralSelectors(hit, selectors))
        ? [
            {
              raw_ref: STRUCTURAL_ONLY_BACKFILL_REF,
              normalized_forms: selectors.article ? [selectors.article] : [],
              signal_strength: 'strong',
              evidence: 'legal_prefix',
            } satisfies ArticleRefStructured,
          ]
        : [];
  if (missingRefs.length === 0) return { addedHits: [] };

  const initialCalls = input.callCounter?.count ?? 0;
  const existingKeys = new Set(input.existingHits.map((hit) => `${hit.r2_key}:${hit.json_path}`));
  const addedHits: RawHit[] = [];
  const notFoundRefs: string[] = [];
  let usedPostFilterFallback = false;
  let fallbackReasonCode: string | undefined;

  for (const ref of missingRefs) {
    if ((input.callCounter?.count ?? initialCalls) >= initialCalls + input.maxCalls) break;
    if (addedHits.length >= input.maxAddedHits) break;
    try {
      const structuralOnly = ref.raw_ref === STRUCTURAL_ONLY_BACKFILL_REF;
      const filter = structuralOnly
        ? buildStructuralOnlyBackfillFilter({ selectors, preferredRadaNreg })
        : buildArticleBackfillFilter({ ref, selectors, preferredRadaNreg });
      if (!filter) {
        notFoundRefs.push(ref.raw_ref);
        continue;
      }
      const options: QdrantSearchOptions = {
        collection: input.collection,
        vector: input.vector,
        limit: structuralOnly ? 12 : 5,
        filter,
        timeoutMs: input.timeoutMs,
        callCounter: input.callCounter,
      };
      let hits = await qdrantSearch(options);
      let usedFallbackForRef = false;
      if (hits.length === 0 && structuralOnly && preferredRadaNreg) {
        const broadStructuralFilter = buildBroadStructuralFallbackFilter({ preferredRadaNreg });
        if (broadStructuralFilter) {
          hits = await qdrantSearch({
            collection: input.collection,
            vector: input.vector,
            limit: 30,
            filter: broadStructuralFilter,
            timeoutMs: input.timeoutMs,
            callCounter: input.callCounter,
          });
          usedFallbackForRef = true;
        }
      }
      if (hits.length === 0) {
        notFoundRefs.push(ref.raw_ref);
        continue;
      }
      let addedForRef = 0;
      for (const hit of hits) {
        const raw = payloadToRawHit(hit, 'lldbi_chunks');
        if (!raw.r2_key || !raw.json_path) continue;
        const satisfied = structuralOnly
          ? hitSatisfiesStructuralSelectors(raw, selectors)
          : hitSatisfiesBackfillExpectation(raw, ref, selectors);
        if (!satisfied) continue;
        const key = `${raw.r2_key}:${raw.json_path}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        addedHits.push(raw);
        addedForRef += 1;
        if (addedHits.length >= input.maxAddedHits) break;
      }
      if (usedFallbackForRef) {
        usedPostFilterFallback = true;
        fallbackReasonCode = fallbackReasonCode ?? 'ZERO_HITS_STRUCTURAL_FILTER';
      }
      if (addedForRef === 0) notFoundRefs.push(ref.raw_ref);
    } catch (error) {
      if (!shouldFallbackToPostFilter(error)) {
        notFoundRefs.push(ref.raw_ref);
        continue;
      }
      const structuralOnly = ref.raw_ref === STRUCTURAL_ONLY_BACKFILL_REF;
      const fallbackFilter = structuralOnly
        ? buildBroadStructuralFallbackFilter({ preferredRadaNreg })
        : buildBroadBackfillFallbackFilter({ ref, preferredRadaNreg });
      if (!fallbackFilter) {
        notFoundRefs.push(ref.raw_ref);
        continue;
      }
      try {
        const fallbackHits = await qdrantSearch({
          collection: input.collection,
          vector: input.vector,
          limit: structuralOnly ? 30 : 12,
          filter: fallbackFilter,
          timeoutMs: input.timeoutMs,
          callCounter: input.callCounter,
        });
        let addedForRef = 0;
        for (const hit of fallbackHits) {
          const raw = payloadToRawHit(hit, 'lldbi_chunks');
          if (!raw.r2_key || !raw.json_path) continue;
          const satisfied = structuralOnly
            ? hitSatisfiesStructuralSelectors(raw, selectors)
            : hitSatisfiesBackfillExpectation(raw, ref, selectors);
          if (!satisfied) continue;
          const key = `${raw.r2_key}:${raw.json_path}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          addedHits.push(raw);
          addedForRef += 1;
          if (addedHits.length >= input.maxAddedHits) break;
        }
        usedPostFilterFallback = true;
        fallbackReasonCode = fallbackReasonCode ?? 'QDRANT_FILTER_INDEX_MISSING';
        if (addedForRef === 0) notFoundRefs.push(ref.raw_ref);
      } catch {
        notFoundRefs.push(ref.raw_ref);
      }
    }
  }

  if (addedHits.length === 0 && notFoundRefs.length === 0) return { addedHits: [] };
  return {
    addedHits,
    meta: {
      added_count: addedHits.length,
      not_found_refs: notFoundRefs.filter((ref) => ref !== STRUCTURAL_ONLY_BACKFILL_REF),
      calls: (input.callCounter?.count ?? initialCalls) - initialCalls,
      preferred_rada_nreg: preferredRadaNreg,
      used_structural_filter: hasStructuralSelectors(selectors),
      used_post_filter_fallback: usedPostFilterFallback || undefined,
      fallback_reason_code: fallbackReasonCode,
    },
  };
}
