import {
  syncSelectedActsSourcesBreakdown,
  updateSelectedActsFinalMeta,
  type FinalizeSelectedActsAfterRoutingOutput,
  type SelectedActsSourcesBreakdownLike,
} from './selected-acts-finalizer.js';
import type { SelectedActOutput } from '../selected-acts.js';
import { classifyActKind } from '../selected-acts.js';
import {
  areCompatiblePrimaryFamilies,
  isDomainHintAlignedFamily,
  toFamilyKey,
} from '../family-alignment.js';
import { compareTrimEvidence, uniqueStrings } from '../helpers/retrieval-utils.js';

type SelectedActLike = SelectedActOutput & {
  category?: string | null;
  score?: number;
};

type ActCandidateLike = {
  rada_nreg: string;
  category?: string | null;
  score?: number;
  reasons?: string[];
  title?: string | null;
  document_type?: string | null;
};

type ChunksEvidenceLike = {
  rada_nreg: string;
  rank_mass_top30?: number;
  best_rank_in_top30?: number;
  max_ordering_score?: number;
};

export interface NormalizeSingleGoalLowConfidenceSelectionInput {
  lowConfidence: boolean;
  selectedActsFinal: SelectedActLike[];
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  selectedActsSourcesBreakdown?: SelectedActsSourcesBreakdownLike;
  reasonCodes: string[];
  domainHint?: string;
  actCandidatesTopHydrated: ActCandidateLike[];
  chunksEvidenceTopActs: ChunksEvidenceLike[];
  preserveScopedSelection?: boolean;
  preferPrimaryLawRetention?: boolean;
  explicitActScopeCueQuery?: boolean;
}

export interface NormalizeSingleGoalLowConfidenceSelectionOutput {
  selectedActsFinal: SelectedActLike[];
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  selectedActsSourcesBreakdown?: SelectedActsSourcesBreakdownLike;
  reasonCodes: string[];
}

function buildEvidenceMap(chunksEvidenceTopActs: ChunksEvidenceLike[]): Map<string, ChunksEvidenceLike> {
  return new Map(chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const));
}

function resolveActFamilyKey(
  act: SelectedActLike,
  actCandidatesTopHydrated: ActCandidateLike[]
): string {
  return toFamilyKey(
    actCandidatesTopHydrated.find((candidate) => candidate.rada_nreg === act.rada_nreg)?.category ??
      act.category
  );
}

function hasMaterialPrimaryEvidence(evidence: ChunksEvidenceLike | undefined): boolean {
  if (!evidence) return false;
  return (
    (evidence.rank_mass_top30 ?? 0) >= 0.3 ||
    ((evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 10 &&
      (evidence.max_ordering_score ?? 0) >= 0.35)
  );
}

const STRONG_TAXONOMY_SEMANTIC_REASON_CODES = new Set([
  'exact_alias_match',
  'exact_title_match',
  'alias_match',
  'title_match',
  'summary_match',
  'keyword_match',
  'topic_match',
]);

function isTaxonomyBackedAct(
  radaNreg: string,
  selectedActsSourcesBreakdown: SelectedActsSourcesBreakdownLike | undefined
): boolean {
  if (!selectedActsSourcesBreakdown) return false;
  return (
    selectedActsSourcesBreakdown.from_taxonomy?.includes(radaNreg) === true ||
    selectedActsSourcesBreakdown.from_acts_search?.includes(radaNreg) === true
  );
}

function hasStrongTaxonomySemanticSupport(
  act: SelectedActLike,
  actCandidatesTopHydrated: ActCandidateLike[]
): boolean {
  const candidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === act.rada_nreg);
  if (!candidate) return false;
  if ((candidate.score ?? 0) < 1) return false;
  return candidate.reasons?.some((reasonCode) => STRONG_TAXONOMY_SEMANTIC_REASON_CODES.has(reasonCode)) === true;
}

function sortActsForLowConfidence(input: {
  acts: SelectedActLike[];
  domainHint?: string;
  actCandidatesTopHydrated: ActCandidateLike[];
  evidenceByNreg: Map<string, ChunksEvidenceLike>;
}): SelectedActLike[] {
  const { acts, domainHint, actCandidatesTopHydrated, evidenceByNreg } = input;
  return [...acts].sort((left, right) => {
    const leftFamily = resolveActFamilyKey(left, actCandidatesTopHydrated);
    const rightFamily = resolveActFamilyKey(right, actCandidatesTopHydrated);
    const leftDomainAligned =
      left.act_kind === 'PRIMARY_LAW' && isDomainHintAlignedFamily(domainHint, leftFamily);
    const rightDomainAligned =
      right.act_kind === 'PRIMARY_LAW' && isDomainHintAlignedFamily(domainHint, rightFamily);
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
  });
}

function shouldPreserveTwoActLowConfidenceBundle(input: {
  sortedActs: SelectedActLike[];
  domainHint?: string;
  actCandidatesTopHydrated: ActCandidateLike[];
  evidenceByNreg: Map<string, ChunksEvidenceLike>;
  selectedActsSourcesBreakdown?: SelectedActsSourcesBreakdownLike;
}): boolean {
  const topTwo = input.sortedActs.slice(0, 2);
  if (topTwo.length < 2) return false;
  if (topTwo.some((act) => act.act_kind !== 'PRIMARY_LAW')) return false;

  const materialEvidenceCount = topTwo.filter((act) =>
    hasMaterialPrimaryEvidence(input.evidenceByNreg.get(act.rada_nreg ?? ''))
  ).length;
  const taxonomyBackedStrongSemanticCount = topTwo.filter(
    (act) =>
      isTaxonomyBackedAct(act.rada_nreg ?? '', input.selectedActsSourcesBreakdown) &&
      hasStrongTaxonomySemanticSupport(act, input.actCandidatesTopHydrated)
  ).length;
  if (materialEvidenceCount === 0) return false;
  if (materialEvidenceCount + taxonomyBackedStrongSemanticCount < 2) {
    return false;
  }

  const families = topTwo.map((act) => resolveActFamilyKey(act, input.actCandidatesTopHydrated));
  const bothDomainAligned = families.every((familyKey) =>
    isDomainHintAlignedFamily(input.domainHint, familyKey)
  );
  if (bothDomainAligned) return true;

  return areCompatiblePrimaryFamilies(families[0] ?? 'unknown', families[1] ?? 'unknown');
}

function buildRecoveredCompanionAct(
  input: NormalizeSingleGoalLowConfidenceSelectionInput,
  selectedActsFinal: SelectedActLike[],
  evidenceByNreg: Map<string, ChunksEvidenceLike>
): SelectedActLike | null {
  if (selectedActsFinal.length !== 1) return null;
  const leadAct = selectedActsFinal[0];
  if (!leadAct || leadAct.act_kind !== 'PRIMARY_LAW') return null;

  const leadFamily = resolveActFamilyKey(leadAct, input.actCandidatesTopHydrated);
  const leadActsCandidateScore =
    input.actCandidatesTopHydrated.find((candidate) => candidate.rada_nreg === leadAct.rada_nreg)?.score ??
    leadAct.score ??
    0;
  const companionCandidate = input.actCandidatesTopHydrated
    .filter((candidate) => candidate.rada_nreg !== leadAct.rada_nreg)
    .filter((candidate) => {
      const companionFamily = toFamilyKey(candidate.category);
      if (!areCompatiblePrimaryFamilies(leadFamily, companionFamily)) return false;
      const evidence = evidenceByNreg.get(candidate.rada_nreg);
      const strongSemanticCandidate = hasStrongTaxonomySemanticSupport(
        candidate as SelectedActLike,
        input.actCandidatesTopHydrated
      );
      if (!strongSemanticCandidate) return false;
      const retainedMetadataGrounding = isTaxonomyBackedAct(
        candidate.rada_nreg,
        input.selectedActsSourcesBreakdown
      );
      const strongActsCandidateScore = (candidate.score ?? 0) >= 1.2;
      if (!retainedMetadataGrounding && !strongActsCandidateScore) return false;
      const hasChunkEvidence =
        (evidence?.rank_mass_top30 ?? 0) >= 0.08 ||
        (evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 12;
      const dominantSameFamilyActsCandidate =
        companionFamily === leadFamily &&
        strongActsCandidateScore &&
        (candidate.score ?? 0) >= leadActsCandidateScore + 0.25;
      return hasChunkEvidence || dominantSameFamilyActsCandidate;
    })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];

  if (!companionCandidate) return null;
  return {
    rada_nreg: companionCandidate.rada_nreg,
    act_title: companionCandidate.title,
    category: companionCandidate.category ?? null,
    document_type: companionCandidate.document_type ?? null,
    act_kind: 'PRIMARY_LAW',
    score: companionCandidate.score,
    source_tags: ['TAXONOMY'],
  };
}

function buildRecoveredScopedPrimaryAct(
  input: NormalizeSingleGoalLowConfidenceSelectionInput,
  evidenceByNreg: Map<string, ChunksEvidenceLike>,
  excludedNregs: Set<string>
): SelectedActLike | null {
  const selectedFamilies = input.selectedActsFinal.map((act) =>
    resolveActFamilyKey(act, input.actCandidatesTopHydrated)
  );
  const recoveredCandidate = input.actCandidatesTopHydrated
    .filter((candidate) => !excludedNregs.has(candidate.rada_nreg))
    .filter((candidate) => {
      const candidateAct = candidate as SelectedActLike;
      if (
        classifyActKind(
          candidate.title ?? candidate.rada_nreg,
          candidate.document_type ?? null,
          candidate.category ?? null
        ) !== 'PRIMARY_LAW'
      ) {
        return false;
      }
      if (!hasStrongTaxonomySemanticSupport(candidateAct, input.actCandidatesTopHydrated)) return false;
      const evidence = evidenceByNreg.get(candidate.rada_nreg);
      const hasRecoveryEvidence =
        (evidence?.rank_mass_top30 ?? 0) >= 0.08 ||
        (
          (evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 12 &&
          (evidence?.max_ordering_score ?? 0) >= 0.35
        );
      if (!hasRecoveryEvidence) return false;

      const candidateFamily = toFamilyKey(candidate.category);
      return (
        isDomainHintAlignedFamily(input.domainHint, candidateFamily) ||
        selectedFamilies.some((familyKey) => areCompatiblePrimaryFamilies(candidateFamily, familyKey))
      );
    })
    .sort((left, right) => {
      const leftFamily = toFamilyKey(left.category);
      const rightFamily = toFamilyKey(right.category);
      const leftDomainAligned = isDomainHintAlignedFamily(input.domainHint, leftFamily);
      const rightDomainAligned = isDomainHintAlignedFamily(input.domainHint, rightFamily);
      if (leftDomainAligned !== rightDomainAligned) return Number(rightDomainAligned) - Number(leftDomainAligned);
      const leftEvidence = evidenceByNreg.get(left.rada_nreg);
      const rightEvidence = evidenceByNreg.get(right.rada_nreg);
      const evidenceDiff = compareTrimEvidence(
        {
          score: left.score,
          rankMassTop30: leftEvidence?.rank_mass_top30,
          bestRankInTop30: leftEvidence?.best_rank_in_top30,
        },
        {
          score: right.score,
          rankMassTop30: rightEvidence?.rank_mass_top30,
          bestRankInTop30: rightEvidence?.best_rank_in_top30,
        }
      );
      if (evidenceDiff !== 0) return evidenceDiff;
      return (right.score ?? 0) - (left.score ?? 0);
    })[0];

  if (!recoveredCandidate) return null;
  return {
    rada_nreg: recoveredCandidate.rada_nreg,
    act_title: recoveredCandidate.title,
    category: recoveredCandidate.category ?? null,
    document_type: recoveredCandidate.document_type ?? null,
    act_kind: 'PRIMARY_LAW',
    score: recoveredCandidate.score,
    source_tags: ['TAXONOMY'],
  };
}

export function normalizeSingleGoalLowConfidenceSelection(
  input: NormalizeSingleGoalLowConfidenceSelectionInput
): NormalizeSingleGoalLowConfidenceSelectionOutput {
  const reasonCodes = [...input.reasonCodes];
  let selectedActsFinal = [...input.selectedActsFinal];
  let selectedActsFinalMeta = input.selectedActsFinalMeta;
  const buildOutput = (): NormalizeSingleGoalLowConfidenceSelectionOutput => ({
    selectedActsFinal,
    selectedActsFinalMeta,
    selectedActsSourcesBreakdown: syncSelectedActsSourcesBreakdown(
      input.selectedActsSourcesBreakdown,
      selectedActsFinal
    ),
    reasonCodes: uniqueStrings(reasonCodes),
  });
  if (!input.lowConfidence || input.preserveScopedSelection) {
    return buildOutput();
  }

  const evidenceByNreg = buildEvidenceMap(input.chunksEvidenceTopActs);
  const explicitScopeNoConvergence =
    reasonCodes.includes('EXACT_ACT_SCOPE_NO_CONVERGENCE') ||
    reasonCodes.includes('EXPLICIT_ACT_SCOPE_NO_CONVERGENCE') ||
    reasonCodes.includes('GROUNDED_ACT_SCOPE_NO_CONVERGENCE');
  const severeSignals =
    explicitScopeNoConvergence ||
    reasonCodes.includes('OUT_OF_SCOPE') ||
    reasonCodes.includes('FRAGMENTED_PRIMARY_FAMILY_SELECTION') ||
    reasonCodes.includes('UNGROUNDED_MULTI_FAMILY_SELECTION');
  const narrowingSignals =
    severeSignals ||
    reasonCodes.includes('UNGROUNDED_PRIMARY_FALLBACK') ||
    reasonCodes.includes('UNGROUNDED_PRIMARY_COMPANION_FALLBACK') ||
    reasonCodes.includes('DOMAIN_HINT_PRIMARY_FAMILY_MISMATCH');
  const strictNarrowingSignals = reasonCodes.includes('UNGROUNDED_PRIMARY_COMPANION_FALLBACK');
  const explicitUngroundedNonPrimarySingleton =
    input.explicitActScopeCueQuery === true &&
    selectedActsFinal.length === 1 &&
    selectedActsFinal[0]?.act_kind !== 'PRIMARY_LAW';

  if (explicitUngroundedNonPrimarySingleton) {
    selectedActsFinal = [];
    reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_CLEARED');
    reasonCodes.push('LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED');
    selectedActsFinalMeta = updateSelectedActsFinalMeta(
      selectedActsFinalMeta,
      selectedActsFinal,
      0.4,
      ['LOW_CONFIDENCE_SELECTED_ACTS_CLEARED', 'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED']
    );
    return buildOutput();
  }

  if (selectedActsFinal.length > 0 && severeSignals) {
    if (explicitScopeNoConvergence) {
      const sortedActs = sortActsForLowConfidence({
        acts: selectedActsFinal,
        domainHint: input.domainHint,
        actCandidatesTopHydrated: input.actCandidatesTopHydrated,
        evidenceByNreg,
      });
      const recoveredScopedPrimaryAct = buildRecoveredScopedPrimaryAct(
        input,
        evidenceByNreg,
        new Set(sortedActs.map((act) => act.rada_nreg ?? '').filter(Boolean))
      );
      if (recoveredScopedPrimaryAct) {
        selectedActsFinal = [recoveredScopedPrimaryAct];
        reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED');
        reasonCodes.push('LOW_CONFIDENCE_EXPLICIT_SCOPE_PRIMARY_RECOVERED');
        selectedActsFinalMeta = updateSelectedActsFinalMeta(
          selectedActsFinalMeta,
          selectedActsFinal,
          0.5,
          ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED', 'LOW_CONFIDENCE_EXPLICIT_SCOPE_PRIMARY_RECOVERED']
        );
        return buildOutput();
      }
      const canPreserveEvidenceBackedBundle =
        selectedActsFinal.length >= 2 &&
        shouldPreserveTwoActLowConfidenceBundle({
          sortedActs,
          domainHint: input.domainHint,
          actCandidatesTopHydrated: input.actCandidatesTopHydrated,
          evidenceByNreg,
          selectedActsSourcesBreakdown: input.selectedActsSourcesBreakdown,
        });
      const retainedTopPrimaryAct = sortedActs.find((act) => act.act_kind === 'PRIMARY_LAW');
      const retainedTopPrimaryEvidence = retainedTopPrimaryAct
        ? evidenceByNreg.get(retainedTopPrimaryAct.rada_nreg ?? '')
        : undefined;
      const retainedTopPrimaryHasStrongSemanticSupport =
        !!retainedTopPrimaryAct &&
        isTaxonomyBackedAct(retainedTopPrimaryAct.rada_nreg ?? '', input.selectedActsSourcesBreakdown) &&
        hasStrongTaxonomySemanticSupport(retainedTopPrimaryAct, input.actCandidatesTopHydrated);

      if (canPreserveEvidenceBackedBundle) {
        selectedActsFinal = sortedActs.slice(0, 2);
        reasonCodes.push('LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED');
        reasonCodes.push('LOW_CONFIDENCE_EXPLICIT_SCOPE_BUNDLE_PRESERVED');
        selectedActsFinalMeta = updateSelectedActsFinalMeta(
          selectedActsFinalMeta,
          selectedActsFinal,
          0.5,
          ['LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED', 'LOW_CONFIDENCE_EXPLICIT_SCOPE_BUNDLE_PRESERVED']
        );
        return buildOutput();
      }

      if (
        retainedTopPrimaryAct &&
        (
        hasMaterialPrimaryEvidence(retainedTopPrimaryEvidence) ||
          retainedTopPrimaryHasStrongSemanticSupport
        )
      ) {
        selectedActsFinal = [retainedTopPrimaryAct];
        reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED');
        reasonCodes.push('LOW_CONFIDENCE_EXPLICIT_SCOPE_PRIMARY_PRESERVED');
        selectedActsFinalMeta = updateSelectedActsFinalMeta(
          selectedActsFinalMeta,
          selectedActsFinal,
          0.5,
          ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED', 'LOW_CONFIDENCE_EXPLICIT_SCOPE_PRIMARY_PRESERVED']
        );
        return buildOutput();
      }

      selectedActsFinal = [];
      reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_CLEARED');
      reasonCodes.push('LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.4,
        ['LOW_CONFIDENCE_SELECTED_ACTS_CLEARED', 'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED']
      );
      return buildOutput();
    }
    const primaryActs = selectedActsFinal.filter((act) => act.act_kind === 'PRIMARY_LAW');
    const domainAlignedPrimaryActs = primaryActs.filter((act) =>
      isDomainHintAlignedFamily(
        input.domainHint,
        resolveActFamilyKey(act, input.actCandidatesTopHydrated)
      )
    );
    const sortedActs = sortActsForLowConfidence({
      acts: selectedActsFinal,
      domainHint: input.domainHint,
      actCandidatesTopHydrated: input.actCandidatesTopHydrated,
      evidenceByNreg,
    });
    const retainedTopPrimaryAct = sortedActs.find((act) => act.act_kind === 'PRIMARY_LAW');
    const retainedTopPrimaryEvidence = retainedTopPrimaryAct
      ? evidenceByNreg.get(retainedTopPrimaryAct.rada_nreg ?? '')
      : undefined;
    const retainedRunnerUpPrimaryAct = sortedActs
      .filter((act) => act.act_kind === 'PRIMARY_LAW' && act.rada_nreg !== retainedTopPrimaryAct?.rada_nreg)[0];
    const retainedRunnerUpPrimaryEvidence = retainedRunnerUpPrimaryAct
      ? evidenceByNreg.get(retainedRunnerUpPrimaryAct.rada_nreg ?? '')
      : undefined;
    const canRetainTopPrimaryActWithoutDomainHint =
      input.preferPrimaryLawRetention === true &&
      !reasonCodes.includes('OUT_OF_SCOPE') &&
      !!retainedTopPrimaryAct &&
      hasMaterialPrimaryEvidence(retainedTopPrimaryEvidence) &&
      (
        !retainedRunnerUpPrimaryAct ||
        (retainedTopPrimaryEvidence?.rank_mass_top30 ?? 0) >=
          ((retainedRunnerUpPrimaryEvidence?.rank_mass_top30 ?? 0) + 0.25) ||
        (
          (retainedTopPrimaryEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) + 2 <=
            (retainedRunnerUpPrimaryEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) &&
          (retainedTopPrimaryEvidence?.max_ordering_score ?? 0) >=
            ((retainedRunnerUpPrimaryEvidence?.max_ordering_score ?? 0) + 0.03)
        )
      );
    const canRetainDominantDomainAlignedPrimaryAct =
      !reasonCodes.includes('OUT_OF_SCOPE') &&
      !!retainedTopPrimaryAct &&
      isDomainHintAlignedFamily(
        input.domainHint,
        resolveActFamilyKey(retainedTopPrimaryAct, input.actCandidatesTopHydrated)
      ) &&
      hasMaterialPrimaryEvidence(retainedTopPrimaryEvidence) &&
      (
        !retainedRunnerUpPrimaryAct ||
        !hasMaterialPrimaryEvidence(retainedRunnerUpPrimaryEvidence) ||
        (retainedTopPrimaryEvidence?.rank_mass_top30 ?? 0) >=
          ((retainedRunnerUpPrimaryEvidence?.rank_mass_top30 ?? 0) + 0.25) ||
        (
          (retainedTopPrimaryEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) + 2 <=
            (retainedRunnerUpPrimaryEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) &&
          (retainedTopPrimaryEvidence?.max_ordering_score ?? 0) >=
            ((retainedRunnerUpPrimaryEvidence?.max_ordering_score ?? 0) + 0.03)
        )
      );
    if (!reasonCodes.includes('OUT_OF_SCOPE') && domainAlignedPrimaryActs.length === 1) {
      selectedActsFinal = domainAlignedPrimaryActs;
      reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.5,
        ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED']
      );
    } else if (canRetainDominantDomainAlignedPrimaryAct && retainedTopPrimaryAct) {
      selectedActsFinal = [retainedTopPrimaryAct];
      reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.5,
        ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED']
      );
    } else if (canRetainTopPrimaryActWithoutDomainHint && retainedTopPrimaryAct) {
      selectedActsFinal = [retainedTopPrimaryAct];
      reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.5,
        ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED']
      );
    } else {
      selectedActsFinal = [];
      reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_CLEARED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.4,
        ['LOW_CONFIDENCE_SELECTED_ACTS_CLEARED']
      );
    }
  } else if (selectedActsFinal.length > 1 && narrowingSignals) {
    const sortedActs = sortActsForLowConfidence({
      acts: selectedActsFinal,
      domainHint: input.domainHint,
      actCandidatesTopHydrated: input.actCandidatesTopHydrated,
      evidenceByNreg,
    });
    if (
      selectedActsFinal.length >= 2 &&
      !strictNarrowingSignals &&
      shouldPreserveTwoActLowConfidenceBundle({
        sortedActs,
        domainHint: input.domainHint,
        actCandidatesTopHydrated: input.actCandidatesTopHydrated,
        evidenceByNreg,
        selectedActsSourcesBreakdown: input.selectedActsSourcesBreakdown,
      })
    ) {
      selectedActsFinal = sortedActs.slice(0, 2);
      reasonCodes.push('LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.5,
        ['LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED']
      );
    } else {
      selectedActsFinal = sortedActs.slice(0, 1);
      reasonCodes.push('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.5,
        ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED']
      );
    }
  }

  if (selectedActsFinal.length === 1 && narrowingSignals && !strictNarrowingSignals) {
    const recoveredCompanionAct = buildRecoveredCompanionAct(input, selectedActsFinal, evidenceByNreg);
    if (recoveredCompanionAct) {
      selectedActsFinal = sortActsForLowConfidence({
        acts: [...selectedActsFinal, recoveredCompanionAct],
        domainHint: input.domainHint,
        actCandidatesTopHydrated: input.actCandidatesTopHydrated,
        evidenceByNreg,
      }).slice(0, 2);
      reasonCodes.push('LOW_CONFIDENCE_COMPANION_ACT_RECOVERED');
      selectedActsFinalMeta = updateSelectedActsFinalMeta(
        selectedActsFinalMeta,
        selectedActsFinal,
        0.5,
        ['LOW_CONFIDENCE_COMPANION_ACT_RECOVERED']
      );
    }
  }

  if (selectedActsFinal.length > 2) {
    selectedActsFinal = sortActsForLowConfidence({
      acts: selectedActsFinal,
      domainHint: input.domainHint,
      actCandidatesTopHydrated: input.actCandidatesTopHydrated,
      evidenceByNreg,
    }).slice(0, 2);
    reasonCodes.push('LOW_CONFIDENCE_TAIL_TRIMMED');
    selectedActsFinalMeta = updateSelectedActsFinalMeta(
      selectedActsFinalMeta,
      selectedActsFinal,
      0.5,
      ['LOW_CONFIDENCE_TAIL_TRIMMED']
    );
  }

  return buildOutput();
}
