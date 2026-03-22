import { config } from '../lib/config.js';
import {
  incrementU4RoutingHintsNotUsed,
  incrementU4RoutingHintsUsed,
} from '../gateway/observability.js';
import {
  extractStructuredActIdentifiers,
  type ActMeta,
} from './act-taxonomy-store.js';
import { deriveCoverageGap } from './coverage-gap.js';
import { computeFamilyEvidence, toFamilyEvidenceSummary, type FamilyEvidence } from './family-evidence.js';
import { hasExplicitActScopeCue } from './goal-splitter.js';
import {
  isMetadataGroundedActCandidate,
  resolveSingleActScopeSelection,
} from './single-goal-act-scope.js';
import {
  canRelaxCoverageGuardWithActGrounding,
  hasStickySingleGoalLowConfidenceReason,
  shouldFlagProceduralPrimaryWithoutActGrounding,
} from './single-goal-honesty.js';
import {
  callRoutingHints,
  shouldCallRoutingHints,
  type RoutingHintsInput,
  type RoutingHintsTriggers,
} from './routing-hints-llm.js';
import {
  buildSelectedActs,
  classifyActKind,
  computeChunksEvidenceTopActs,
  SELECTED_ACTS_MAX_OUT,
  type ActCandidateInput,
  type BuildSelectedActsOutput,
  type SelectedActOutput,
} from './selected-acts.js';
import {
  finalizeSelectedActsAfterRouting,
  summarizeSelectedActs,
  type FinalizeSelectedActsAfterRoutingOutput,
} from './selected-acts-finalizer.js';
import type { CoverageGap, RawHit } from './types.js';

type QueryRewriteMetaLike = {
  called?: boolean;
  used?: boolean;
  not_used_reason_codes?: string[];
};

export type SelectedActTraceItem = {
  rada_nreg: string;
  act_title?: string;
  score?: number;
  why_selected?: string;
  reason_tag?: string;
  source_tags?: string[];
  document_type?: string | null;
  category?: string | null;
  storage_category?: string | null;
  act_kind?: string;
  flags?: SelectedActOutput['flags'];
  confidence?: number;
};

type SelectedActsSourcesBreakdown = BuildSelectedActsOutput['selected_acts_sources_breakdown'] & {
  from_routing_hints?: string[];
};

export type RoutingHintsUsedEffect = {
  added_act?: { rada_nreg: string; title: string; family_key: string; source: string };
  added_count: number;
};

export type RoutingHintsMeta = {
  enabled: boolean;
  called: boolean;
  call_failed_reason?: string;
  model_id?: string;
  tokens_approx?: number;
  families_ranked_top2?: Array<{ family_key: string; confidence?: number }>;
  goals_count: number;
  used_reason_codes: string[];
  not_used_reason_codes: string[];
  used_effect: RoutingHintsUsedEffect;
  attempts?: number;
  parse_mode?: 'strict' | 'extract';
  routing_path?: 'TAXONOMY_FIRST' | 'ACTS_SEARCH' | 'NONE';
};

export type OodGuardResult = {
  fired: boolean;
  why: string[];
  thresholds: { top_score: number; avg_score: number };
};

export interface ResolveSingleGoalSelectedActsInput {
  query: string;
  goalId: string;
  finalHits: RawHit[];
  actCandidatesTopHydrated: ActCandidateInput[];
  plannerRationaleByNreg: Map<string, string>;
  hitsByActTop3?: Record<string, number>;
  avgScoreByActTop3?: Record<string, number>;
  precomputedChunksEvidenceTopActs?: BuildSelectedActsOutput['chunks_evidence_top_acts'];
  taxonomyNregs: Set<string>;
  actsSearchNregs: string[];
  domainHint?: string;
  documentTypeHints?: string[];
  taxonomyActCount: number;
  aliasHitCount: number;
  exactActHitCount: number;
  exactActNregs: string[];
  groundedActHitCount: number;
  groundedActNregs: string[];
  actSelectionLowConfidence: boolean;
  reasonCodes: string[];
  useLowConfidenceFallback: boolean;
  queryRewriteMeta: QueryRewriteMetaLike;
  topScore: number | null;
  avgScore?: number;
  categoryHintsCount: number;
  entitiesCount: number;
  anchorsCount: number;
  domainWeak: boolean;
  getActMeta: (rada_nreg: string) => Promise<ActMeta | null>;
  hydrateSelectedActsMeta: (
    acts: SelectedActOutput[],
    confidence: number | undefined
  ) => Promise<SelectedActTraceItem[]>;
  searchActsForRouting: (queryVariant?: string) => Promise<Array<{ rada_nreg: string; score?: number }>>;
}

export interface ResolveSingleGoalSelectedActsOutput {
  reasonCodes: string[];
  selected_acts_final: SelectedActTraceItem[];
  selected_acts_sources_breakdown_final: SelectedActsSourcesBreakdown;
  chunks_evidence_top_acts: BuildSelectedActsOutput['chunks_evidence_top_acts'];
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  familyEvidence: FamilyEvidence;
  routingHintsMeta: RoutingHintsMeta;
  low_confidence_final: boolean;
  coverageGap: CoverageGap;
  oodGuardResult: OodGuardResult;
  specializedDomainNoPrimary: boolean;
  coverageGuardFiredButFamilyOk: boolean;
  recoveredEmptySelected: boolean;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function pushUnique(reasonCodes: string[], code: string): void {
  if (!reasonCodes.includes(code)) reasonCodes.push(code);
}

function removeReasonCodes(reasonCodes: string[], codesToRemove: string[]): string[] {
  const blocked = new Set(codesToRemove);
  return reasonCodes.filter((code) => !blocked.has(code));
}

const LOW_CONFIDENCE_FINAL_ONLY_REASON_CODES = new Set([
  'ACT_SELECTION_LOW_CONFIDENCE',
  'LOW_EVIDENCE',
  'NO_STRONG_ACT_EVIDENCE',
  'ROUTING_HINTS_LOW_CONF',
  'OOD_GUARD_WEAK_BUT_ACT_GROUNDED',
  'UNGROUNDED_PRIMARY_FALLBACK',
  'NON_PRIMARY_ONLY_WEAK_CONFIDENCE',
  'EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE',
  'EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY',
]);

export function normalizeFinalReasonCodes(reasonCodes: string[], lowConfidence: boolean): string[] {
  const normalized = uniqueStrings(reasonCodes);
  if (lowConfidence) return normalized;
  return normalized.filter((code) => !LOW_CONFIDENCE_FINAL_ONLY_REASON_CODES.has(code));
}

function toFamilyKey(category: string | undefined | null): string {
  return (category ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim() || 'unknown';
}

function normalizeDomainHintKey(domainHint: string | undefined | null): string {
  const normalized = (domainHint ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();
  if (normalized === 'admin') return 'administrative';
  return normalized;
}

function isSpecificDomainHint(domainHint: string | undefined | null): boolean {
  const normalized = normalizeDomainHintKey(domainHint);
  return normalized.length > 0 && normalized !== 'general' && normalized !== 'unknown';
}

export function isDomainHintAlignedFamily(
  domainHint: string | undefined | null,
  familyKey: string | undefined | null
): boolean {
  const normalizedDomain = normalizeDomainHintKey(domainHint);
  const normalizedFamily = toFamilyKey(familyKey);
  if (!isSpecificDomainHint(normalizedDomain) || !normalizedFamily || normalizedFamily === 'unknown') return false;
  if (normalizedFamily === normalizedDomain) return true;
  if (normalizedFamily.startsWith(`${normalizedDomain}_`) || normalizedDomain.startsWith(`${normalizedFamily}_`)) {
    return true;
  }
  if (normalizedDomain === 'tax_customs' && normalizedFamily.startsWith('tax')) return true;
  if (normalizedDomain === 'tax' && normalizedFamily.startsWith('tax')) return true;
  if (normalizedDomain === 'labor_social' && normalizedFamily.startsWith('labor')) return true;
  if (normalizedDomain === 'labor' && normalizedFamily.startsWith('labor')) return true;
  if (normalizedDomain === 'civil' && (normalizedFamily === 'civil' || normalizedFamily === 'civil_procedure')) {
    return true;
  }
  if (
    normalizedDomain === 'criminal' &&
    (normalizedFamily === 'criminal' || normalizedFamily === 'criminal_procedure')
  ) {
    return true;
  }
  if (
    normalizedDomain === 'administrative' &&
    (normalizedFamily === 'administrative' || normalizedFamily === 'administrative_offenses')
  ) {
    return true;
  }
  return false;
}

const METADATA_GROUNDING_REASON_CODES = new Set([
  'exact_alias_match',
  'exact_title_match',
]);

export async function resolveSingleGoalSelectedActs(
  input: ResolveSingleGoalSelectedActsInput
): Promise<ResolveSingleGoalSelectedActsOutput> {
  const {
    query,
    goalId,
    finalHits,
    actCandidatesTopHydrated,
    plannerRationaleByNreg,
    hitsByActTop3,
    avgScoreByActTop3,
    precomputedChunksEvidenceTopActs,
    taxonomyNregs,
    actsSearchNregs,
    domainHint,
    documentTypeHints,
    taxonomyActCount,
    aliasHitCount,
    exactActHitCount,
    exactActNregs,
    groundedActHitCount,
    groundedActNregs,
    actSelectionLowConfidence,
    useLowConfidenceFallback,
    queryRewriteMeta,
    topScore,
    avgScore,
    categoryHintsCount,
    entitiesCount,
    anchorsCount,
    domainWeak,
    getActMeta,
    hydrateSelectedActsMeta,
    searchActsForRouting,
  } = input;

  const reasonCodes = [...input.reasonCodes];
  const chunksEvidenceTopActs = precomputedChunksEvidenceTopActs?.length
    ? precomputedChunksEvidenceTopActs
    : computeChunksEvidenceTopActs(finalHits);

  const familyEvidence = await computeFamilyEvidence({
    chunks_evidence_top_acts: chunksEvidenceTopActs,
    getActMeta,
  });
  const familyWeakOrNoPrimary =
    familyEvidence.reason_codes.includes('FAMILY_WEAK_EVIDENCE') ||
    familyEvidence.reason_codes.includes('NO_PRIMARY_LAW_EVIDENCE');

  const selectedActsResult = buildSelectedActs({
    finalHits,
    actCandidatesTop: actCandidatesTopHydrated,
    goals_summary: [{ goal_id: goalId }],
    hits_by_act_top3: Object.keys(hitsByActTop3 ?? {}).length > 0 ? hitsByActTop3 : undefined,
    avg_score_by_act_top3: Object.keys(avgScoreByActTop3 ?? {}).length > 0 ? avgScoreByActTop3 : undefined,
    taxonomyNregs,
    actsSearchNregs,
    domainHint,
    documentTypeHints: documentTypeHints && documentTypeHints.length > 0 ? documentTypeHints : undefined,
    actSelectionLowConfidence: actSelectionLowConfidence || familyWeakOrNoPrimary,
    chunks_evidence_top_acts: chunksEvidenceTopActs,
    familyEvidence: toFamilyEvidenceSummary(familyEvidence),
  });

  const selected_acts_raw = selectedActsResult.selected_acts.map((act) => ({
    ...act,
    why_selected: plannerRationaleByNreg.get(act.rada_nreg) ?? act.why_selected,
  }));
  const selected_acts = await hydrateSelectedActsMeta(
    selected_acts_raw,
    selectedActsResult.selected_acts_confidence
  );
  let selected_acts_sources_breakdown_final: SelectedActsSourcesBreakdown = {
    ...selectedActsResult.selected_acts_sources_breakdown,
  };

  if (selectedActsResult.selected_acts_reason_codes.length > 0) {
    for (const code of selectedActsResult.selected_acts_reason_codes) pushUnique(reasonCodes, code);
  }
  if (familyEvidence.reason_codes.length > 0) {
    for (const code of familyEvidence.reason_codes) pushUnique(reasonCodes, code);
  }

  const nonPrimaryAuthoritativeKinds = new Set(['SECONDARY_ORDER', 'INTERNATIONAL_TREATY', 'KSU_DECISION']);
  const compactNonPrimaryOnlySelection =
    selected_acts.length > 0 &&
    selected_acts.length <= 2 &&
    selected_acts.every((act) => act.act_kind === 'SECONDARY_ORDER' || act.act_kind === 'INTERNATIONAL_TREATY');
  const specializedDomainNoPrimary =
    familyEvidence.reason_codes.includes('NO_PRIMARY_LAW_EVIDENCE') &&
    compactNonPrimaryOnlySelection &&
    (selectedActsResult.selected_acts_confidence ?? 0) >= 0.75 &&
    !selectedActsResult.selected_acts_reason_codes.includes('NON_PRIMARY_ONLY_WEAK_CONFIDENCE') &&
    chunksEvidenceTopActs.some((evidence) => {
      if (evidence.count_in_top30 < 5) return false;
      const hydratedAct = selected_acts.find((act) => act.rada_nreg === evidence.rada_nreg);
      return !!hydratedAct && nonPrimaryAuthoritativeKinds.has(hydratedAct.act_kind ?? '');
    });

  const qrSignaledOod =
    queryRewriteMeta.called === true &&
    queryRewriteMeta.used === false &&
    queryRewriteMeta.not_used_reason_codes?.includes('LOW_CONFIDENCE');

  const metadataGroundedSelectedActsCount = selected_acts.filter((act) => {
    const candidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === act.rada_nreg);
    return isMetadataGroundedActCandidate(candidate, query, METADATA_GROUNDING_REASON_CODES);
  }).length;
  const coverageGuardRecoveredWithActGrounding = canRelaxCoverageGuardWithActGrounding({
    selectedActsReasonCodes: selectedActsResult.selected_acts_reason_codes,
    familyReasonCodes: familyEvidence.reason_codes,
    qrSignaledOod,
    exactActHitCount,
    groundedActHitCount,
    metadataGroundedSelectedActsCount,
  });

  const recoveredEmptySelected =
    selectedActsResult.selected_acts_reason_codes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE') ||
    selectedActsResult.selected_acts_reason_codes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY');
  const familyGuardMissingEvidence =
    selectedActsResult.selected_acts_reason_codes.includes('FAMILY_GUARD_NO_EVIDENCE') ||
    selectedActsResult.selected_acts_reason_codes.includes('FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE');

  let low_confidence_final =
    useLowConfidenceFallback ||
    actSelectionLowConfidence ||
    (familyWeakOrNoPrimary && !specializedDomainNoPrimary) ||
    (selectedActsResult.selected_acts_reason_codes.includes('COVERAGE_GUARD_FAILED') &&
      !coverageGuardRecoveredWithActGrounding) ||
    familyGuardMissingEvidence ||
    recoveredEmptySelected;

  const oodGuardResult: OodGuardResult = {
    fired: false,
    why: [],
    thresholds: {
      top_score: config.u4OodGuardTopScoreThreshold,
      avg_score: config.u4OodGuardAvgScoreThreshold,
    },
  };

  if (config.u4OodGuardEnabled && !low_confidence_final) {
    const oodWhy: string[] = [];
    const topScoreWeak = topScore == null || topScore < config.u4OodGuardTopScoreThreshold;
    const noCategoryHints = categoryHintsCount === 0;
    const avgScoreWeak = avgScore == null || avgScore < config.u4OodGuardAvgScoreThreshold;
    const actGroundedForOod =
      exactActHitCount > 0 ||
      groundedActHitCount > 0 ||
      metadataGroundedSelectedActsCount > 0;
    if (topScoreWeak) oodWhy.push('TOP_SCORE_WEAK');
    if (domainWeak) oodWhy.push('DOMAIN_WEAK');
    if (noCategoryHints) oodWhy.push('NO_CATEGORY_HINTS');
    if (avgScoreWeak) oodWhy.push('AVG_SCORE_WEAK');
    if (oodWhy.length === 4) {
      low_confidence_final = true;
      oodGuardResult.fired = true;
      oodGuardResult.why = actGroundedForOod ? [...oodWhy, 'ACT_GROUNDED'] : oodWhy;
      if (actGroundedForOod) {
        pushUnique(reasonCodes, 'OOD_GUARD_WEAK_BUT_ACT_GROUNDED');
      } else {
        pushUnique(reasonCodes, 'OUT_OF_SCOPE');
      }
      pushUnique(reasonCodes, 'LOW_EVIDENCE');
    }
  }

  const lowConfReasonCodes = ['OUT_OF_SCOPE', 'NO_STRONG_ACT_EVIDENCE', 'LOW_EVIDENCE', 'ACT_SELECTION_LOW_CONFIDENCE'];
  if (low_confidence_final && !reasonCodes.some((code) => lowConfReasonCodes.includes(code))) {
    pushUnique(reasonCodes, 'ACT_SELECTION_LOW_CONFIDENCE');
  }

  const confidentFamilySupportThreshold = 0.62;
  let confidentFamilyMismatch = false;
  if (
    familyEvidence.dominant_family_key &&
    familyEvidence.family_confidence >= confidentFamilySupportThreshold &&
    !familyEvidence.family_conflict
  ) {
    let hasSelectedActFromDominantFamily = false;
    for (const act of selected_acts) {
      const meta = await getActMeta(act.rada_nreg);
      if (toFamilyKey(meta?.category) === familyEvidence.dominant_family_key) {
        hasSelectedActFromDominantFamily = true;
        break;
      }
    }
    confidentFamilyMismatch = !hasSelectedActFromDominantFamily;
  }

  const allowedFamilyKeysSet = new Set<string>(['unknown']);
  for (const family of familyEvidence.debug.top_families) {
    allowedFamilyKeysSet.add(family.family_key);
  }
  for (const candidate of actCandidatesTopHydrated) {
    allowedFamilyKeysSet.add(toFamilyKey(candidate.category));
  }
  const allowedFamilyKeys = Array.from(allowedFamilyKeysSet);

  const routingTriggers: RoutingHintsTriggers = {
    family_weak_evidence: familyWeakOrNoPrimary,
    family_conflict: familyEvidence.family_conflict,
    selected_acts_confidence_below_055: (selectedActsResult.selected_acts_confidence ?? 0) <= 0.55,
    selected_acts_confidence_below_06: (selectedActsResult.selected_acts_confidence ?? 0) < 0.6,
    selected_acts_confidence_below_065: (selectedActsResult.selected_acts_confidence ?? 0) < 0.65,
    selected_acts_confidence_below_075: (selectedActsResult.selected_acts_confidence ?? 0) < 0.75,
    reason_codes_include_coverage_guard_failed: selectedActsResult.selected_acts_reason_codes.includes(
      'COVERAGE_GUARD_FAILED'
    ),
    reason_codes_include_no_strong_act_evidence:
      reasonCodes.includes('NO_STRONG_ACT_EVIDENCE') || familyGuardMissingEvidence,
    confident_family_mismatch: confidentFamilyMismatch,
    goals_count: 1,
    selected_acts_empty_or_very_low: selected_acts.length === 0,
  };

  let routingHintsMeta: RoutingHintsMeta = {
    enabled: config.u4RoutingHintsEnabled,
    called: false,
    goals_count: 0,
    used_reason_codes: [],
    not_used_reason_codes: [],
    used_effect: { added_count: 0 },
  };

  let selected_acts_final = [...selected_acts];

  if (!shouldCallRoutingHints(routingTriggers)) {
    routingHintsMeta = { ...routingHintsMeta, not_used_reason_codes: ['NOT_CALLED'] };
    incrementU4RoutingHintsNotUsed('NOT_CALLED');
  } else {
    const strongTrigger =
      confidentFamilyMismatch ||
      (familyEvidence.family_conflict && (selectedActsResult.selected_acts_confidence ?? 0) < 0.6);
    const evidenceFamilyKeys = new Set<string>();
    if (familyEvidence.dominant_family_key) evidenceFamilyKeys.add(familyEvidence.dominant_family_key);
    for (const family of familyEvidence.debug.top_families) evidenceFamilyKeys.add(family.family_key);
    const hasTaxonomyPrimaryForEvidence = [...evidenceFamilyKeys].some((familyKey) =>
      actCandidatesTopHydrated.some(
        (candidate) =>
          toFamilyKey(candidate.category) === familyKey &&
          classifyActKind(
            candidate.title ?? '',
            candidate.document_type,
            candidate.category,
            candidate.document_type_slug
          ) === 'PRIMARY_LAW'
      )
    );
    const zeroRecallCall = routingTriggers.selected_acts_empty_or_very_low === true;
    const mediumLowConfTrigger = routingTriggers.selected_acts_confidence_below_075 === true;
    if (!strongTrigger && !hasTaxonomyPrimaryForEvidence && !zeroRecallCall && !mediumLowConfTrigger) {
      routingHintsMeta = {
        ...routingHintsMeta,
        not_used_reason_codes: ['NOT_CALLED_NO_TAXONOMY_PRIMARY'],
      };
      incrementU4RoutingHintsNotUsed('NOT_CALLED_NO_TAXONOMY_PRIMARY');
    } else {
      const routingInput: RoutingHintsInput = {
        original_query: query,
        goals_summary: [{ goal_id: goalId }],
        taxonomy_snapshot_summary: `Categories: ${allowedFamilyKeys.slice(0, 20).join(', ')}`,
        family_evidence_summary: toFamilyEvidenceSummary(familyEvidence),
        selected_acts_decision_summary: {
          confidence: selectedActsResult.selected_acts_confidence,
          reason_codes: selectedActsResult.selected_acts_decision.reason_codes,
        },
        allowed_family_keys: allowedFamilyKeys,
        max_goals: 3,
      };
      const routingResult = await callRoutingHints(routingInput);
      const used_reason_codes: string[] = [];
      const not_used_reason_codes: string[] = [];
      const used_effect: RoutingHintsUsedEffect = { added_count: 0 };

      if (routingResult.call_failed_reason) {
        if (
          routingResult.call_failed_reason === 'INVALID_JSON' ||
          routingResult.call_failed_reason === 'INVALID_JSON_PARSE'
        ) {
          not_used_reason_codes.push('INVALID_JSON');
        } else if (
          routingResult.call_failed_reason === 'VALIDATION_FAILED' ||
          routingResult.call_failed_reason === 'INVALID_JSON_SCHEMA'
        ) {
          not_used_reason_codes.push('SCHEMA_MISMATCH');
        } else {
          not_used_reason_codes.push(routingResult.call_failed_reason.slice(0, 32));
        }
      }
      if (routingResult.output && !routingResult.output.routing?.families_ranked?.length) {
        not_used_reason_codes.push('NO_FAMILIES');
      }
      if (
        routingResult.output?.overall_confidence != null &&
        routingResult.output.overall_confidence < 0.55
      ) {
        not_used_reason_codes.push('CONF_TOO_LOW');
      }

      const conf = routingResult.output?.overall_confidence ?? 0;
      const expandAllowed =
        confidentFamilyMismatch ||
        familyWeakOrNoPrimary ||
        familyGuardMissingEvidence ||
        selectedActsResult.selected_acts_reason_codes.includes('COVERAGE_GUARD_FAILED') ||
        reasonCodes.includes('NO_STRONG_ACT_EVIDENCE');
      if (conf < 0.55 && !expandAllowed && routingResult.output?.routing?.families_ranked?.length) {
        not_used_reason_codes.push('EXPAND_NOT_ALLOWED');
      }

      routingHintsMeta = {
        enabled: config.u4RoutingHintsEnabled,
        called: routingResult.called,
        call_failed_reason: routingResult.call_failed_reason,
        model_id: routingResult.model_id,
        tokens_approx: routingResult.tokens_approx,
        families_ranked_top2: routingResult.output?.routing?.families_ranked?.slice(0, 2),
        goals_count: routingResult.output?.suggested_goals?.length ?? 0,
        used_reason_codes,
        not_used_reason_codes,
        used_effect,
        attempts: routingResult.attempts,
        parse_mode: routingResult.parse_mode,
      };

      if (routingResult.output?.overall_confidence != null && routingResult.output.overall_confidence < 0.55) {
        low_confidence_final = true;
        pushUnique(reasonCodes, 'ROUTING_HINTS_LOW_CONF');
      }

      const steerMode = conf >= 0.55;
      const expandOnlyMode = conf < 0.55 && expandAllowed;
      const mayApplyRouting =
        (routingResult.output?.routing?.families_ranked?.length ?? 0) > 0 && (steerMode || expandOnlyMode);

      if (mayApplyRouting) {
        const familiesRanked = (routingResult.output?.routing?.families_ranked ?? [])
          .slice(0, 5)
          .map((family) => family.family_key);
        const existingNregs = new Set(selected_acts_final.map((act) => act.rada_nreg));
        const breakdown: SelectedActsSourcesBreakdown = {
          ...selected_acts_sources_breakdown_final,
          from_routing_hints: [],
        };
        const hasPrimaryFromFamilyFor = async (familyKey: string): Promise<boolean> => {
          for (const act of selected_acts_final) {
            const candidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === act.rada_nreg);
            if (!candidate) continue;
            const meta = await getActMeta(act.rada_nreg);
            if (
              classifyActKind(
                candidate.title ?? '',
                candidate.document_type,
                candidate.category,
                candidate.document_type_slug
              ) === 'PRIMARY_LAW' &&
              toFamilyKey(meta?.category) === familyKey
            ) {
              return true;
            }
          }
          return false;
        };
        const hasTaxonomyPrimaryForFamily = (familyKey: string): boolean =>
          actCandidatesTopHydrated.some(
            (candidate) =>
              toFamilyKey(candidate.category) === familyKey &&
              classifyActKind(
                candidate.title ?? '',
                candidate.document_type,
                candidate.category,
                candidate.document_type_slug
              ) === 'PRIMARY_LAW' &&
              !existingNregs.has(candidate.rada_nreg)
          );

        let allRankedCovered = true;
        for (const familyKey of familiesRanked) {
          if (!(await hasPrimaryFromFamilyFor(familyKey))) {
            allRankedCovered = false;
            break;
          }
        }
        if (allRankedCovered) not_used_reason_codes.push('ALREADY_COVERED');

        let familyKeyTarget: string | null = null;
        if (confidentFamilyMismatch && familyEvidence.dominant_family_key) {
          if (!(await hasPrimaryFromFamilyFor(familyEvidence.dominant_family_key))) {
            familyKeyTarget = familyEvidence.dominant_family_key;
          }
        }
        if (familyKeyTarget == null) {
          for (const familyKey of familiesRanked) {
            if (await hasPrimaryFromFamilyFor(familyKey)) continue;
            if (hasTaxonomyPrimaryForFamily(familyKey)) {
              familyKeyTarget = familyKey;
              break;
            }
          }
        }
        if (familyKeyTarget == null && familiesRanked.length > 0) {
          for (const familyKey of familiesRanked) {
            if (!(await hasPrimaryFromFamilyFor(familyKey))) {
              familyKeyTarget = familyKey;
              not_used_reason_codes.push('NO_TAXONOMY_PRIMARY_ACT_PRECHECK');
              break;
            }
          }
        }

        if (familyKeyTarget != null && used_effect.added_count < 1) {
          if (selected_acts_final.length >= SELECTED_ACTS_MAX_OUT) {
            not_used_reason_codes.push('CAP_BLOCKED');
          } else {
            const taxonomyCandidates = actCandidatesTopHydrated
              .filter((candidate) => {
                if (existingNregs.has(candidate.rada_nreg)) return false;
                if (toFamilyKey(candidate.category) !== familyKeyTarget) return false;
                return classifyActKind(
                  candidate.title ?? '',
                  candidate.document_type,
                  candidate.category,
                  candidate.document_type_slug
                ) === 'PRIMARY_LAW';
              })
              .sort((a, b) => {
                const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
                if (scoreDiff !== 0) return scoreDiff;
                return a.rada_nreg.localeCompare(b.rada_nreg);
              });

            const hadCandidatesForFamily = actCandidatesTopHydrated.some(
              (candidate) => toFamilyKey(candidate.category) === familyKeyTarget
            );

            if (taxonomyCandidates.length === 0 && hadCandidatesForFamily) {
              not_used_reason_codes.push('ONLY_ORDERS_FOUND');
            }

            if (taxonomyCandidates.length > 0) {
              const best = taxonomyCandidates[0];
              selected_acts_final = [
                ...selected_acts_final,
                {
                  rada_nreg: best.rada_nreg,
                  act_title: best.title ?? '',
                  score: best.score ?? 0,
                  why_selected: expandOnlyMode ? 'routing_hints_family_boost' : 'routing_hints',
                  reason_tag: 'from_routing_hints',
                  source_tags: ['ROUTING_HINTS'],
                  document_type: best.document_type ?? undefined,
                  category: best.category ?? undefined,
                  act_kind: classifyActKind(
                    best.title ?? '',
                    best.document_type,
                    best.category,
                    best.document_type_slug
                  ),
                  flags: {},
                },
              ];
              breakdown.from_routing_hints?.push(best.rada_nreg);
              existingNregs.add(best.rada_nreg);
              used_effect.added_count += 1;
              used_effect.added_act = {
                rada_nreg: best.rada_nreg,
                title: best.title ?? '',
                family_key: familyKeyTarget,
                source: 'routing_hints_taxonomy',
              };
              used_reason_codes.push('ADDED_PRIMARY_LAW_FROM_TAXONOMY');
              if (expandOnlyMode) used_reason_codes.push('EXPAND_LOW_CONF');
            } else {
              not_used_reason_codes.push('NO_TAXONOMY_PRIMARY_ACT');
              const precheckFailed = not_used_reason_codes.includes('NO_TAXONOMY_PRIMARY_ACT_PRECHECK');
              const runExtraSearch =
                (precheckFailed ? conf >= 0.55 && strongTrigger : true) &&
                (!expandOnlyMode || used_effect.added_count < 1);
              if (runExtraSearch) {
                try {
                  const extraActs = await searchActsForRouting(routingResult.output?.query_variants?.[0]);
                  for (const extra of extraActs) {
                    const meta = await getActMeta(extra.rada_nreg);
                    if (!meta || existingNregs.has(extra.rada_nreg)) continue;
                    const familyKey = toFamilyKey(meta.category);
                    if (familyKey !== familyKeyTarget) continue;
                    if (
                      classifyActKind(
                        meta.title,
                        meta.document_type,
                        meta.category,
                        meta.document_type_slug
                      ) !== 'PRIMARY_LAW'
                    ) continue;
                    selected_acts_final = [
                      ...selected_acts_final,
                      {
                        rada_nreg: extra.rada_nreg,
                        act_title: meta.title,
                        score: extra.score ?? 0,
                        why_selected: 'routing_hints_family_boost',
                        reason_tag: 'from_routing_hints',
                        source_tags: ['ROUTING_HINTS'],
                        document_type: meta.document_type ?? undefined,
                        category: meta.category ?? undefined,
                        storage_category: meta.storage_category ?? undefined,
                        act_kind: classifyActKind(
                          meta.title,
                          meta.document_type,
                          meta.category,
                          meta.document_type_slug
                        ),
                        flags: {},
                      },
                    ];
                    breakdown.from_routing_hints?.push(extra.rada_nreg);
                    existingNregs.add(extra.rada_nreg);
                    used_effect.added_count += 1;
                    used_effect.added_act = {
                      rada_nreg: extra.rada_nreg,
                      title: meta.title,
                      family_key: familyKey,
                      source: 'extra_acts_search',
                    };
                    used_reason_codes.push('ADDED_PRIMARY_LAW_FROM_ACTS_SEARCH');
                    if (expandOnlyMode) used_reason_codes.push('EXPAND_LOW_CONF');
                    break;
                  }
                  if (used_effect.added_count === 0) not_used_reason_codes.push('NO_PRIMARY_ACT_FOUND');
                } catch {
                  not_used_reason_codes.push('NO_PRIMARY_ACT_FOUND');
                }
              } else {
                not_used_reason_codes.push('NO_PRIMARY_ACT_FOUND');
              }
            }
          }
        }

        if (used_effect.added_count > 0) {
          used_reason_codes.push('ADDED_PRIMARY_LAW');
          incrementU4RoutingHintsUsed();
        } else {
          for (const code of not_used_reason_codes) incrementU4RoutingHintsNotUsed(code);
        }

        const routing_path: 'TAXONOMY_FIRST' | 'ACTS_SEARCH' | 'NONE' =
          used_effect.added_act?.source === 'routing_hints_taxonomy'
            ? 'TAXONOMY_FIRST'
            : used_effect.added_act?.source === 'extra_acts_search'
              ? 'ACTS_SEARCH'
              : 'NONE';

        routingHintsMeta = {
          ...routingHintsMeta,
          used_reason_codes,
          not_used_reason_codes,
          used_effect,
          routing_path,
        };
        selected_acts_sources_breakdown_final = breakdown;
      } else {
        if (used_effect.added_count === 0) {
          for (const code of not_used_reason_codes) incrementU4RoutingHintsNotUsed(code);
        }
        routingHintsMeta = {
          ...routingHintsMeta,
          used_reason_codes,
          not_used_reason_codes,
          used_effect,
        };
      }
    }
  }

  const routingHintsAddedPrimaryLaw = routingHintsMeta.used_reason_codes.includes('ADDED_PRIMARY_LAW');
  let selectedActsFinalMeta = finalizeSelectedActsAfterRouting({
    selected_acts_before_routing: selected_acts,
    selected_acts_final,
    base_confidence: selectedActsResult.selected_acts_confidence,
    base_decision: selectedActsResult.selected_acts_decision,
    routing_hints_added_count: routingHintsMeta.used_effect.added_count,
    routing_hints_added_primary_law: routingHintsAddedPrimaryLaw,
    routing_hints_added_nregs: selected_acts_sources_breakdown_final.from_routing_hints,
    retrieval_evidence_nregs: finalHits.slice(0, 30).map((hit) => hit.rada_nreg ?? '').filter(Boolean),
  });
  selected_acts_final = selectedActsFinalMeta.selected_acts_final as SelectedActTraceItem[];
  const chunksEvidenceByNreg = new Map(chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const));
  const singleActScopeSelection = await resolveSingleActScopeSelection({
    query,
    selectedActsFinal: selected_acts_final,
    selectedActsSourcesBreakdownFinal: selected_acts_sources_breakdown_final,
    selectedActsFinalMeta: selectedActsFinalMeta,
    reasonCodes,
    chunksEvidenceTopActs,
    actCandidatesTopHydrated,
    exactActNregs,
    groundedActNregs,
    topScore,
    getActMeta,
    metadataGroundingReasonCodes: METADATA_GROUNDING_REASON_CODES,
    nonPrimaryAuthoritativeKinds,
  });
  selected_acts_final = singleActScopeSelection.selectedActsFinal as SelectedActTraceItem[];
  selected_acts_sources_breakdown_final = singleActScopeSelection.selectedActsSourcesBreakdownFinal;
  selectedActsFinalMeta = singleActScopeSelection.selectedActsFinalMeta;
  reasonCodes.splice(0, reasonCodes.length, ...singleActScopeSelection.reasonCodes);
  const exactActNregSet = singleActScopeSelection.exactActNregSet;
  const exactSingleActConverged = singleActScopeSelection.exactSingleActConverged;
  const groundedActNregSet = singleActScopeSelection.groundedActNregSet;
  const groundedSingleActConverged = singleActScopeSelection.groundedSingleActConverged;
  const explicitActScopeCueQuery = singleActScopeSelection.explicitActScopeCueQuery;
  const metadataSingleActConverged = singleActScopeSelection.metadataSingleActConverged;
  const topActCandidate = singleActScopeSelection.topActCandidate;
  if (
    routingHintsMeta.used_effect.added_act?.rada_nreg &&
    !new Set(selected_acts_final.map((act) => act.rada_nreg).filter(Boolean)).has(routingHintsMeta.used_effect.added_act.rada_nreg)
  ) {
    routingHintsMeta = {
      ...routingHintsMeta,
      used_effect: { added_count: 0 },
      not_used_reason_codes: uniqueStrings([
        ...routingHintsMeta.not_used_reason_codes,
        'FINALIZER_DROPPED_ROUTING_ADD',
      ]),
    };
  }

  const hasPrimarySelectedAct = selected_acts_final.some((act) => act.act_kind === 'PRIMARY_LAW');
  const leadSelectedEvidence = selected_acts_final[0]
    ? chunksEvidenceByNreg.get(selected_acts_final[0].rada_nreg)
    : undefined;
  const exactLeadEvidence =
    exactSingleActConverged && exactActNregSet.size === 1
      ? chunksEvidenceTopActs.find((item) => exactActNregSet.has(item.rada_nreg))
      : undefined;
  const groundedLeadEvidence =
    groundedSingleActConverged && groundedActNregSet.size === 1
      ? chunksEvidenceTopActs.find((item) => groundedActNregSet.has(item.rada_nreg))
      : undefined;
  const metadataLeadEvidence =
    metadataSingleActConverged && topActCandidate?.rada_nreg
      ? chunksEvidenceTopActs.find((item) => item.rada_nreg === topActCandidate.rada_nreg)
      : undefined;
  const exactActScopeResolved =
    exactSingleActConverged &&
    selected_acts_final.length > 0 &&
    selected_acts_final.every((act) => exactActNregSet.has(act.rada_nreg)) &&
    (
      (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.55 ||
      (
        (topScore ?? 0) >= 0.72 &&
        (exactLeadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
        (exactLeadEvidence?.count_in_top30 ?? 0) >= 1
      )
    );
  const groundedActScopeResolved =
    groundedSingleActConverged &&
    selected_acts_final.length > 0 &&
    selected_acts_final.every((act) => groundedActNregSet.has(act.rada_nreg)) &&
    (
      (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.55 ||
      (
        (topScore ?? 0) >= 0.72 &&
        (groundedLeadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
        (groundedLeadEvidence?.count_in_top30 ?? 0) >= 1
      )
    );
  const metadataActScopeResolved =
    metadataSingleActConverged &&
    !!topActCandidate?.rada_nreg &&
    selected_acts_final.length > 0 &&
    selected_acts_final.every((act) => act.rada_nreg === topActCandidate.rada_nreg) &&
    (
      (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.55 ||
      (
        (topScore ?? 0) >= 0.68 &&
        (metadataLeadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 15 &&
        (metadataLeadEvidence?.count_in_top30 ?? 0) >= 1
      )
    );
  const groundedActScopeNoConvergence =
    groundedSingleActConverged &&
    selected_acts_final.length > 0 &&
    !selected_acts_final.every((act) => groundedActNregSet.has(act.rada_nreg));
  const authoritativeNonPrimaryScopeResolved =
    explicitActScopeCueQuery &&
    !hasPrimarySelectedAct &&
    selected_acts_final.length === 1 &&
    nonPrimaryAuthoritativeKinds.has(selected_acts_final[0]?.act_kind ?? '') &&
    (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.75 &&
    (leadSelectedEvidence?.count_in_top30 ?? 0) >= 5 &&
    (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
    (topScore ?? 0) >= 0.5;
  if (
    familyEvidence.reason_codes.includes('NO_PRIMARY_LAW_EVIDENCE') &&
    !hasPrimarySelectedAct &&
    selected_acts_final.length > 0 &&
    !exactActScopeResolved &&
    !groundedActScopeResolved &&
    !metadataActScopeResolved &&
    !authoritativeNonPrimaryScopeResolved
  ) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (exactActScopeResolved || groundedActScopeResolved || metadataActScopeResolved || authoritativeNonPrimaryScopeResolved) {
    const recoverableExactScopeCodes = [
      'NON_PRIMARY_ONLY_WEAK_CONFIDENCE',
      'NO_PRIMARY_LAW_EVIDENCE',
      'LOW_EVIDENCE',
      'ACT_SELECTION_LOW_CONFIDENCE',
      'NO_STRONG_ACT_EVIDENCE',
      'OOD_GUARD_WEAK_BUT_ACT_GROUNDED',
      'OUT_OF_SCOPE',
    ];
    reasonCodes.splice(0, reasonCodes.length, ...removeReasonCodes(reasonCodes, recoverableExactScopeCodes));
    const hasIrrecoverableLowConfidenceReason = reasonCodes.some((code) =>
      [
        'OUT_OF_SCOPE',
        'MISSING_TAXONOMY_CONVERGENCE',
        'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
        'GROUNDED_ACT_SCOPE_NO_CONVERGENCE',
      ].includes(code)
    );
    if (!hasIrrecoverableLowConfidenceReason) {
      low_confidence_final = false;
      pushUnique(
        reasonCodes,
        exactActScopeResolved
          ? 'EXACT_ACT_SCOPE_CONFIRMED'
          : groundedActScopeResolved
            ? 'GROUNDED_ACT_SCOPE_CONFIRMED'
            : metadataActScopeResolved
              ? 'METADATA_ACT_SCOPE_CONFIRMED'
            : 'AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED'
      );
    }
  }
  if (exactSingleActConverged && selected_acts_final.length === 0) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'EXACT_ACT_SCOPE_NO_CONVERGENCE');
    pushUnique(reasonCodes, 'NO_STRONG_ACT_EVIDENCE');
  }
  if (groundedSingleActConverged && selected_acts_final.length === 0) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'GROUNDED_ACT_SCOPE_NO_CONVERGENCE');
    pushUnique(reasonCodes, 'NO_STRONG_ACT_EVIDENCE');
  }
  if (metadataSingleActConverged && selected_acts_final.length === 0) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'METADATA_ACT_SCOPE_NO_CONVERGENCE');
    pushUnique(reasonCodes, 'NO_STRONG_ACT_EVIDENCE');
  }

  const leadSelectedAct = selected_acts_final[0];
  const leadSelectedCandidate = leadSelectedAct
    ? actCandidatesTopHydrated.find((candidate) => candidate.rada_nreg === leadSelectedAct.rada_nreg)
    : undefined;
  const leadSelectedMetadataGrounded =
    isMetadataGroundedActCandidate(
      leadSelectedCandidate,
      query,
      METADATA_GROUNDING_REASON_CODES
    );
  const hasStructuredGroundingSignals =
    (documentTypeHints?.length ?? 0) > 0 ||
    entitiesCount > 0 ||
    anchorsCount > 0;
  const selectedPrimaryActs = selected_acts_final.filter((act) => act.act_kind === 'PRIMARY_LAW');
  const selectedPrimaryFamilies = selectedPrimaryActs.map((act) =>
    toFamilyKey(
      actCandidatesTopHydrated.find((candidate) => candidate.rada_nreg === act.rada_nreg)?.category ?? act.category
    )
  );
  const distinctPrimaryFamilies = [...new Set(selectedPrimaryFamilies.filter(Boolean))];
  const metadataGroundedPrimaryActsCount = selectedPrimaryActs.filter((act) => {
    const candidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === act.rada_nreg);
    return isMetadataGroundedActCandidate(candidate, query, METADATA_GROUNDING_REASON_CODES);
  }).length;
  const leadSelectedFamilyKey = toFamilyKey(leadSelectedCandidate?.category ?? leadSelectedAct?.category);
  const hasDomainAlignedPrimaryFamily = selectedPrimaryFamilies.some((familyKey) =>
    isDomainHintAlignedFamily(domainHint, familyKey)
  );
  const leadSelectedFamilyAlignedToDomain = isDomainHintAlignedFamily(domainHint, leadSelectedFamilyKey);
  const proceduralOnlyPrimarySelection =
    selectedPrimaryActs.length > 0 &&
    selected_acts_final.length === selectedPrimaryActs.length &&
    selectedPrimaryActs.every((act) => {
      const candidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === act.rada_nreg);
      const familyKey = toFamilyKey(candidate?.category ?? act.category);
      return familyKey.includes('procedure') || familyKey === 'judiciary_justice';
    });
  const fragmentedPrimaryFamilySelection =
    distinctPrimaryFamilies.length >= 3 && (topScore ?? 0) < 0.6;
  const multiFamilyUngroundedSelection =
    !isSpecificDomainHint(domainHint) &&
    distinctPrimaryFamilies.length >= 2 &&
    metadataGroundedPrimaryActsCount === 0 &&
    (topScore ?? 0) < 0.55;
  const domainHintPrimaryFamilyMismatch =
    isSpecificDomainHint(domainHint) &&
    distinctPrimaryFamilies.length >= 2 &&
    hasDomainAlignedPrimaryFamily &&
    !leadSelectedFamilyAlignedToDomain &&
    (topScore ?? 0) < 0.6;
  const missingTaxonomyConvergence =
    taxonomyActCount === 0 &&
    exactActHitCount === 0 &&
    groundedActHitCount === 0 &&
    (documentTypeHints?.length ?? 0) > 0 &&
    selectedPrimaryActs.length >= 2 &&
    distinctPrimaryFamilies.length >= 2 &&
    !leadSelectedMetadataGrounded &&
    (topScore ?? 0) < 0.66;
  const diffuseTaxonomyConvergence =
    exactActHitCount === 0 &&
    groundedActHitCount === 0 &&
    (taxonomyActCount === 0 || taxonomyActCount >= 8);
  const explicitActScopeNoConvergence =
    (hasExplicitActScopeCue(query) || extractStructuredActIdentifiers(query).length >= 1) &&
    diffuseTaxonomyConvergence &&
    selectedPrimaryActs.length >= 1 &&
    (topScore ?? 0) < 0.68;
  const proceduralPrimaryWithoutActGrounding = shouldFlagProceduralPrimaryWithoutActGrounding({
    proceduralOnlyPrimarySelection,
    explicitActScopeCue: hasExplicitActScopeCue(query),
    structuredActIdentifiersCount: extractStructuredActIdentifiers(query).length,
    documentTypeHintsCount: documentTypeHints?.length ?? 0,
    anchorsCount,
    exactActHitCount,
    groundedActHitCount,
    metadataGroundedPrimaryActsCount,
    leadSelectedMetadataGrounded,
  });

  if (fragmentedPrimaryFamilySelection) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'FRAGMENTED_PRIMARY_FAMILY_SELECTION');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (domainHintPrimaryFamilyMismatch) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'DOMAIN_HINT_PRIMARY_FAMILY_MISMATCH');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (multiFamilyUngroundedSelection) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'UNGROUNDED_MULTI_FAMILY_SELECTION');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (missingTaxonomyConvergence) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'MISSING_TAXONOMY_CONVERGENCE');
    pushUnique(reasonCodes, 'NO_STRONG_ACT_EVIDENCE');
  }
  if (explicitActScopeNoConvergence) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE');
    pushUnique(reasonCodes, 'NO_STRONG_ACT_EVIDENCE');
  }
  if (groundedActScopeNoConvergence) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'GROUNDED_ACT_SCOPE_NO_CONVERGENCE');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (proceduralPrimaryWithoutActGrounding) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY');
    pushUnique(reasonCodes, 'NO_STRONG_ACT_EVIDENCE');
  }
  if (
    hasPrimarySelectedAct &&
    !hasStructuredGroundingSignals &&
    !leadSelectedMetadataGrounded &&
    selected_acts_final.length > 0
  ) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'UNGROUNDED_PRIMARY_FALLBACK');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }

  if (
    low_confidence_final &&
    routingHintsAddedPrimaryLaw &&
    selectedActsFinalMeta.routing_hints_recovered_with_retrieval_evidence &&
    selectedActsFinalMeta.selected_acts_confidence_final >= 0.6 &&
    !hasStickySingleGoalLowConfidenceReason(reasonCodes) &&
    !reasonCodes.includes('OUT_OF_SCOPE') &&
    !reasonCodes.includes('LOW_EVIDENCE') &&
    !reasonCodes.includes('ROUTING_HINTS_LOW_CONF')
  ) {
    low_confidence_final = false;
    const index = reasonCodes.indexOf('ACT_SELECTION_LOW_CONFIDENCE');
    if (index >= 0) reasonCodes.splice(index, 1);
  }

  if (low_confidence_final && selected_acts_final.length > 2) {
    const evidenceByNreg = new Map(chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const));
    selected_acts_final = [...selected_acts_final]
      .sort((left, right) => {
        const leftDomainAligned =
          left.act_kind === 'PRIMARY_LAW' &&
          isDomainHintAlignedFamily(
            domainHint,
            actCandidatesTopHydrated.find((candidate) => candidate.rada_nreg === left.rada_nreg)?.category ?? left.category
          );
        const rightDomainAligned =
          right.act_kind === 'PRIMARY_LAW' &&
          isDomainHintAlignedFamily(
            domainHint,
            actCandidatesTopHydrated.find((candidate) => candidate.rada_nreg === right.rada_nreg)?.category ?? right.category
          );
        if (leftDomainAligned !== rightDomainAligned) return rightDomainAligned ? 1 : -1;
        const leftEvidence = evidenceByNreg.get(left.rada_nreg ?? '');
        const rightEvidence = evidenceByNreg.get(right.rada_nreg ?? '');
        const rankMassDiff = (rightEvidence?.rank_mass_top30 ?? 0) - (leftEvidence?.rank_mass_top30 ?? 0);
        if (rankMassDiff !== 0) return rankMassDiff;
        const bestRankDiff =
          (leftEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) -
          (rightEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY);
        if (bestRankDiff !== 0) return bestRankDiff;
        const orderingDiff = (rightEvidence?.max_ordering_score ?? 0) - (leftEvidence?.max_ordering_score ?? 0);
        if (orderingDiff !== 0) return orderingDiff;
        return (right.score ?? 0) - (left.score ?? 0);
      })
      .slice(0, 2);
    pushUnique(reasonCodes, 'LOW_CONFIDENCE_TAIL_TRIMMED');
  }

  const finalReasonCodes = normalizeFinalReasonCodes([
    ...reasonCodes,
    ...(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? []),
  ], low_confidence_final);

  const coverageGap = deriveCoverageGap({
    lowConfidence: low_confidence_final,
    reasonCodes: finalReasonCodes,
    selectedActsCount: selected_acts_final.length,
    selectedActsConfidence: selectedActsFinalMeta.selected_acts_confidence_final,
    selectedActKinds: selected_acts_final.map((act) => act.act_kind ?? 'UNKNOWN'),
    exactActHitCount,
    groundedActHitCount,
    metadataGroundedActCount: metadataSingleActConverged ? 1 : 0,
    hitsCount: finalHits.length,
    topScore,
    domainHint,
    categoryHintCount: categoryHintsCount,
    documentTypeHintCount: documentTypeHints?.length ?? 0,
    entitiesCount,
    anchorsCount,
  });

  return {
    reasonCodes: finalReasonCodes,
    selected_acts_final,
    selected_acts_sources_breakdown_final,
    chunks_evidence_top_acts: chunksEvidenceTopActs,
    selectedActsFinalMeta,
    familyEvidence,
    routingHintsMeta,
    low_confidence_final,
    coverageGap,
    oodGuardResult,
    specializedDomainNoPrimary,
    coverageGuardFiredButFamilyOk: coverageGuardRecoveredWithActGrounding,
    recoveredEmptySelected,
  };
}
