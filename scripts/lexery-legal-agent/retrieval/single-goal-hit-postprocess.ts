import type { ExtractedEntity } from '../classify/types.js';
import { embedQuery } from './embedding.js';
import type { ArticleBackfillMeta } from './article-backfill.js';
import { runArticleBackfill } from './article-backfill.js';
import type { TaxonomyCandidatesResult } from './act-taxonomy-store.js';
import {
  applyDiversityCap,
  applyHybridOrdering,
  applyNoisePenalty,
  compareRawHitByScore,
  dedupeHits,
} from './hit-ranking.js';
import { qdrantSearch } from './qdrant-client.js';
import type { QueryRewriteTraceMeta } from './query-rewrite-phase.js';
import { payloadToRawHit } from './raw-hit-helpers.js';
import type { ReferenceExpansionMeta } from './reference-expander.js';
import { expandReferences } from './reference-expander.js';
import { computeChunksEvidenceTopActs } from './selected-acts.js';
import type { QueryCitationSelectors } from './structural-citation.js';
import type { RawHit } from './types.js';

export function shouldSkipReferenceExpansionForStrongCoverage(
  finalHits: RawHit[],
  querySelectors: QueryCitationSelectors
): boolean {
  if (querySelectors.explicitSelectorCount > 0 || querySelectors.noteMentioned) return false;
  const headHits = finalHits.filter((hit) => hit.rada_nreg).slice(0, 12);
  if (headHits.length === 0) return false;
  const uniqueActs = new Set(headHits.map((hit) => hit.rada_nreg as string));
  if (uniqueActs.size <= 2) return true;
  const evidence = computeChunksEvidenceTopActs(headHits);
  if (evidence.length < 2) return false;
  const totalRankMass = evidence.reduce((sum, item) => sum + (item.rank_mass_top30 ?? 0), 0);
  if (totalRankMass <= 0) return false;
  const top2RankMass = evidence
    .slice(0, 2)
    .reduce((sum, item) => sum + (item.rank_mass_top30 ?? 0), 0);
  return top2RankMass / totalRankMass >= 0.88 && (evidence[1]?.count_in_top30 ?? 0) >= 2;
}

export interface SingleGoalHitPostprocessInput {
  query: string;
  rankingQuery: string;
  vector: number[];
  topScore: number | null;
  allHits: RawHit[];
  taxonomyResult: TaxonomyCandidatesResult;
  entities: ExtractedEntity[];
  querySelectors: QueryCitationSelectors;
  collections: {
    chunks: string;
  };
  qdrantCallCounter: { count: number };
  timeoutMs: number;
  hitsCap: number;
  fusionTopN: number;
  queryRewriteMeta: QueryRewriteTraceMeta;
  referenceExpansionEnabled: boolean;
  referenceExpansionMaxQdrantCalls?: number;
  referenceExpansionMaxReferencedActs?: number;
  referenceExpansionMaxAddedHits?: number;
  articleBackfillEnabled: boolean;
  articleBackfillMaxCalls?: number;
  articleBackfillMaxAddedHits?: number;
  fetchChunkText: (r2Key: string, jsonPath: string) => Promise<string | null>;
  resolveActByTitleFragment: (fragment: string) => Promise<string[]>;
  resolveActByAlias: (alias: string) => Promise<string[]>;
  getActMeta: (rada_nreg: string) => Promise<{ title?: string; category?: string | null } | null>;
}

export interface SingleGoalHitPostprocessResult {
  finalHits: RawHit[];
  topScore: number | null;
  hitsTotalBeforeCap: number;
  hitsCapApplied: boolean;
  avgScore?: number;
  noisePenaltyCount: number;
  noisePenaltyGuardBlockedCount: number;
  noisePenaltyGuardReasonCodes: string[];
  referenceExpansionMeta: ReferenceExpansionMeta;
  articleBackfillMeta: ArticleBackfillMeta;
}

export async function runSingleGoalHitPostprocess(
  input: SingleGoalHitPostprocessInput
): Promise<SingleGoalHitPostprocessResult> {
  const workingHits = [...input.allHits];

  if (workingHits.length > 0 && input.taxonomyResult.debug.source === 'supabase') {
    applyHybridOrdering(workingHits, input.rankingQuery, input.taxonomyResult, input.entities);
  }

  const initialNoiseResult = applyNoisePenalty(workingHits, input.fusionTopN);
  workingHits.length = 0;
  workingHits.push(...applyDiversityCap(initialNoiseResult.hits));

  let referenceExpansionMeta: ReferenceExpansionMeta = {
    enabled: input.referenceExpansionEnabled,
    attempted: false,
    added_count: 0,
    referenced_acts: [],
    parse_hits_used: 0,
    skipped_reason_codes: [],
  };

  const skipReferenceExpansionForStrongCoverage = shouldSkipReferenceExpansionForStrongCoverage(
    workingHits,
    input.querySelectors
  );
  if (
    input.referenceExpansionEnabled &&
    workingHits.length > 0 &&
    !skipReferenceExpansionForStrongCoverage
  ) {
    const initialQdrantCount = input.qdrantCallCounter.count;
    const maxExtraCalls = input.referenceExpansionMaxQdrantCalls ?? 4;
    const existingKeys = new Set(workingHits.map((hit) => `${hit.r2_key}:${hit.json_path}`));
    const retrieveChunksForAct = async (params: {
      rada_nreg: string;
      articleRef?: string;
      queryVariant?: string;
      limit: number;
    }): Promise<RawHit[]> => {
      if (input.qdrantCallCounter.count >= initialQdrantCount + maxExtraCalls) return [];
      const searchQuery = params.queryVariant ?? params.articleRef ?? input.query;
      let searchVector = input.vector;
      if (searchQuery !== input.query) {
        try {
          const emb = await embedQuery(searchQuery);
          searchVector = emb.embedding;
        } catch {
          // fallback to main query vector
        }
      }
      const hits = await qdrantSearch({
        collection: input.collections.chunks,
        vector: searchVector,
        limit: params.limit,
        filter: { must: [{ key: 'rada_nreg', match: { value: params.rada_nreg } }] },
        timeoutMs: input.timeoutMs,
        retry: false,
        callCounter: input.qdrantCallCounter,
      });
      return hits.map((hit) => payloadToRawHit(hit, 'lldbi_chunks'));
    };
    try {
      const { addedHits, meta } = await expandReferences({
        finalHitsBeforeCap: workingHits.slice(0, 12),
        fetchChunkText: input.fetchChunkText,
        resolveActByTitleFragment: input.resolveActByTitleFragment,
        resolveActByAlias: input.resolveActByAlias,
        retrieveChunksForAct,
        getActMeta: input.getActMeta,
        config: {
          maxParseHits: 10,
          maxReferencedActs: input.referenceExpansionMaxReferencedActs ?? 2,
          maxAddedHits: input.referenceExpansionMaxAddedHits ?? 10,
        },
        lowConfidence: false,
        existingKeys,
      });
      referenceExpansionMeta = meta;
      if (addedHits.length > 0) {
        workingHits.push(...addedHits);
        const deduped = dedupeHits(workingHits);
        if (input.taxonomyResult.debug.source === 'supabase') {
          applyHybridOrdering(deduped, input.rankingQuery, input.taxonomyResult, input.entities);
        } else {
          deduped.sort(compareRawHitByScore);
        }
        workingHits.length = 0;
        workingHits.push(...deduped);
      }
    } catch {
      referenceExpansionMeta.skipped_reason_codes.push('EXPANSION_ERROR');
    }
  } else if (skipReferenceExpansionForStrongCoverage) {
    referenceExpansionMeta.skipped_reason_codes.push('STRONG_HEAD_COVERAGE');
  }

  if (referenceExpansionMeta.added_count > 0) {
    const noiseAfterExpansion = applyNoisePenalty(workingHits, input.fusionTopN);
    workingHits.length = 0;
    workingHits.push(...applyDiversityCap(noiseAfterExpansion.hits));
  }

  const articleBackfill = await runArticleBackfill({
    enabled: input.articleBackfillEnabled,
    query: input.query,
    vector: input.vector,
    collection: input.collections.chunks,
    timeoutMs: input.timeoutMs,
    maxCalls: input.articleBackfillMaxCalls,
    maxAddedHits: input.articleBackfillMaxAddedHits,
    existingHits: workingHits,
    taxonomyResult: input.taxonomyResult,
    callCounter: input.qdrantCallCounter,
  });
  const articleBackfillMeta = articleBackfill.meta;
  if (articleBackfill.addedHits.length > 0) {
    workingHits.push(...articleBackfill.addedHits);
    const deduped = dedupeHits(workingHits);
    if (input.taxonomyResult.debug.source === 'supabase') {
      applyHybridOrdering(deduped, input.rankingQuery, input.taxonomyResult, input.entities);
    } else {
      deduped.sort(compareRawHitByScore);
    }
    const noiseAfterBackfill = applyNoisePenalty(deduped, input.fusionTopN);
    workingHits.length = 0;
    workingHits.push(...applyDiversityCap(noiseAfterBackfill.hits));
  }

  const hitsTotalBeforeCap = workingHits.length;
  const finalHits = input.hitsCap > 0 ? workingHits.slice(0, input.hitsCap) : workingHits;
  const hitsCapApplied = input.hitsCap > 0 && hitsTotalBeforeCap > input.hitsCap;
  const avgScore =
    finalHits.length > 0 ? finalHits.reduce((sum, hit) => sum + hit.score, 0) / finalHits.length : undefined;

  return {
    finalHits,
    topScore: input.topScore,
    hitsTotalBeforeCap,
    hitsCapApplied,
    avgScore,
    noisePenaltyCount: initialNoiseResult.penaltyCount,
    noisePenaltyGuardBlockedCount: initialNoiseResult.guardBlockedCount,
    noisePenaltyGuardReasonCodes: initialNoiseResult.guardReasonCodes,
    referenceExpansionMeta,
    articleBackfillMeta,
  };
}
