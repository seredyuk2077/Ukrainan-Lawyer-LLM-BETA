import { config } from '../lib/config.js';
import {
  incrementU4RoutingHintsNotUsed,
  incrementU4RoutingHintsUsed,
} from '../gateway/observability.js';
import {
  extractStructuredActIdentifiers,
  extractQuotedActTitleFragments,
  queryLooksAmendmentFocused,
  type ActMeta,
} from './act-taxonomy-store.js';
import { deriveCoverageGap } from './finalization/coverage-gap.js';
import {
  areCompatiblePrimaryFamilies,
  isDomainHintAlignedFamily,
  isProceduralFamilyKey,
  isSpecificDomainHint,
  toFamilyKey,
} from './family-alignment.js';
import { computeFamilyEvidence, toFamilyEvidenceSummary, type FamilyEvidence } from './family-evidence.js';
import { hasExplicitActScopeCue } from './goal-splitter.js';
import {
  candidateMatchesExplicitPersonIdentityQuery,
  extractStrictActScopeReferenceSignals,
  hasActTitleSupportOverlap,
  isExplicitlyHintedSupportActCandidate,
  isInterrogativePrimaryLawLocatorQuery,
  isMetadataGroundedActCandidate,
  queryHasExplicitPersonIdentityCue,
  isTrustedExplicitGroundedActScopeCandidate,
  queryHasExplicitCalendarDate,
  queryRequestsPrimaryLawLikeAct,
  resolveSingleActScopeSelection,
} from './single-goal-act-scope.js';
import {
  canRelaxCoverageGuardWithActGrounding,
  hasStickySingleGoalLowConfidenceReason,
  shouldFlagProceduralPrimaryWithoutActGrounding,
} from './finalization/single-goal-honesty.js';
import { normalizeSingleGoalLowConfidenceSelection } from './finalization/single-goal-final-honesty.js';
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
  documentTypeHintMatches,
  isExplicitlyHintedNonPrimaryAct,
  SELECTED_ACTS_MAX_OUT,
  type ActCandidateInput,
  type BuildSelectedActsOutput,
  type SelectedActOutput,
} from './selected-acts.js';
import {
  finalizeSelectedActsAfterRouting,
  updateSelectedActsFinalMeta,
  type FinalizeSelectedActsAfterRoutingOutput,
  type SelectedActsSourcesBreakdownLike,
} from './finalization/selected-acts-finalizer.js';
import type { CoverageGap, RawHit } from './types.js';
import {
  buildNormalizedNregMap,
  getByNormalizedNreg,
  normalizeRadaNreg,
  pushUnique,
  removeReasonCodes,
  sameRadaNreg,
  uniqueStrings,
} from './helpers/retrieval-utils.js';
export { isDomainHintAlignedFamily } from './family-alignment.js';

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

type SelectedActsSourcesBreakdown = SelectedActsSourcesBreakdownLike;

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

export function shouldConfirmSoftProceduralSingleAct(input: {
  query: string;
  domainHint?: string;
  reasonCodes: string[];
  topScore?: number | null;
  selectedActsCount: number;
  leadAct?:
    | {
        act_kind?: string | null;
        category?: string | null;
      }
    | null;
  leadEvidence?:
    | {
        count_in_top30?: number;
        best_rank_in_top30?: number;
        rank_mass_top30?: number;
        max_ordering_score?: number;
      }
    | null;
  familyDominantOk: boolean;
  proceduralOnlyPrimarySelection: boolean;
  interrogativePrimaryLawLocatorQuery: boolean;
}): boolean {
  if (input.selectedActsCount !== 1) return false;
  if (input.leadAct?.act_kind !== 'PRIMARY_LAW') return false;
  if (!isProceduralFamilyKey(input.leadAct?.category)) return false;
  if (!input.proceduralOnlyPrimarySelection) return false;
  if (!input.familyDominantOk) return false;
  if (input.interrogativePrimaryLawLocatorQuery) return false;
  if (hasExplicitActScopeCue(input.query)) return false;

  const blockingReasonCodes = new Set([
    'OUT_OF_SCOPE',
    'NO_STRONG_ACT_EVIDENCE',
    'MISSING_TAXONOMY_CONVERGENCE',
    'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
    'GROUNDED_ACT_SCOPE_NO_CONVERGENCE',
    'METADATA_ACT_SCOPE_NO_CONVERGENCE',
    'EVIDENCE_ACT_SCOPE_NO_CONVERGENCE',
    'COVERAGE_MISS_SELECTED_ACTS',
    'COVERAGE_GUARD_FAILED',
    'FAMILY_GUARD_NO_EVIDENCE',
    'FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE',
    'NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY',
    'UNGROUNDED_PRIMARY_FALLBACK',
    'UNGROUNDED_PRIMARY_COMPANION_FALLBACK',
  ]);
  if (input.reasonCodes.some((reasonCode) => blockingReasonCodes.has(reasonCode))) return false;

  const recoveryReasonCodes = new Set([
    'FRAGMENTED_PRIMARY_FAMILY_SELECTION',
    'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
    'LOW_EVIDENCE',
    'ACT_SELECTION_LOW_CONFIDENCE',
    'CHUNKS_FAMILY_MISMATCH_DEMOTED',
    'SUPPORT_FAMILY_MISMATCH_BLOCKED',
  ]);
  if (!input.reasonCodes.some((reasonCode) => recoveryReasonCodes.has(reasonCode))) return false;

  const bestRank = input.leadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const countInTop30 = input.leadEvidence?.count_in_top30 ?? 0;
  const rankMassTop30 = input.leadEvidence?.rank_mass_top30 ?? 0;
  const maxOrderingScore = input.leadEvidence?.max_ordering_score ?? 0;
  const topScore = input.topScore ?? 0;

  return (
    bestRank <= 3 &&
    countInTop30 >= 5 &&
    rankMassTop30 >= 1.2 &&
    maxOrderingScore >= 0.52 &&
    topScore >= 0.56 &&
    isDomainHintAlignedFamily(input.domainHint, input.leadAct?.category)
  );
}

export function shouldConfirmSoftPrimarySingleAct(input: {
  query?: string;
  domainHint?: string;
  reasonCodes: string[];
  topScore?: number | null;
  selectedActsCount: number;
  leadAct?:
    | {
        act_kind?: string | null;
        category?: string | null;
      }
    | null;
  leadEvidence?:
    | {
        count_in_top30?: number;
        best_rank_in_top30?: number;
        rank_mass_top30?: number;
        max_ordering_score?: number;
      }
    | null;
  familyDominantOk: boolean;
}): boolean {
  if (input.selectedActsCount !== 1) return false;
  if (input.leadAct?.act_kind !== 'PRIMARY_LAW') return false;
  if (input.query && hasExplicitActScopeCue(input.query)) return false;
  if (!input.familyDominantOk) return false;

  const blockingReasonCodes = new Set([
    'OUT_OF_SCOPE',
    'MISSING_TAXONOMY_CONVERGENCE',
    'COVERAGE_MISS_SELECTED_ACTS',
    'COVERAGE_GUARD_FAILED',
    'FAMILY_GUARD_NO_EVIDENCE',
    'FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE',
    'DOMAIN_HINT_PRIMARY_FAMILY_MISMATCH',
    'DOMAIN_HINT_NO_ALIGNED_PRIMARY_FAMILY',
    'NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY',
    'UNGROUNDED_MULTI_FAMILY_SELECTION',
  ]);
  if (input.reasonCodes.some((reasonCode) => blockingReasonCodes.has(reasonCode))) return false;

  const recoveryReasonCodes = new Set([
    'FRAGMENTED_PRIMARY_FAMILY_SELECTION',
    'LOW_EVIDENCE',
    'ACT_SELECTION_LOW_CONFIDENCE',
    'CHUNKS_FAMILY_MISMATCH_DEMOTED',
    'SUPPORT_FAMILY_MISMATCH_BLOCKED',
    'UNGROUNDED_PRIMARY_FALLBACK',
    'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
  ]);
  if (!input.reasonCodes.some((reasonCode) => recoveryReasonCodes.has(reasonCode))) return false;

  const bestRank = input.leadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const countInTop30 = input.leadEvidence?.count_in_top30 ?? 0;
  const rankMassTop30 = input.leadEvidence?.rank_mass_top30 ?? 0;
  const maxOrderingScore = input.leadEvidence?.max_ordering_score ?? 0;
  const topScore = input.topScore ?? 0;
  const domainAligned =
    !isSpecificDomainHint(input.domainHint) || isDomainHintAlignedFamily(input.domainHint, input.leadAct?.category);
  if (!domainAligned) return false;

  return (
    (
      bestRank <= 2 &&
      countInTop30 >= 6 &&
      rankMassTop30 >= 2 &&
      maxOrderingScore >= 0.44 &&
      topScore >= 0.56
    ) ||
    (
      bestRank <= 4 &&
      countInTop30 >= 8 &&
      rankMassTop30 >= 3 &&
      maxOrderingScore >= 0.42 &&
      topScore >= 0.54
    )
  );
}

export function shouldConfirmSoftNonPrimarySingleAct(input: {
  query?: string;
  reasonCodes: string[];
  topScore?: number | null;
  selectedActsCount: number;
  leadAct?:
    | {
        rada_nreg?: string | null;
        act_title?: string | null;
        document_type?: string | null;
        act_kind?: string | null;
      }
    | null;
  leadCandidate?:
    | {
        rada_nreg?: string | null;
        title?: string | null;
        document_type?: string | null;
        document_type_slug?: string | null;
        reasons?: string[] | null;
        score?: number | null;
      }
    | null;
  leadEvidence?:
    | {
        count_in_top30?: number;
        best_rank_in_top30?: number;
        rank_mass_top30?: number;
        max_ordering_score?: number;
      }
    | null;
}): boolean {
  if (input.selectedActsCount !== 1) return false;
  if (!input.leadAct?.act_kind || input.leadAct.act_kind === 'PRIMARY_LAW') return false;
  if (input.query && hasExplicitActScopeCue(input.query)) {
    const strictExplicitScopedCandidate =
      input.leadCandidate &&
      isTrustedExplicitGroundedActScopeCandidate(
        {
          rada_nreg: input.leadCandidate.rada_nreg ?? input.leadAct.rada_nreg ?? '',
          title: input.leadCandidate.title ?? input.leadAct.act_title ?? null,
          document_type: input.leadCandidate.document_type ?? input.leadAct.document_type ?? null,
          document_type_slug: input.leadCandidate.document_type_slug ?? null,
          reasons: input.leadCandidate.reasons ?? [],
          score: input.leadCandidate.score ?? 0,
        },
        input.query,
        METADATA_GROUNDING_REASON_CODES
      );
    if (!strictExplicitScopedCandidate) return false;
  }

  const scopeConfirmationReasonCodes = new Set([
    'GROUNDED_ACT_SCOPE_CONFIRMED',
    'METADATA_ACT_SCOPE_CONFIRMED',
    'EVIDENCE_ACT_SCOPE_CONFIRMED',
    'GROUNDED_ACT_SCOPE_RECOVERED',
    'METADATA_ACT_SCOPE_RECOVERED',
    'EVIDENCE_ACT_SCOPE_RECOVERED',
  ]);
  const hasScopeConfirmation = input.reasonCodes.some((reasonCode) => scopeConfirmationReasonCodes.has(reasonCode));
  const hasSoftDateScopedRecurringSurface =
    !!input.query &&
    !hasExplicitActScopeCue(input.query) &&
    queryHasExplicitCalendarDate(input.query) &&
    hasActTitleSupportOverlap(
      input.query,
      input.leadCandidate?.title ?? input.leadAct?.act_title ?? '',
      input.leadCandidate?.document_type ?? input.leadAct?.document_type ?? null
    );
  if (!hasScopeConfirmation && !hasSoftDateScopedRecurringSurface) {
    return false;
  }

  const blockingReasonCodes = new Set([
    'OUT_OF_SCOPE',
    'MISSING_TAXONOMY_CONVERGENCE',
    'COVERAGE_MISS_SELECTED_ACTS',
    'COVERAGE_GUARD_FAILED',
    'FAMILY_GUARD_NO_EVIDENCE',
    'FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE',
  ]);
  if (input.reasonCodes.some((reasonCode) => blockingReasonCodes.has(reasonCode))) return false;

  const recoveryReasonCodes = new Set([
    'CALENDAR_SCOPED_ACT_NO_UNIQUE_CONVERGENCE',
    'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
    'LOW_EVIDENCE',
    'NO_STRONG_ACT_EVIDENCE',
    'ACT_SELECTION_LOW_CONFIDENCE',
    'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
    'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
    'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
  ]);
  const recurringRecoveryReasonCodes = new Set([
    'NON_PRIMARY_ONLY_WEAK_CONFIDENCE',
    'NO_PRIMARY_LAW_EVIDENCE',
    'LOW_EVIDENCE',
  ]);
  if (
    !input.reasonCodes.some((reasonCode) => recoveryReasonCodes.has(reasonCode)) &&
    !(hasSoftDateScopedRecurringSurface && input.reasonCodes.some((reasonCode) => recurringRecoveryReasonCodes.has(reasonCode)))
  ) {
    return false;
  }

  const bestRank = input.leadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const countInTop30 = input.leadEvidence?.count_in_top30 ?? 0;
  const rankMassTop30 = input.leadEvidence?.rank_mass_top30 ?? 0;
  const maxOrderingScore = input.leadEvidence?.max_ordering_score ?? 0;
  const topScore = input.topScore ?? 0;
  const recoveredDateScopedRecurringSingleAct =
    hasSoftDateScopedRecurringSurface &&
    input.reasonCodes.includes('SOFT_NON_PRIMARY_SINGLE_ACT_RECOVERED') &&
    countInTop30 >= 1 &&
    bestRank <= 4;
  const hasExplicitDateScopedIdentityMatch =
    !!input.query &&
    queryHasExplicitCalendarDate(input.query) &&
    (
      (input.leadCandidate?.reasons ?? []).includes('rada_datred_match') ||
      (input.leadCandidate?.reasons ?? []).includes('referenced_rada_datred_match') ||
      (input.leadCandidate?.reasons ?? []).includes('rada_month_match') ||
      (input.leadCandidate?.reasons ?? []).includes('referenced_rada_month_match')
    );

  if (hasSoftDateScopedRecurringSurface && !hasScopeConfirmation) {
    return (
      bestRank <= 4 &&
      countInTop30 >= 1 &&
      maxOrderingScore >= 0.39 &&
      topScore >= 0.68 &&
      (rankMassTop30 >= 0.2 || bestRank <= 2)
    );
  }

  if (hasScopeConfirmation && hasExplicitDateScopedIdentityMatch) {
    if (recoveredDateScopedRecurringSingleAct) {
      return (
        bestRank <= 4 &&
        countInTop30 >= 1 &&
        maxOrderingScore >= 0.39 &&
        topScore >= 0.68 &&
        (rankMassTop30 >= 0.2 || bestRank <= 2)
      );
    }
    return (
      bestRank <= 2 &&
      countInTop30 >= 1 &&
      maxOrderingScore >= 0.39 &&
      topScore >= 0.68 &&
      rankMassTop30 >= 0.24
    );
  }

  return (
    (
      bestRank <= 2 &&
      maxOrderingScore >= 0.44 &&
      topScore >= 0.52 &&
      (countInTop30 >= 1 || rankMassTop30 >= 0.35)
    ) ||
    (
      bestRank <= 5 &&
      countInTop30 >= 3 &&
      maxOrderingScore >= 0.38 &&
      topScore >= 0.5
    )
  );
}

type SoftBundleSelectedActLike = {
  rada_nreg?: string | null;
  act_kind?: string | null;
  category?: string | null;
};

type SoftBundleEvidenceLike = {
  count_in_top30?: number;
  best_rank_in_top30?: number;
  rank_mass_top30?: number;
  max_ordering_score?: number;
};

function hasRecoverableSoftBundleEvidence(
  evidence: SoftBundleEvidenceLike | undefined
): boolean {
  if (!evidence) return false;
  const bestRank = evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const countInTop30 = evidence.count_in_top30 ?? 0;
  const rankMassTop30 = evidence.rank_mass_top30 ?? 0;
  const maxOrderingScore = evidence.max_ordering_score ?? 0;
  return (
    (
      bestRank <= 8 &&
      countInTop30 >= 2 &&
      rankMassTop30 >= 0.18 &&
      maxOrderingScore >= 0.36
    ) ||
    (
      bestRank <= 4 &&
      countInTop30 >= 1 &&
      maxOrderingScore >= 0.44
    )
  );
}

function hasStrongLeadSoftBundleEvidence(
  evidence: SoftBundleEvidenceLike | undefined
): boolean {
  if (!evidence) return false;
  return (
    (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 4 &&
    (evidence.count_in_top30 ?? 0) >= 2 &&
    (evidence.rank_mass_top30 ?? 0) >= 0.3 &&
    (evidence.max_ordering_score ?? 0) >= 0.4
  );
}

function hasCompatibleSoftPrimaryBundleFamilies(
  domainHint: string | undefined,
  familyKeys: string[]
): boolean {
  if (familyKeys.length !== 2) return false;
  const [leftFamily, rightFamily] = familyKeys;
  if (areCompatiblePrimaryFamilies(leftFamily, rightFamily)) return true;
  const leftProcedural = isProceduralFamilyKey(leftFamily);
  const rightProcedural = isProceduralFamilyKey(rightFamily);
  if (leftProcedural === rightProcedural) return false;
  const substantiveFamily = leftProcedural ? rightFamily : leftFamily;
  return isDomainHintAlignedFamily(domainHint, substantiveFamily);
}

export function shouldConfirmSoftPrimaryLawTwoActBundle(input: {
  query?: string;
  domainHint?: string;
  reasonCodes: string[];
  topScore?: number | null;
  selectedActs: SoftBundleSelectedActLike[];
  evidenceByNreg: Map<string, SoftBundleEvidenceLike>;
  familyDominantOk: boolean;
}): boolean {
  if (input.selectedActs.length !== 2) return false;
  if (input.selectedActs.some((act) => act.act_kind !== 'PRIMARY_LAW')) return false;
  if (input.query && hasExplicitActScopeCue(input.query)) return false;
  if (!input.familyDominantOk) return false;

  const blockingReasonCodes = new Set([
    'OUT_OF_SCOPE',
    'MISSING_TAXONOMY_CONVERGENCE',
    'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
    'GROUNDED_ACT_SCOPE_NO_CONVERGENCE',
    'EVIDENCE_ACT_SCOPE_NO_CONVERGENCE',
    'COVERAGE_MISS_SELECTED_ACTS',
    'COVERAGE_GUARD_FAILED',
    'FAMILY_GUARD_NO_EVIDENCE',
    'FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE',
    'DOMAIN_HINT_NO_ALIGNED_PRIMARY_FAMILY',
    'UNGROUNDED_MULTI_FAMILY_SELECTION',
    'UNGROUNDED_GENERAL_PRIMARY_FALLBACK',
  ]);
  if (input.reasonCodes.some((reasonCode) => blockingReasonCodes.has(reasonCode))) return false;

  const recoveryReasonCodes = new Set([
    'WEAK_EVIDENCE',
    'LIKELY_MISSING_ACT',
    'LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED',
    'LOW_CONFIDENCE_COMPANION_ACT_RECOVERED',
    'LOW_EVIDENCE',
    'ACT_SELECTION_LOW_CONFIDENCE',
    'CHUNKS_FAMILY_MISMATCH_DEMOTED',
    'SUPPORT_FAMILY_MISMATCH_BLOCKED',
    'UNGROUNDED_PRIMARY_FALLBACK',
    'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
  ]);
  if (!input.reasonCodes.some((reasonCode) => recoveryReasonCodes.has(reasonCode))) return false;

  const familyKeys = input.selectedActs.map((act) => toFamilyKey(act.category));
  const hasDomainAlignedFamily = familyKeys.some((familyKey) =>
    isDomainHintAlignedFamily(input.domainHint, familyKey)
  );
  if (isSpecificDomainHint(input.domainHint) && !hasDomainAlignedFamily) return false;
  if (!hasCompatibleSoftPrimaryBundleFamilies(input.domainHint, familyKeys)) return false;

  const evidenceItems = input.selectedActs.map((act) => input.evidenceByNreg.get(act.rada_nreg ?? ''));
  if (evidenceItems.some((evidence) => !hasRecoverableSoftBundleEvidence(evidence))) return false;
  if (!evidenceItems.some((evidence) => hasStrongLeadSoftBundleEvidence(evidence))) return false;

  const topScore = input.topScore ?? 0;
  const purelySubstantiveCompatibleBundle = familyKeys.every(
    (familyKey) => !isProceduralFamilyKey(familyKey)
  );
  return topScore >= (purelySubstantiveCompatibleBundle ? 0.45 : 0.5);
}

export function shouldForceSpecificDomainPrimarySelectionLowConfidence(input: {
  domainHint?: string;
  selectedActs: SoftBundleSelectedActLike[];
  hasDomainAlignedPrimaryFamily: boolean;
  leadSelectedMetadataGrounded: boolean;
  exactActHitCount: number;
  groundedActHitCount: number;
  topScore?: number | null;
}): boolean {
  if (!isSpecificDomainHint(input.domainHint)) return false;
  if (input.selectedActs.length === 0) return false;
  if (!input.selectedActs.some((act) => act.act_kind === 'PRIMARY_LAW')) return false;
  if (input.hasDomainAlignedPrimaryFamily) return false;
  if (input.leadSelectedMetadataGrounded) return false;
  if (input.exactActHitCount > 0 || input.groundedActHitCount > 0) return false;
  return (input.topScore ?? 0) < 0.72;
}

const METADATA_GROUNDING_REASON_CODES = new Set([
  'exact_alias_match',
  'exact_title_match',
  'alias_match',
  'title_match',
]);

type SoftNonPrimaryRecoveryCandidate = {
  candidate: ActCandidateInput;
  evidence?: BuildSelectedActsOutput['chunks_evidence_top_acts'][number];
  reasonCode: 'METADATA_ACT_SCOPE_RECOVERED' | 'EVIDENCE_ACT_SCOPE_RECOVERED';
};

function getSoftNonPrimaryRecoveryCandidate(input: {
  query: string;
  reasonCodes: string[];
  topScore?: number | null;
  selectedActsFinal: SelectedActTraceItem[];
  topActCandidate?: ActCandidateInput;
  chunksEvidenceTopActs: BuildSelectedActsOutput['chunks_evidence_top_acts'];
  metadataSingleActConverged: boolean;
  metadataLeadEvidence?: BuildSelectedActsOutput['chunks_evidence_top_acts'][number];
  evidenceSingleActConverged: boolean;
  evidenceSingleActNreg?: string | null;
  evidenceLeadEvidence?: BuildSelectedActsOutput['chunks_evidence_top_acts'][number];
  actCandidatesTopHydrated: ActCandidateInput[];
  documentTypeHints?: string[];
}): SoftNonPrimaryRecoveryCandidate | null {
  const blockingReasonCodes = new Set([
    'OUT_OF_SCOPE',
    'COVERAGE_MISS_SELECTED_ACTS',
    'COVERAGE_GUARD_FAILED',
    'FAMILY_GUARD_NO_EVIDENCE',
    'FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE',
    'MISSING_TAXONOMY_CONVERGENCE',
  ]);
  if (input.reasonCodes.some((reasonCode) => blockingReasonCodes.has(reasonCode))) return null;
  if (queryRequestsPrimaryLawLikeAct(input.query, input.documentTypeHints)) return null;

  const recoveryReasonCodes = new Set([
    'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
    'CALENDAR_SCOPED_ACT_NO_UNIQUE_CONVERGENCE',
    'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
    'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
    'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
    'ACT_SELECTION_LOW_CONFIDENCE',
    'LOW_EVIDENCE',
    'NO_STRONG_ACT_EVIDENCE',
    'NON_PRIMARY_SUPPORT_BLOCKED_PRIMARY_PRESENT',
    'NON_PRIMARY_EVIDENCE_BLOCKED_PRIMARY_PRESENT',
    'NON_PRIMARY_ONLY_WEAK_CONFIDENCE',
    'NO_PRIMARY_LAW_EVIDENCE',
  ]);
  if (!input.reasonCodes.some((reasonCode) => recoveryReasonCodes.has(reasonCode))) return null;

  const hasExplicitScopeCue = hasExplicitActScopeCue(input.query);
  const hasSoftDateScopedRecurringSurface = queryHasExplicitCalendarDate(input.query);
  const evidenceForCandidate = (radaNreg: string | null | undefined) =>
    input.chunksEvidenceTopActs.find((item) => sameRadaNreg(item.rada_nreg, radaNreg));

  const tryCandidate = (
    candidate: ActCandidateInput | undefined,
    evidence: BuildSelectedActsOutput['chunks_evidence_top_acts'][number] | undefined,
    reasonCode: SoftNonPrimaryRecoveryCandidate['reasonCode']
  ): SoftNonPrimaryRecoveryCandidate | null => {
    if (!candidate?.rada_nreg) return null;
    const kind = classifyActKind(
      candidate.title ?? '',
      candidate.document_type ?? null,
      candidate.category ?? null,
      candidate.document_type_slug ?? null
    );
    if (kind === 'PRIMARY_LAW' || kind === 'UNKNOWN') return null;
    if (input.selectedActsFinal.some((act) => sameRadaNreg(act.rada_nreg, candidate.rada_nreg))) return null;

    const strictExplicitScopedCandidate =
      hasExplicitScopeCue &&
      isTrustedExplicitGroundedActScopeCandidate(
        {
          rada_nreg: candidate.rada_nreg,
          title: candidate.title ?? null,
          document_type: candidate.document_type ?? null,
          document_type_slug: candidate.document_type_slug ?? null,
          reasons: candidate.reasons ?? [],
          score: candidate.score ?? 0,
        },
        input.query,
        METADATA_GROUNDING_REASON_CODES
      );
    const dateScopedRecurringSurface =
      !hasExplicitScopeCue &&
      hasSoftDateScopedRecurringSurface &&
      hasActTitleSupportOverlap(
        input.query,
        candidate.title ?? '',
        candidate.document_type ?? null
      );
    if (!strictExplicitScopedCandidate && !dateScopedRecurringSurface) return null;

    const bestRank = evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
    const countInTop30 = evidence?.count_in_top30 ?? 0;
    const rankMassTop30 = evidence?.rank_mass_top30 ?? 0;
    const maxOrderingScore = evidence?.max_ordering_score ?? 0;
    const topScore = input.topScore ?? 0;

    if (dateScopedRecurringSurface && !strictExplicitScopedCandidate) {
      if (bestRank > 4 || maxOrderingScore < 0.39 || topScore < 0.62) return null;
      if (countInTop30 < 1 && rankMassTop30 < 0.24) return null;
      return { candidate, evidence, reasonCode };
    }

    if (bestRank > 3 || maxOrderingScore < 0.36 || topScore < 0.48) return null;
    if (countInTop30 < 1 && rankMassTop30 < 0.35 && (candidate.score ?? 0) < 2.5) return null;
    return { candidate, evidence, reasonCode };
  };

  if (input.metadataSingleActConverged) {
    const recoveredFromMetadata = tryCandidate(
      input.topActCandidate,
      input.metadataLeadEvidence,
      'METADATA_ACT_SCOPE_RECOVERED'
    );
    if (recoveredFromMetadata) return recoveredFromMetadata;
  }

  if (input.evidenceSingleActConverged && input.evidenceSingleActNreg) {
    const evidenceCandidate = input.actCandidatesTopHydrated.find((candidate) =>
      sameRadaNreg(candidate.rada_nreg, input.evidenceSingleActNreg)
    );
    const recoveredFromEvidence = tryCandidate(
      evidenceCandidate,
      input.evidenceLeadEvidence,
      'EVIDENCE_ACT_SCOPE_RECOVERED'
    );
    if (recoveredFromEvidence) return recoveredFromEvidence;
  }

  if (hasExplicitScopeCue) {
    const trustedExplicitScopedCandidates = input.actCandidatesTopHydrated.filter((candidate) => {
      const kind = classifyActKind(
        candidate.title ?? '',
        candidate.document_type ?? null,
        candidate.category ?? null,
        candidate.document_type_slug ?? null
      );
      if (kind === 'PRIMARY_LAW' || kind === 'UNKNOWN') return false;
      return isTrustedExplicitGroundedActScopeCandidate(
        {
          rada_nreg: candidate.rada_nreg,
          title: candidate.title ?? null,
          document_type: candidate.document_type ?? null,
          document_type_slug: candidate.document_type_slug ?? null,
          reasons: candidate.reasons ?? [],
          score: candidate.score ?? 0,
        },
        input.query,
        METADATA_GROUNDING_REASON_CODES
      );
    });
    const leadTrustedExplicitScopedCandidate = trustedExplicitScopedCandidates[0];
    const runnerUpTrustedExplicitScopedCandidate = trustedExplicitScopedCandidates[1];
    if (
      leadTrustedExplicitScopedCandidate &&
      (
        !runnerUpTrustedExplicitScopedCandidate ||
        (leadTrustedExplicitScopedCandidate.score ?? 0) >=
          ((runnerUpTrustedExplicitScopedCandidate.score ?? 0) + 0.6)
      )
    ) {
      const recoveredExplicitScopedCandidate = tryCandidate(
        leadTrustedExplicitScopedCandidate,
        evidenceForCandidate(leadTrustedExplicitScopedCandidate.rada_nreg),
        'METADATA_ACT_SCOPE_RECOVERED'
      );
      if (recoveredExplicitScopedCandidate) return recoveredExplicitScopedCandidate;
    }
  }

  if (hasSoftDateScopedRecurringSurface) {
    const dateScopedRecurringCandidates = input.actCandidatesTopHydrated.filter((candidate) => {
      const kind = classifyActKind(
        candidate.title ?? '',
        candidate.document_type ?? null,
        candidate.category ?? null,
        candidate.document_type_slug ?? null
      );
      if (kind === 'PRIMARY_LAW' || kind === 'UNKNOWN') return false;
      if (!hasActTitleSupportOverlap(input.query, candidate.title ?? '', candidate.document_type ?? null)) {
        return false;
      }
      const reasons = new Set(candidate.reasons ?? []);
      return reasons.has('rada_datred_match') || reasons.has('rada_month_match');
    });
    const exactDateCandidates = dateScopedRecurringCandidates.filter((candidate) =>
      (candidate.reasons ?? []).includes('rada_datred_match')
    );
    const recurringRecoveryCandidate =
      exactDateCandidates.length === 1
        ? exactDateCandidates[0]
        : dateScopedRecurringCandidates.length === 1
          ? dateScopedRecurringCandidates[0]
          : undefined;
    if (recurringRecoveryCandidate) {
      const recoveredRecurringCandidate = tryCandidate(
        recurringRecoveryCandidate,
        evidenceForCandidate(recurringRecoveryCandidate.rada_nreg),
        'EVIDENCE_ACT_SCOPE_RECOVERED'
      );
      if (recoveredRecurringCandidate) return recoveredRecurringCandidate;
    }
  }

  return null;
}

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
    routing_hints_added_primary_law: routingHintsAddedPrimaryLaw,
    routing_hints_added_nregs: selected_acts_sources_breakdown_final.from_routing_hints,
    retrieval_evidence_nregs: finalHits.slice(0, 30).map((hit) => hit.rada_nreg ?? '').filter(Boolean),
  });
  selected_acts_final = selectedActsFinalMeta.selected_acts_final as SelectedActTraceItem[];
  const chunksEvidenceByNreg = buildNormalizedNregMap(chunksEvidenceTopActs);
  const singleActScopeSelection = await resolveSingleActScopeSelection({
    query,
    domainHint,
    documentTypeHints,
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
  const evidenceSingleActConverged = singleActScopeSelection.evidenceSingleActConverged;
  const evidenceSingleActNreg = singleActScopeSelection.evidenceSingleActNreg;
  const calendarScopedRecurringActAmbiguous = singleActScopeSelection.calendarScopedRecurringActAmbiguous;
  const topActCandidate = singleActScopeSelection.topActCandidate;
  const topActCandidateActKind = topActCandidate
    ? classifyActKind(
        topActCandidate.title ?? '',
        topActCandidate.document_type,
        topActCandidate.category,
        topActCandidate.document_type_slug
      )
    : 'UNKNOWN';
  const topActCandidateEvidence = topActCandidate?.rada_nreg
    ? getByNormalizedNreg(chunksEvidenceByNreg, topActCandidate.rada_nreg)
    : undefined;
  const topActCandidateIdentityReasons = new Set(topActCandidate?.reasons ?? []);
  const topActCandidateMetadataGrounded =
    !!topActCandidate?.rada_nreg &&
    isMetadataGroundedActCandidate(topActCandidate, query, METADATA_GROUNDING_REASON_CODES);
  const topActCandidateDistinctiveIdentityGrounded =
    topActCandidateMetadataGrounded &&
    (
      hasActTitleSupportOverlap(query, topActCandidate?.title ?? null, topActCandidate?.document_type ?? null) ||
      [
        'exact_identifier_match',
        'exact_alias_match',
        'exact_title_match',
        'alias_match',
        'title_match',
        'document_number_match',
        'rada_datred_match',
        'rada_month_match',
      ].some((reasonCode) => topActCandidateIdentityReasons.has(reasonCode))
    );
  const topActCandidateTitleIdentityDominant =
    !!topActCandidate?.rada_nreg &&
    hasActTitleSupportOverlap(query, topActCandidate?.title ?? null, topActCandidate?.document_type ?? null) &&
    [
      'exact_identifier_match',
      'exact_alias_match',
      'exact_title_match',
      'alias_match',
      'title_match',
      'document_number_match',
      'rada_datred_match',
      'rada_month_match',
    ].some((reasonCode) => topActCandidateIdentityReasons.has(reasonCode));
  const leadSelectedActBeforeAuthoritativeRealign = selected_acts_final[0];
  const leadSelectedCandidateBeforeAuthoritativeRealign = leadSelectedActBeforeAuthoritativeRealign
    ? actCandidatesTopHydrated.find((candidate) =>
        sameRadaNreg(candidate.rada_nreg, leadSelectedActBeforeAuthoritativeRealign.rada_nreg)
      )
    : undefined;
  const leadSelectedEvidenceBeforeAuthoritativeRealign = leadSelectedActBeforeAuthoritativeRealign
    ? getByNormalizedNreg(chunksEvidenceByNreg, leadSelectedActBeforeAuthoritativeRealign.rada_nreg)
    : undefined;
  const leadSelectedIdentityReasonsBeforeAuthoritativeRealign = new Set(
    leadSelectedCandidateBeforeAuthoritativeRealign?.reasons ?? []
  );
  const leadSelectedDistinctiveIdentityBeforeAuthoritativeRealign =
    !!leadSelectedCandidateBeforeAuthoritativeRealign?.rada_nreg &&
    isMetadataGroundedActCandidate(
      leadSelectedCandidateBeforeAuthoritativeRealign,
      query,
      METADATA_GROUNDING_REASON_CODES
    ) &&
    (
      hasActTitleSupportOverlap(
        query,
        leadSelectedCandidateBeforeAuthoritativeRealign?.title ??
          leadSelectedActBeforeAuthoritativeRealign?.act_title ??
          null,
        leadSelectedCandidateBeforeAuthoritativeRealign?.document_type ??
          leadSelectedActBeforeAuthoritativeRealign?.document_type ??
          null
      ) ||
      [
        'exact_identifier_match',
        'exact_alias_match',
        'exact_title_match',
        'alias_match',
        'title_match',
        'document_number_match',
        'rada_datred_match',
        'rada_month_match',
      ].some((reasonCode) => leadSelectedIdentityReasonsBeforeAuthoritativeRealign.has(reasonCode))
    );
  const topActCandidateStrongEvidenceBackedIdentityLead =
    !!topActCandidate?.rada_nreg &&
    nonPrimaryAuthoritativeKinds.has(topActCandidateActKind) &&
    topActCandidateTitleIdentityDominant &&
    (topActCandidate.score ?? 0) >=
      Math.max(3.5, (leadSelectedCandidateBeforeAuthoritativeRealign?.score ?? 0) + 2.5) &&
    (topActCandidateEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 3 &&
    (topActCandidateEvidence?.max_ordering_score ?? 0) + 0.015 >=
      (leadSelectedEvidenceBeforeAuthoritativeRealign?.max_ordering_score ?? 0) &&
    (
      queryHasExplicitCalendarDate(query) ||
      queryLooksAmendmentFocused(query) ||
      explicitActScopeCueQuery
    );
  const topActCandidateCompetitiveAgainstChunksLead =
    topActCandidateStrongEvidenceBackedIdentityLead ||
    (
      (topActCandidateEvidence?.rank_mass_top30 ?? 0) >=
        (leadSelectedEvidenceBeforeAuthoritativeRealign?.rank_mass_top30 ?? 0) - 0.08 ||
      (topActCandidateEvidence?.count_in_top30 ?? 0) >=
        (leadSelectedEvidenceBeforeAuthoritativeRealign?.count_in_top30 ?? 0) - 1
    );
  const shouldRealignSingleNonPrimaryLeadToTopMetadataCandidate =
    selected_acts_final.length === 1 &&
    !selected_acts_final.some((act) => act.act_kind === 'PRIMARY_LAW') &&
    !!topActCandidate?.rada_nreg &&
    nonPrimaryAuthoritativeKinds.has(topActCandidateActKind) &&
    !sameRadaNreg(topActCandidate.rada_nreg, leadSelectedActBeforeAuthoritativeRealign?.rada_nreg) &&
    (
      topActCandidateDistinctiveIdentityGrounded ||
      topActCandidateStrongEvidenceBackedIdentityLead
    ) &&
    (topActCandidateEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <=
      (leadSelectedEvidenceBeforeAuthoritativeRealign?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) &&
    topActCandidateCompetitiveAgainstChunksLead &&
    (
      topActCandidateStrongEvidenceBackedIdentityLead ||
      !leadSelectedDistinctiveIdentityBeforeAuthoritativeRealign ||
      (topActCandidateEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) + 1 <=
        (leadSelectedEvidenceBeforeAuthoritativeRealign?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY)
    );
  if (shouldRealignSingleNonPrimaryLeadToTopMetadataCandidate && topActCandidate) {
    selected_acts_final = [
      {
        rada_nreg: topActCandidate.rada_nreg,
        act_title: topActCandidate.title,
        score: topActCandidate.score,
        source_tags: uniqueStrings([
          'TAXONOMY',
          topActCandidateEvidence ? 'CHUNKS_EVIDENCE' : undefined,
        ]),
        document_type: topActCandidate.document_type ?? null,
        category: topActCandidate.category ?? null,
        act_kind: topActCandidateActKind,
      },
    ];
    selected_acts_sources_breakdown_final = {
      ...selected_acts_sources_breakdown_final,
      from_taxonomy: uniqueStrings([
        ...selected_acts_sources_breakdown_final.from_taxonomy,
        topActCandidate.rada_nreg,
      ]),
      from_chunks_evidence: topActCandidateEvidence
        ? uniqueStrings([
            ...selected_acts_sources_breakdown_final.from_chunks_evidence,
            topActCandidate.rada_nreg,
          ])
        : selected_acts_sources_breakdown_final.from_chunks_evidence,
    };
    selectedActsFinalMeta = updateSelectedActsFinalMeta(
      selectedActsFinalMeta,
      selected_acts_final as SelectedActOutput[],
      0.62,
      ['AUTHORITATIVE_NON_PRIMARY_REALIGNED_TO_METADATA_EVIDENCE']
    );
    pushUnique(reasonCodes, 'AUTHORITATIVE_NON_PRIMARY_REALIGNED_TO_METADATA_EVIDENCE');
  }
  const interrogativePrimaryLawLocatorQuery =
    isInterrogativePrimaryLawLocatorQuery(query) &&
    queryRequestsPrimaryLawLikeAct(query, documentTypeHints);
  if (
    routingHintsMeta.used_effect.added_act?.rada_nreg &&
    !new Set(selected_acts_final.map((act) => normalizeRadaNreg(act.rada_nreg)).filter(Boolean)).has(
      normalizeRadaNreg(routingHintsMeta.used_effect.added_act.rada_nreg)
    )
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
    ? getByNormalizedNreg(chunksEvidenceByNreg, selected_acts_final[0].rada_nreg)
    : undefined;
  const exactLeadEvidence =
    exactSingleActConverged && exactActNregSet.size === 1
      ? chunksEvidenceTopActs.find((item) => exactActNregSet.has(normalizeRadaNreg(item.rada_nreg)))
      : undefined;
  const groundedLeadEvidence =
    groundedSingleActConverged && groundedActNregSet.size === 1
      ? chunksEvidenceTopActs.find((item) => groundedActNregSet.has(normalizeRadaNreg(item.rada_nreg)))
      : undefined;
  const metadataLeadEvidence =
    metadataSingleActConverged && topActCandidate?.rada_nreg
      ? chunksEvidenceTopActs.find((item) => sameRadaNreg(item.rada_nreg, topActCandidate.rada_nreg))
      : undefined;
  const evidenceLeadEvidence =
    evidenceSingleActConverged && evidenceSingleActNreg
      ? chunksEvidenceTopActs.find((item) => sameRadaNreg(item.rada_nreg, evidenceSingleActNreg))
      : undefined;
  const preservedProceduralSupport = reasonCodes.includes('ACT_SCOPE_PRESERVED_PROCEDURAL_SUPPORT');
  const preservedHintedSupport = reasonCodes.includes('ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT');
  const isAllowedScopedSupportAct = (act: SelectedActTraceItem): boolean => {
    if (preservedProceduralSupport && act.act_kind === 'PRIMARY_LAW') {
      const familyKey = toFamilyKey(
        actCandidatesTopHydrated.find((candidate) => sameRadaNreg(candidate.rada_nreg, act.rada_nreg))?.category ?? act.category
      );
      if (familyKey.includes('procedure') || familyKey === 'judiciary_justice') return true;
    }
    if (!preservedHintedSupport) return false;
    const candidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === act.rada_nreg);
    return isExplicitlyHintedSupportActCandidate({
      query,
      act,
      candidate,
      documentTypeHints: documentTypeHints ?? [],
    });
  };
  const exactScopeSelectionValid =
    selected_acts_final.length > 0 &&
    selected_acts_final.every(
      (act) => exactActNregSet.has(normalizeRadaNreg(act.rada_nreg)) || isAllowedScopedSupportAct(act)
    );
  const groundedScopeSelectionValid =
    selected_acts_final.length > 0 &&
    selected_acts_final.every(
      (act) => groundedActNregSet.has(normalizeRadaNreg(act.rada_nreg)) || isAllowedScopedSupportAct(act)
    );
  const metadataScopeSelectionValid =
    selected_acts_final.length > 0 &&
    selected_acts_final.every(
      (act) => act.rada_nreg === topActCandidate?.rada_nreg || isAllowedScopedSupportAct(act)
    );
  const evidenceScopeSelectionValid =
    selected_acts_final.length > 0 &&
    selected_acts_final.every(
      (act) => act.rada_nreg === evidenceSingleActNreg || isAllowedScopedSupportAct(act)
    );
  const exactActScopeResolved =
    exactSingleActConverged &&
    exactScopeSelectionValid &&
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
    groundedScopeSelectionValid &&
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
    metadataScopeSelectionValid &&
    (
      (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.55 ||
      (
        (topScore ?? 0) >= 0.68 &&
        (metadataLeadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 15 &&
        (metadataLeadEvidence?.count_in_top30 ?? 0) >= 1
      )
    );
  const evidenceActScopeResolved =
    evidenceSingleActConverged &&
    !!evidenceSingleActNreg &&
    evidenceScopeSelectionValid &&
    (
      (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.5 ||
      (
        (topScore ?? 0) >= 0.5 &&
        (evidenceLeadEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 8 &&
        (evidenceLeadEvidence?.count_in_top30 ?? 0) >= 5 &&
        (evidenceLeadEvidence?.max_ordering_score ?? 0) >= 0.42
      )
    );
  const groundedActScopeNoConvergence =
    groundedSingleActConverged &&
    selected_acts_final.length > 0 &&
    !groundedScopeSelectionValid;
  const explicitPrimaryLawCueQuery = queryRequestsPrimaryLawLikeAct(query, documentTypeHints);
  const strictExplicitActScopeReference =
    extractStructuredActIdentifiers(query).length > 0 ||
    extractQuotedActTitleFragments(query).length > 0;
  const leadSelectedActForAuthoritativeScope = selected_acts_final[0];
  const leadSelectedCandidateForAuthoritativeScope = leadSelectedActForAuthoritativeScope
    ? actCandidatesTopHydrated.find((candidate) =>
        sameRadaNreg(candidate.rada_nreg, leadSelectedActForAuthoritativeScope.rada_nreg)
      )
    : undefined;
  const explicitPersonIdentityCueQuery = queryHasExplicitPersonIdentityCue(query);
  const leadSelectedMetadataGroundedForAuthoritativeScope = isMetadataGroundedActCandidate(
    leadSelectedCandidateForAuthoritativeScope,
    query,
    METADATA_GROUNDING_REASON_CODES
  );
  const personIdentityMatchingCandidatesForAuthoritativeScope = explicitPersonIdentityCueQuery
    ? actCandidatesTopHydrated.filter((candidate) =>
        candidateMatchesExplicitPersonIdentityQuery(candidate.title ?? null, query)
      )
    : [];
  const leadSelectedMatchesExplicitPersonIdentity =
    explicitPersonIdentityCueQuery &&
    candidateMatchesExplicitPersonIdentityQuery(
      leadSelectedCandidateForAuthoritativeScope?.title ?? leadSelectedActForAuthoritativeScope?.act_title ?? null,
      query
    );
  const uniqueLeadSelectedExplicitPersonIdentity =
    leadSelectedMatchesExplicitPersonIdentity &&
    personIdentityMatchingCandidatesForAuthoritativeScope.length === 1 &&
    sameRadaNreg(
      personIdentityMatchingCandidatesForAuthoritativeScope[0]?.rada_nreg,
      leadSelectedActForAuthoritativeScope?.rada_nreg
    );
  const leadSelectedAuthoritativeHintCompatible =
    !!leadSelectedCandidateForAuthoritativeScope?.rada_nreg &&
    documentTypeHintMatches(
      leadSelectedCandidateForAuthoritativeScope.document_type,
      documentTypeHints ?? [],
      leadSelectedCandidateForAuthoritativeScope.document_type_slug
    );
  const leadSelectedAuthoritativeIdentityReasons = new Set(leadSelectedCandidateForAuthoritativeScope?.reasons ?? []);
  const leadSelectedAuthoritativeTitleSupportOverlap = hasActTitleSupportOverlap(
    query,
    leadSelectedCandidateForAuthoritativeScope?.title ?? leadSelectedActForAuthoritativeScope?.act_title ?? null,
    leadSelectedCandidateForAuthoritativeScope?.document_type ??
      leadSelectedActForAuthoritativeScope?.document_type ??
      null
  );
  const leadSelectedDistinctiveMetadataIdentityGrounded =
    leadSelectedMetadataGroundedForAuthoritativeScope &&
    (
      leadSelectedAuthoritativeTitleSupportOverlap ||
      leadSelectedMatchesExplicitPersonIdentity ||
      [
        'exact_alias_match',
        'exact_title_match',
        'alias_match',
        'title_match',
        'keyword_match',
        'topic_match',
      ].some((reasonCode) => leadSelectedAuthoritativeIdentityReasons.has(reasonCode))
    );
  const leadSelectedDistinctPersonIdentityGrounded =
    leadSelectedMatchesExplicitPersonIdentity &&
    (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
    (leadSelectedEvidence?.count_in_top30 ?? 0) >= 1 &&
    (leadSelectedEvidence?.max_ordering_score ?? 0) >= 0.32 &&
    (topScore ?? 0) >= 0.52;
  const leadSelectedBoundedPersonIdentityScopeGrounded =
    uniqueLeadSelectedExplicitPersonIdentity &&
    leadSelectedAuthoritativeTitleSupportOverlap &&
    (
      (documentTypeHints?.length ?? 0) === 0 ||
      leadSelectedAuthoritativeHintCompatible
    ) &&
    (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 8 &&
    (leadSelectedEvidence?.count_in_top30 ?? 0) >= 1 &&
    (leadSelectedEvidence?.max_ordering_score ?? 0) >= 0.3 &&
    (topScore ?? 0) >= 0.62;
  const leadSelectedStrongDocumentIdentityGrounded =
    leadSelectedDistinctiveMetadataIdentityGrounded ||
    leadSelectedDistinctPersonIdentityGrounded ||
    leadSelectedBoundedPersonIdentityScopeGrounded ||
    [
      'exact_identifier_match',
      'exact_alias_match',
      'exact_title_match',
      'document_number_match',
      'rada_datred_match',
      'rada_month_match',
    ].some((reasonCode) => leadSelectedAuthoritativeIdentityReasons.has(reasonCode));
  const leadSelectedAuthoritativeScopeTrimmed =
    reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_SCOPE_TRIMMED');
  const leadSelectedAuthoritativeMetadataRealigned =
    reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_REALIGNED_TO_METADATA_EVIDENCE');
  const softAuthoritativeNonPrimaryScopeResolved =
    !explicitPrimaryLawCueQuery &&
    !hasPrimarySelectedAct &&
    selected_acts_final.length === 1 &&
    nonPrimaryAuthoritativeKinds.has(selected_acts_final[0]?.act_kind ?? '') &&
    (
      (documentTypeHints?.length ?? 0) === 0 ||
      leadSelectedAuthoritativeHintCompatible
    ) &&
    leadSelectedStrongDocumentIdentityGrounded &&
    (
      (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.66 ||
      (
        (topScore ?? 0) >= 0.62 &&
        (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 1 &&
        (leadSelectedEvidence?.count_in_top30 ?? 0) >= 1 &&
        (leadSelectedEvidence?.max_ordering_score ?? 0) >= 0.39
      ) ||
      (
        (topScore ?? 0) >= 0.42 &&
        (leadSelectedEvidence?.count_in_top30 ?? 0) >= 3 &&
        (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 3 &&
        (leadSelectedEvidence?.max_ordering_score ?? 0) >= 0.45
      ) ||
      (
        leadSelectedDistinctPersonIdentityGrounded &&
        (topScore ?? 0) >= 0.5 &&
        (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
        (leadSelectedEvidence?.count_in_top30 ?? 0) >= 1
      ) ||
      (
        leadSelectedBoundedPersonIdentityScopeGrounded &&
        (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.4
      )
    );
  const authoritativeNonPrimaryScopeResolved =
    (
      explicitActScopeCueQuery &&
      !explicitPrimaryLawCueQuery &&
      !hasPrimarySelectedAct &&
      selected_acts_final.length === 1 &&
      nonPrimaryAuthoritativeKinds.has(selected_acts_final[0]?.act_kind ?? '') &&
      (
        (documentTypeHints?.length ?? 0) === 0 ||
        leadSelectedAuthoritativeHintCompatible
      ) &&
      (leadSelectedStrongDocumentIdentityGrounded || leadSelectedAuthoritativeScopeTrimmed) &&
      (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.75 &&
      (leadSelectedEvidence?.count_in_top30 ?? 0) >= 5 &&
      (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
      (topScore ?? 0) >= 0.5
    ) ||
    (
      explicitActScopeCueQuery &&
      !explicitPrimaryLawCueQuery &&
      !hasPrimarySelectedAct &&
      selected_acts_final.length === 1 &&
      nonPrimaryAuthoritativeKinds.has(selected_acts_final[0]?.act_kind ?? '') &&
      leadSelectedAuthoritativeMetadataRealigned &&
      leadSelectedAuthoritativeTitleSupportOverlap &&
      (
        (documentTypeHints?.length ?? 0) === 0 ||
        leadSelectedAuthoritativeHintCompatible
      ) &&
      (leadSelectedEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
      (leadSelectedEvidence?.count_in_top30 ?? 0) >= 1 &&
      (leadSelectedEvidence?.max_ordering_score ?? 0) >= 0.39 &&
      (topScore ?? 0) >= 0.5
    ) ||
    softAuthoritativeNonPrimaryScopeResolved;
  if (
    familyEvidence.reason_codes.includes('NO_PRIMARY_LAW_EVIDENCE') &&
    !hasPrimarySelectedAct &&
    selected_acts_final.length > 0 &&
    !exactActScopeResolved &&
    !groundedActScopeResolved &&
    !metadataActScopeResolved &&
    !evidenceActScopeResolved &&
    !authoritativeNonPrimaryScopeResolved
  ) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (
    exactActScopeResolved ||
    groundedActScopeResolved ||
    metadataActScopeResolved ||
    evidenceActScopeResolved ||
    authoritativeNonPrimaryScopeResolved
  ) {
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
          'EVIDENCE_ACT_SCOPE_NO_CONVERGENCE',
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
              : evidenceActScopeResolved
                ? 'EVIDENCE_ACT_SCOPE_CONFIRMED'
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
  if (evidenceSingleActConverged && selected_acts_final.length === 0) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'EVIDENCE_ACT_SCOPE_NO_CONVERGENCE');
    pushUnique(reasonCodes, 'NO_STRONG_ACT_EVIDENCE');
  }

  const leadSelectedAct = selected_acts_final[0];
  const leadSelectedCandidate = leadSelectedAct
    ? actCandidatesTopHydrated.find((candidate) => sameRadaNreg(candidate.rada_nreg, leadSelectedAct.rada_nreg))
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
      actCandidatesTopHydrated.find((candidate) => sameRadaNreg(candidate.rada_nreg, act.rada_nreg))?.category ?? act.category
    )
  );
  const distinctPrimaryFamilies = [...new Set(selectedPrimaryFamilies.filter(Boolean))];
  const secondaryFamilySupportScore = familyEvidence.top2?.[1]?.support_score ?? 0;
  const metadataGroundedPrimaryActsCount = selectedPrimaryActs.filter((act) => {
    const candidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === act.rada_nreg);
    return isMetadataGroundedActCandidate(candidate, query, METADATA_GROUNDING_REASON_CODES);
  }).length;
  const leadSelectedFamilyKey = toFamilyKey(leadSelectedCandidate?.category ?? leadSelectedAct?.category);
  const hasDomainAlignedPrimaryFamily = selectedPrimaryFamilies.some((familyKey) =>
    isDomainHintAlignedFamily(domainHint, familyKey)
  );
  const leadSelectedFamilyAlignedToDomain = isDomainHintAlignedFamily(domainHint, leadSelectedFamilyKey);
  const mismatchBlockSignalsPresent =
    reasonCodes.includes('CHUNKS_FAMILY_MISMATCH_DEMOTED') ||
    reasonCodes.includes('SUPPORT_FAMILY_MISMATCH_BLOCKED') ||
    reasonCodes.includes('ORDER_UNRELATED_BLOCKED');
  const selectedActsFromChunksOnly =
    selected_acts_final.length > 0 &&
    selected_acts_final.every((act) =>
      selected_acts_sources_breakdown_final.from_chunks_evidence.some((radaNreg) => sameRadaNreg(radaNreg, act.rada_nreg))
    ) &&
    selected_acts_sources_breakdown_final.from_taxonomy.length === 0 &&
    selected_acts_sources_breakdown_final.from_acts_search.length === 0;
  const proceduralOnlyPrimarySelection =
    selectedPrimaryActs.length > 0 &&
    selected_acts_final.length === selectedPrimaryActs.length &&
    selectedPrimaryActs.every((act) => {
      const candidate = actCandidatesTopHydrated.find((item) => sameRadaNreg(item.rada_nreg, act.rada_nreg));
      const familyKey = toFamilyKey(candidate?.category ?? act.category);
      return familyKey.includes('procedure') || familyKey === 'judiciary_justice';
    });
  const fragmentedPrimaryFamilySelection =
    distinctPrimaryFamilies.length >= 3 && (topScore ?? 0) < 0.6;
  const primaryActsRecoveredOnlyFromMetadata = selectedPrimaryActs.filter((act) => {
    if (selected_acts_sources_breakdown_final.from_chunks_evidence.some((radaNreg) => sameRadaNreg(radaNreg, act.rada_nreg))) return false;
    const candidate = actCandidatesTopHydrated.find((item) => sameRadaNreg(item.rada_nreg, act.rada_nreg));
    return isMetadataGroundedActCandidate(candidate, query, METADATA_GROUNDING_REASON_CODES);
  }).length;
  const multiFamilyUngroundedSelection =
    !isSpecificDomainHint(domainHint) &&
    selectedPrimaryActs.length >= 2 &&
    distinctPrimaryFamilies.length >= 2 &&
    exactActHitCount === 0 &&
    groundedActHitCount === 0 &&
    metadataGroundedPrimaryActsCount === 0 &&
    (topScore ?? 0) < 0.6 &&
    (
      familyEvidence.family_conflict ||
      reasonCodes.includes('CHUNKS_FAMILY_MISMATCH_DEMOTED') ||
      reasonCodes.includes('SUPPORT_FAMILY_MISMATCH_BLOCKED')
    );
  const domainHintPrimaryFamilyMismatch =
    isSpecificDomainHint(domainHint) &&
    distinctPrimaryFamilies.length >= 2 &&
    hasDomainAlignedPrimaryFamily &&
    !leadSelectedFamilyAlignedToDomain &&
    (topScore ?? 0) < 0.6;
  const domainHintNoAlignedPrimaryFamily =
    isSpecificDomainHint(domainHint) &&
    selectedPrimaryActs.length >= 1 &&
    !hasDomainAlignedPrimaryFamily &&
    exactActHitCount === 0 &&
    groundedActHitCount === 0 &&
    metadataGroundedPrimaryActsCount === 0 &&
    (topScore ?? 0) < 0.62 &&
    (
      familyEvidence.family_conflict ||
      distinctPrimaryFamilies.length >= 2 ||
      reasonCodes.includes('CHUNKS_FAMILY_MISMATCH_DEMOTED')
    );
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
  const explicitActTitleReference =
    (
      !interrogativePrimaryLawLocatorQuery &&
      extractStrictActScopeReferenceSignals(query).length > 0
    ) ||
    extractQuotedActTitleFragments(query).length > 0;
  const titleRichActScopeReference =
    (documentTypeHints?.length ?? 0) > 0 ||
    entitiesCount > 0 ||
    anchorsCount > 0;
  const weakTaxonomyOrFamilyConvergence =
    taxonomyActCount === 0 ||
    (
      selectedPrimaryActs.length >= 2 &&
      distinctPrimaryFamilies.length <= 1 &&
      !leadSelectedMetadataGrounded &&
      (secondaryFamilySupportScore >= 0.4 || mismatchBlockSignalsPresent)
    );
  const ungroundedGeneralPrimaryFallback =
    !isSpecificDomainHint(domainHint) &&
    selectedPrimaryActs.length >= 1 &&
    exactActHitCount === 0 &&
    groundedActHitCount === 0 &&
    metadataGroundedPrimaryActsCount === 0 &&
    weakTaxonomyOrFamilyConvergence &&
    selectedActsFromChunksOnly &&
    mismatchBlockSignalsPresent &&
    (topScore ?? 0) < 0.6;
  const ungroundedPrimaryCompanionFallback =
    !isSpecificDomainHint(domainHint) &&
    selectedPrimaryActs.length >= 2 &&
    exactActHitCount === 0 &&
    groundedActHitCount === 0 &&
    metadataGroundedPrimaryActsCount >= 1 &&
    primaryActsRecoveredOnlyFromMetadata >= 1 &&
    selected_acts_sources_breakdown_final.from_chunks_evidence.length >= 1 &&
    selected_acts_sources_breakdown_final.from_chunks_evidence.length < selectedPrimaryActs.length &&
    mismatchBlockSignalsPresent &&
    (topScore ?? 0) < 0.6;
  const explicitActScopeNoConvergence =
    (
      (
        hasExplicitActScopeCue(query) &&
        !interrogativePrimaryLawLocatorQuery
      ) ||
      extractStructuredActIdentifiers(query).length >= 1 ||
      explicitActTitleReference
    ) &&
    diffuseTaxonomyConvergence &&
    !exactSingleActConverged &&
    !groundedSingleActConverged &&
    !metadataSingleActConverged &&
    !evidenceSingleActConverged &&
    !authoritativeNonPrimaryScopeResolved &&
    selected_acts_final.length >= 1 &&
    (
      titleRichActScopeReference ||
      selectedPrimaryActs.length >= 1
    ) &&
    (
      titleRichActScopeReference ||
      (topScore ?? 0) < 0.68
    );
  const proceduralPrimaryWithoutActGrounding = shouldFlagProceduralPrimaryWithoutActGrounding({
    proceduralOnlyPrimarySelection,
    explicitActScopeCue: hasExplicitActScopeCue(query),
    interrogativePrimaryLawLocatorQuery,
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
  if (domainHintNoAlignedPrimaryFamily) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'DOMAIN_HINT_NO_ALIGNED_PRIMARY_FAMILY');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (multiFamilyUngroundedSelection) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'UNGROUNDED_MULTI_FAMILY_SELECTION');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (ungroundedGeneralPrimaryFallback) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'UNGROUNDED_GENERAL_PRIMARY_FALLBACK');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
  }
  if (ungroundedPrimaryCompanionFallback) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'UNGROUNDED_PRIMARY_COMPANION_FALLBACK');
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
  if (calendarScopedRecurringActAmbiguous) {
    low_confidence_final = true;
    pushUnique(reasonCodes, 'CALENDAR_SCOPED_ACT_NO_UNIQUE_CONVERGENCE');
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

  const lowConfidenceSelectionNormalization = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: low_confidence_final,
    selectedActsFinal: selected_acts_final,
    selectedActsFinalMeta: selectedActsFinalMeta,
    selectedActsSourcesBreakdown: selected_acts_sources_breakdown_final,
    reasonCodes,
    domainHint,
    actCandidatesTopHydrated,
    chunksEvidenceTopActs,
    preserveScopedSelection:
      exactActScopeResolved ||
      groundedActScopeResolved ||
      metadataActScopeResolved ||
      evidenceActScopeResolved ||
      authoritativeNonPrimaryScopeResolved,
    preferPrimaryLawRetention: interrogativePrimaryLawLocatorQuery,
    explicitActScopeCueQuery,
  });
  selected_acts_final = lowConfidenceSelectionNormalization.selectedActsFinal as SelectedActTraceItem[];
  selectedActsFinalMeta = lowConfidenceSelectionNormalization.selectedActsFinalMeta;
  if (lowConfidenceSelectionNormalization.selectedActsSourcesBreakdown) {
    selected_acts_sources_breakdown_final =
      lowConfidenceSelectionNormalization.selectedActsSourcesBreakdown as SelectedActsSourcesBreakdown;
  }
  reasonCodes.splice(0, reasonCodes.length, ...lowConfidenceSelectionNormalization.reasonCodes);

  const softNonPrimaryRecoveryCandidate = getSoftNonPrimaryRecoveryCandidate({
    query,
    reasonCodes,
    topScore,
    selectedActsFinal: selected_acts_final,
    topActCandidate,
    chunksEvidenceTopActs,
    metadataSingleActConverged,
    metadataLeadEvidence,
    evidenceSingleActConverged,
    evidenceSingleActNreg,
    evidenceLeadEvidence,
    actCandidatesTopHydrated,
    documentTypeHints,
  });
  if (softNonPrimaryRecoveryCandidate) {
    const recoveredCandidate = softNonPrimaryRecoveryCandidate.candidate;
    const recoveredEvidence = softNonPrimaryRecoveryCandidate.evidence;
    const recoveredActKind = classifyActKind(
      recoveredCandidate.title ?? '',
      recoveredCandidate.document_type ?? null,
      recoveredCandidate.category ?? null,
      recoveredCandidate.document_type_slug ?? null
    );
    const recoveredSelectedActsRaw = [
      {
        rada_nreg: recoveredCandidate.rada_nreg,
        act_title: recoveredCandidate.title,
        score: recoveredEvidence?.max_ordering_score ?? recoveredCandidate.score,
        why_selected:
          recoveredEvidence
            ? `soft_non_primary_recovery best_rank=${recoveredEvidence.best_rank_in_top30 ?? '-'} max_score=${(recoveredEvidence.max_ordering_score ?? 0).toFixed(2)}`
            : 'soft_non_primary_recovery',
        reason_tag: 'SOFT_NON_PRIMARY_RECOVERY',
        source_tags: uniqueStrings([
          'SOFT_NON_PRIMARY_RECOVERY',
          taxonomyNregs.has(recoveredCandidate.rada_nreg) ? 'TAXONOMY' : undefined,
          actsSearchNregs.includes(recoveredCandidate.rada_nreg) ? 'ACTS_SEARCH' : undefined,
          recoveredEvidence ? 'CHUNKS_EVIDENCE' : undefined,
        ]),
        document_type: recoveredCandidate.document_type ?? null,
        category: recoveredCandidate.category ?? null,
        act_kind: recoveredActKind,
      },
    ] satisfies SelectedActOutput[];
    selected_acts_final = await hydrateSelectedActsMeta(
      recoveredSelectedActsRaw,
      Math.max(selectedActsFinalMeta.selected_acts_confidence_final ?? 0, 0.56)
    );
    selected_acts_sources_breakdown_final = {
      ...selected_acts_sources_breakdown_final,
      from_taxonomy: uniqueStrings([
        ...selected_acts_sources_breakdown_final.from_taxonomy,
        taxonomyNregs.has(recoveredCandidate.rada_nreg) ? recoveredCandidate.rada_nreg : undefined,
      ]),
      from_acts_search: uniqueStrings([
        ...selected_acts_sources_breakdown_final.from_acts_search,
        actsSearchNregs.includes(recoveredCandidate.rada_nreg) ? recoveredCandidate.rada_nreg : undefined,
      ]),
      from_chunks_evidence: uniqueStrings([
        ...selected_acts_sources_breakdown_final.from_chunks_evidence,
        recoveredEvidence ? recoveredCandidate.rada_nreg : undefined,
      ]),
    };
    pushUnique(reasonCodes, softNonPrimaryRecoveryCandidate.reasonCode);
    pushUnique(reasonCodes, 'SOFT_NON_PRIMARY_SINGLE_ACT_RECOVERED');
    selectedActsFinalMeta = updateSelectedActsFinalMeta(
      selectedActsFinalMeta,
      selected_acts_final,
      0.56,
      [softNonPrimaryRecoveryCandidate.reasonCode, 'SOFT_NON_PRIMARY_SINGLE_ACT_RECOVERED']
    );
  }

  const leadSelectedActAfterNormalization = selected_acts_final[0];
  const leadSelectedEvidenceAfterNormalization = leadSelectedActAfterNormalization
    ? getByNormalizedNreg(chunksEvidenceByNreg, leadSelectedActAfterNormalization.rada_nreg)
    : undefined;
  const leadSelectedCandidateAfterNormalization = leadSelectedActAfterNormalization
    ? actCandidatesTopHydrated.find((candidate) =>
        sameRadaNreg(candidate.rada_nreg, leadSelectedActAfterNormalization.rada_nreg)
      )
    : undefined;
  const softPrimaryLawLocatorRecovered =
    interrogativePrimaryLawLocatorQuery &&
    selected_acts_final.length === 1 &&
    leadSelectedActAfterNormalization?.act_kind === 'PRIMARY_LAW' &&
    familyEvidence.reason_codes.includes('FAMILY_DOMINANT_OK') &&
    !reasonCodes.includes('OUT_OF_SCOPE') &&
    !reasonCodes.includes('COVERAGE_GUARD_FAILED') &&
    !reasonCodes.includes('COVERAGE_MISS_SELECTED_ACTS') &&
    !reasonCodes.includes('FAMILY_GUARD_NO_EVIDENCE') &&
    !reasonCodes.includes('FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE') &&
    (
      (
        (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.55 &&
        (leadSelectedEvidenceAfterNormalization?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 6 &&
        (leadSelectedEvidenceAfterNormalization?.count_in_top30 ?? 0) >= 3
      ) ||
      (
        (topScore ?? 0) >= 0.54 &&
        (leadSelectedEvidenceAfterNormalization?.rank_mass_top30 ?? 0) >= 0.5 &&
        (leadSelectedEvidenceAfterNormalization?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 3 &&
        (leadSelectedEvidenceAfterNormalization?.max_ordering_score ?? 0) >= 0.44
      )
    );
  if (softPrimaryLawLocatorRecovered) {
    low_confidence_final = false;
    reasonCodes.splice(
      0,
      reasonCodes.length,
      ...removeReasonCodes(reasonCodes, [
        'ACT_SELECTION_LOW_CONFIDENCE',
        'LOW_EVIDENCE',
        'NO_STRONG_ACT_EVIDENCE',
        'FRAGMENTED_PRIMARY_FAMILY_SELECTION',
        'UNGROUNDED_MULTI_FAMILY_SELECTION',
        'NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY',
        'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
      ])
    );
    pushUnique(reasonCodes, 'INTERROGATIVE_PRIMARY_LAW_LOCATOR_CONFIRMED');
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_confidence_final: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.58),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: removeReasonCodes(
          selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? [],
          [
            'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
          ]
        ),
      },
    };
  }

  const softProceduralSingleActConfirmed = shouldConfirmSoftProceduralSingleAct({
    query,
    domainHint,
    reasonCodes,
    topScore,
    selectedActsCount: selected_acts_final.length,
    leadAct: leadSelectedActAfterNormalization,
    leadEvidence: leadSelectedEvidenceAfterNormalization,
    familyDominantOk: familyEvidence.reason_codes.includes('FAMILY_DOMINANT_OK'),
    proceduralOnlyPrimarySelection,
    interrogativePrimaryLawLocatorQuery,
  });
  if (softProceduralSingleActConfirmed) {
    low_confidence_final = false;
    reasonCodes.splice(
      0,
      reasonCodes.length,
      ...removeReasonCodes(reasonCodes, [
        'ACT_SELECTION_LOW_CONFIDENCE',
        'LOW_EVIDENCE',
        'FRAGMENTED_PRIMARY_FAMILY_SELECTION',
        'DOMAIN_HINT_PRIMARY_FAMILY_MISMATCH',
        'DOMAIN_HINT_NO_ALIGNED_PRIMARY_FAMILY',
        'UNGROUNDED_MULTI_FAMILY_SELECTION',
        'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
      ])
    );
    pushUnique(reasonCodes, 'SOFT_PROCEDURAL_SINGLE_ACT_CONFIRMED');
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_confidence_final: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.58),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: [
          ...removeReasonCodes(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? [], [
            'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
          ]),
          'SOFT_PROCEDURAL_SINGLE_ACT_CONFIRMED',
        ],
      },
    };
  }

  const softPrimarySingleActConfirmed = shouldConfirmSoftPrimarySingleAct({
    query,
    domainHint,
    reasonCodes,
    topScore,
    selectedActsCount: selected_acts_final.length,
    leadAct: leadSelectedActAfterNormalization,
    leadEvidence: leadSelectedEvidenceAfterNormalization,
    familyDominantOk: familyEvidence.reason_codes.includes('FAMILY_DOMINANT_OK'),
  });
  if (softPrimarySingleActConfirmed) {
    low_confidence_final = false;
    reasonCodes.splice(
      0,
      reasonCodes.length,
      ...removeReasonCodes(reasonCodes, [
        'ACT_SELECTION_LOW_CONFIDENCE',
        'LOW_EVIDENCE',
        'FRAGMENTED_PRIMARY_FAMILY_SELECTION',
        'UNGROUNDED_PRIMARY_FALLBACK',
        'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
      ])
    );
    pushUnique(reasonCodes, 'SOFT_PRIMARY_SINGLE_ACT_CONFIRMED');
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_confidence_final: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.58),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: [
          ...removeReasonCodes(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? [], [
            'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
          ]),
          'SOFT_PRIMARY_SINGLE_ACT_CONFIRMED',
        ],
      },
    };
  }

  const softPrimaryTwoActBundleConfirmed = shouldConfirmSoftPrimaryLawTwoActBundle({
    query,
    domainHint,
    reasonCodes,
    topScore,
    selectedActs: selected_acts_final,
    evidenceByNreg: chunksEvidenceByNreg,
    familyDominantOk: familyEvidence.reason_codes.includes('FAMILY_DOMINANT_OK'),
  });
  if (softPrimaryTwoActBundleConfirmed) {
    low_confidence_final = false;
    reasonCodes.splice(
      0,
      reasonCodes.length,
      ...removeReasonCodes(reasonCodes, [
        'WEAK_EVIDENCE',
        'LIKELY_MISSING_ACT',
        'ACT_SELECTION_LOW_CONFIDENCE',
        'LOW_EVIDENCE',
        'UNGROUNDED_PRIMARY_FALLBACK',
        'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
        'LOW_CONFIDENCE_COMPANION_ACT_RECOVERED',
        'CHUNKS_FAMILY_MISMATCH_DEMOTED',
        'SUPPORT_FAMILY_MISMATCH_BLOCKED',
      ])
    );
    pushUnique(reasonCodes, 'SOFT_PRIMARY_TWO_ACT_BUNDLE_CONFIRMED');
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_confidence_final: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.6),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: [
          ...removeReasonCodes(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? [], [
            'WEAK_EVIDENCE',
            'LIKELY_MISSING_ACT',
            'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
            'LOW_CONFIDENCE_COMPANION_ACT_RECOVERED',
          ]),
          'SOFT_PRIMARY_TWO_ACT_BUNDLE_CONFIRMED',
        ],
      },
    };
  }

  const softNonPrimarySingleActConfirmed = shouldConfirmSoftNonPrimarySingleAct({
    query,
    reasonCodes,
    topScore,
    selectedActsCount: selected_acts_final.length,
    leadAct: leadSelectedActAfterNormalization,
    leadCandidate: leadSelectedCandidateAfterNormalization,
    leadEvidence: leadSelectedEvidenceAfterNormalization,
  });
  if (softNonPrimarySingleActConfirmed) {
    low_confidence_final = false;
    reasonCodes.splice(
      0,
      reasonCodes.length,
      ...removeReasonCodes(reasonCodes, [
        'ACT_SELECTION_LOW_CONFIDENCE',
        'LOW_EVIDENCE',
        'NO_STRONG_ACT_EVIDENCE',
        'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
        'CALENDAR_SCOPED_ACT_NO_UNIQUE_CONVERGENCE',
        'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
        'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
      ])
    );
    pushUnique(reasonCodes, 'SOFT_NON_PRIMARY_SINGLE_ACT_CONFIRMED');
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_confidence_final: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.58),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: [
          ...removeReasonCodes(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? [], [
            'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
            'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
          ]),
          'SOFT_NON_PRIMARY_SINGLE_ACT_CONFIRMED',
        ],
      },
    };
  }

  if (
    shouldForceSpecificDomainPrimarySelectionLowConfidence({
      domainHint,
      selectedActs: selected_acts_final,
      hasDomainAlignedPrimaryFamily,
      leadSelectedMetadataGrounded,
      exactActHitCount,
      groundedActHitCount,
      topScore,
    })
  ) {
    low_confidence_final = true;
    reasonCodes.splice(
      0,
      reasonCodes.length,
      ...removeReasonCodes(reasonCodes, [
        'SOFT_PROCEDURAL_SINGLE_ACT_CONFIRMED',
        'SOFT_PRIMARY_SINGLE_ACT_CONFIRMED',
        'SOFT_PRIMARY_TWO_ACT_BUNDLE_CONFIRMED',
        'SOFT_NON_PRIMARY_SINGLE_ACT_CONFIRMED',
        'INTERROGATIVE_PRIMARY_LAW_LOCATOR_CONFIRMED',
      ])
    );
    pushUnique(reasonCodes, 'DOMAIN_HINT_NO_ALIGNED_PRIMARY_FAMILY');
    pushUnique(reasonCodes, 'LOW_EVIDENCE');
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_confidence_final: Math.min(selectedActsFinalMeta.selected_acts_confidence_final, 0.54),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: [
          ...removeReasonCodes(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? [], [
            'SOFT_PROCEDURAL_SINGLE_ACT_CONFIRMED',
            'SOFT_PRIMARY_SINGLE_ACT_CONFIRMED',
            'SOFT_PRIMARY_TWO_ACT_BUNDLE_CONFIRMED',
            'SOFT_NON_PRIMARY_SINGLE_ACT_CONFIRMED',
            'INTERROGATIVE_PRIMARY_LAW_LOCATOR_CONFIRMED',
          ]),
          'DOMAIN_HINT_NO_ALIGNED_PRIMARY_FAMILY',
        ],
      },
    };
  }

  const finalReasonCodes = normalizeFinalReasonCodes([
    ...reasonCodes,
    ...(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? []),
  ], low_confidence_final);
  const finalMetadataGroundedActCount = selected_acts_final.filter((act) => {
    const candidate = actCandidatesTopHydrated.find((item) => sameRadaNreg(item.rada_nreg, act.rada_nreg));
    return isMetadataGroundedActCandidate(candidate, query, METADATA_GROUNDING_REASON_CODES);
  }).length;

  const coverageGap = deriveCoverageGap({
    lowConfidence: low_confidence_final,
    reasonCodes: finalReasonCodes,
    selectedActsCount: selected_acts_final.length,
    selectedActsConfidence: selectedActsFinalMeta.selected_acts_confidence_final,
    selectedActKinds: selected_acts_final.map((act) => act.act_kind ?? 'UNKNOWN'),
    exactActHitCount,
    groundedActHitCount,
    metadataGroundedActCount: finalMetadataGroundedActCount,
    hitsCount: finalHits.length,
    topScore,
    domainHint,
    categoryHintCount: categoryHintsCount,
    documentTypeHintCount: documentTypeHints?.length ?? 0,
    entitiesCount,
    anchorsCount,
    explicitActScopeCue: explicitActScopeCueQuery,
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
