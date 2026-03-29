import type { SearchStep } from '../plan/types.js';
import type { RawHit } from './types.js';
import { qdrantSearch } from './qdrant-client.js';
import { payloadToRawHit } from './helpers/raw-hit-helpers.js';
import { rrfMerge } from './rrf-merge.js';
import {
  hasStrongSingleGoalTaxonomySignal,
  type SingleGoalTaxonomyStrength,
} from './taxonomy-strength.js';

export interface SingleGoalSearchCollectionMap {
  chunks: string;
  acts: string;
}

export interface SingleGoalFirstPassStep {
  kind: 'lldbi_chunks' | 'lldbi_acts';
  collection: string;
}

export interface BuildSingleGoalFirstPassPlanResult {
  requestedStepKinds: string[];
  stepsToRun: SingleGoalFirstPassStep[];
  usedActsSearch: boolean;
  actsSearchPolicyReasonCodes: string[];
}

function normalizeRequestedStepKinds(steps: SearchStep[] | undefined): string[] {
  if (steps?.length) {
    return steps
      .map((step) => step.kind)
      .filter((kind): kind is 'lldbi_chunks' | 'lldbi_acts' => kind === 'lldbi_chunks' || kind === 'lldbi_acts');
  }
  return ['lldbi_chunks', 'lldbi_acts'];
}

export function buildSingleGoalFirstPassPlan(input: {
  steps: SearchStep[] | undefined;
  collections: SingleGoalSearchCollectionMap;
  goalsCount?: number;
  taxonomyStrength?: SingleGoalTaxonomyStrength;
  descriptiveActTitleScope?: boolean;
}): BuildSingleGoalFirstPassPlanResult {
  const requestedStepKinds = normalizeRequestedStepKinds(input.steps);
  const explicitActsOnlyRequest =
    (input.steps?.some((step) => step.kind === 'lldbi_acts') ?? false) &&
    !(input.steps?.some((step) => step.kind === 'lldbi_chunks') ?? false);
  const strongTaxonomySignal = hasStrongSingleGoalTaxonomySignal({
    goals_count: input.goalsCount,
    taxonomy_strength: input.taxonomyStrength,
  });
  const descriptiveActTitleScope = input.descriptiveActTitleScope === true;

  const stepsToRun = requestedStepKinds.flatMap((kind) => {
    if (kind === 'lldbi_chunks') {
      return [{ kind, collection: input.collections.chunks } satisfies SingleGoalFirstPassStep];
    }
    if (strongTaxonomySignal && !explicitActsOnlyRequest && !descriptiveActTitleScope) return [];
    return [{ kind, collection: input.collections.acts } satisfies SingleGoalFirstPassStep];
  });

  const actsSearchPolicyReasonCodes: string[] = [];
  if (!requestedStepKinds.includes('lldbi_acts')) actsSearchPolicyReasonCodes.push('NOT_REQUESTED');
  else if (explicitActsOnlyRequest) actsSearchPolicyReasonCodes.push('EXPLICIT_ACTS_ONLY_REQUEST');
  else if (strongTaxonomySignal && descriptiveActTitleScope) actsSearchPolicyReasonCodes.push('DESCRIPTIVE_ACT_TITLE_SCOPE');
  else if (strongTaxonomySignal) actsSearchPolicyReasonCodes.push('STRONG_TAXONOMY_SIGNAL');
  else actsSearchPolicyReasonCodes.push('ACTS_SEARCH_ENABLED');

  return {
    requestedStepKinds,
    stepsToRun,
    usedActsSearch: stepsToRun.some((step) => step.kind === 'lldbi_acts'),
    actsSearchPolicyReasonCodes,
  };
}

export interface RunSingleGoalFirstPassSearchInput {
  stepsToRun: SingleGoalFirstPassStep[];
  vectorsByQuery: number[][];
  primaryVector: number[];
  topKChunks: number;
  topKActs: number;
  timeoutMs: number;
  callCounter?: { count: number };
}

export interface RunSingleGoalFirstPassSearchResult {
  rawPerStep: RawHit[];
  stepsLatencyMs: number[];
  collectionsUsed: string[];
  degraded: boolean;
}

export async function runSingleGoalFirstPassSearch(
  input: RunSingleGoalFirstPassSearchInput
): Promise<RunSingleGoalFirstPassSearchResult> {
  const hitKey = (raw: RawHit) => `${raw.r2_key ?? ''}:${raw.json_path ?? ''}`;
  const results = await Promise.allSettled(
    input.stepsToRun.map(async ({ kind, collection }) => {
      const stepStart = Date.now();
      const limit = kind === 'lldbi_chunks' ? input.topKChunks : input.topKActs;
      try {
        let rawHits: RawHit[];
        if (input.vectorsByQuery.length > 1) {
          const perVectorResults = await Promise.allSettled(
            input.vectorsByQuery.map((vector) =>
              qdrantSearch({
                collection,
                vector,
                limit,
                timeoutMs: input.timeoutMs,
                callCounter: input.callCounter,
              })
            )
          );
          const lists = perVectorResults
            .filter(
              (
                result
              ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof qdrantSearch>>> =>
                result.status === 'fulfilled'
            )
            .map((result) =>
              result.value
                .map((hit) => payloadToRawHit(hit, kind))
                .filter((raw) => raw.r2_key && raw.json_path)
            );
          rawHits = rrfMerge(lists, hitKey, (raw) => raw.score ?? 0);
        } else {
          const hits = await qdrantSearch({
            collection,
            vector: input.primaryVector,
            limit,
            timeoutMs: input.timeoutMs,
            callCounter: input.callCounter,
          });
          rawHits = hits
            .map((hit) => payloadToRawHit(hit, kind))
            .filter((raw) => raw.r2_key && raw.json_path);
        }
        return {
          collection,
          latencyMs: Date.now() - stepStart,
          rawHits,
          degraded: false,
        };
      } catch {
        return {
          collection,
          latencyMs: Date.now() - stepStart,
          rawHits: [] as RawHit[],
          degraded: true,
        };
      }
    })
  );

  const rawPerStep: RawHit[] = [];
  const stepsLatencyMs: number[] = [];
  const collectionsUsed: string[] = [];
  let degraded = false;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    if (result.value.degraded) degraded = true;
    stepsLatencyMs.push(result.value.latencyMs);
    collectionsUsed.push(result.value.collection);
    rawPerStep.push(...result.value.rawHits);
  }

  return { rawPerStep, stepsLatencyMs, collectionsUsed, degraded };
}
