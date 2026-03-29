export type CoverageGap = 'none' | 'weak_evidence' | 'likely_missing_act' | 'out_of_scope';

export interface DeriveCoverageGapInput {
  lowConfidence: boolean;
  reasonCodes: string[];
  selectedActsCount: number;
  selectedActsConfidence?: number;
  selectedActKinds?: string[];
  exactActHitCount?: number;
  groundedActHitCount?: number;
  metadataGroundedActCount?: number;
  mixedProcedureAndNonProcedureGoals?: boolean;
  proceduralOnlySelection?: boolean;
  explicitActScopeCue?: boolean;
  hitsCount: number;
  topScore?: number | null;
  domainHint?: string;
  categoryHintCount?: number;
  documentTypeHintCount?: number;
  entitiesCount?: number;
  anchorsCount?: number;
}

function normalizeReasonCodes(reasonCodes: string[]): Set<string> {
  return new Set(
    reasonCodes
      .map((reasonCode) => reasonCode.normalize('NFC').trim())
      .filter(Boolean)
  );
}

function looksLegallySpecific(input: DeriveCoverageGapInput): boolean {
  const normalizedDomainHint = (input.domainHint ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();
  const hasSpecificDomainHint =
    normalizedDomainHint.length > 0 &&
    normalizedDomainHint !== 'general' &&
    normalizedDomainHint !== 'unknown';
  return (
    hasSpecificDomainHint ||
    (input.entitiesCount ?? 0) > 0 ||
    (input.anchorsCount ?? 0) > 0 ||
    (input.categoryHintCount ?? 0) > 0 ||
    (input.documentTypeHintCount ?? 0) > 0
  );
}

export function deriveCoverageGap(input: DeriveCoverageGapInput): CoverageGap {
  const reasonCodes = normalizeReasonCodes(input.reasonCodes);
  const hasOutOfScopeSignal = reasonCodes.has('OUT_OF_SCOPE');
  if (!input.lowConfidence && !hasOutOfScopeSignal) return 'none';

  const hasWeakEvidenceSignal =
    reasonCodes.has('LOW_EVIDENCE') ||
    reasonCodes.has('NO_PRIMARY_LAW_EVIDENCE') ||
    reasonCodes.has('ACT_SELECTION_LOW_CONFIDENCE') ||
    reasonCodes.has('EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE') ||
    reasonCodes.has('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY') ||
    reasonCodes.has('UNGROUNDED_PRIMARY_FALLBACK') ||
    reasonCodes.has('NON_PRIMARY_ONLY_WEAK_CONFIDENCE') ||
    reasonCodes.has('GOAL_ACT_POOL_WEAK') ||
    reasonCodes.has('FRAGMENTED_PRIMARY_FAMILY_SELECTION') ||
    reasonCodes.has('DOMAIN_HINT_PRIMARY_FAMILY_MISMATCH') ||
    reasonCodes.has('UNGROUNDED_MULTI_FAMILY_SELECTION');
  const hasMissingActSignal =
    reasonCodes.has('NO_STRONG_ACT_EVIDENCE') ||
    reasonCodes.has('NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY') ||
    reasonCodes.has('COVERAGE_MISS_SELECTED_ACTS') ||
    reasonCodes.has('COVERAGE_GUARD_FAILED') ||
    reasonCodes.has('MISSING_TAXONOMY_CONVERGENCE') ||
    reasonCodes.has('EXPLICIT_ACT_SCOPE_NO_CONVERGENCE') ||
    reasonCodes.has('GROUNDED_ACT_SCOPE_NO_CONVERGENCE') ||
    reasonCodes.has('METADATA_ACT_SCOPE_NO_CONVERGENCE') ||
    reasonCodes.has('EVIDENCE_ACT_SCOPE_NO_CONVERGENCE') ||
    reasonCodes.has('MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED') ||
    reasonCodes.has('FAMILY_GUARD_NO_EVIDENCE') ||
    reasonCodes.has('FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE');
  const hasExplicitMissingTaxonomySignal = reasonCodes.has('MISSING_TAXONOMY_CONVERGENCE');
  const hasExplicitActScopeNoConvergence = reasonCodes.has('EXPLICIT_ACT_SCOPE_NO_CONVERGENCE');
  const hasGroundedActScopeNoConvergence = reasonCodes.has('GROUNDED_ACT_SCOPE_NO_CONVERGENCE');
  const hasMetadataActScopeNoConvergence = reasonCodes.has('METADATA_ACT_SCOPE_NO_CONVERGENCE');
  const hasEvidenceActScopeNoConvergence = reasonCodes.has('EVIDENCE_ACT_SCOPE_NO_CONVERGENCE');
  const hasAnyActScopeNoConvergence =
    hasExplicitActScopeNoConvergence ||
    hasGroundedActScopeNoConvergence ||
    hasMetadataActScopeNoConvergence ||
    hasEvidenceActScopeNoConvergence;
  const hasFamilyGuardMissingSignal =
    reasonCodes.has('FAMILY_GUARD_NO_EVIDENCE') ||
    reasonCodes.has('FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE');
  const hasIndexedActGroundingSignal =
    (input.exactActHitCount ?? 0) > 0 ||
    (input.groundedActHitCount ?? 0) > 0 ||
    (input.metadataGroundedActCount ?? 0) > 0;
  const hasStrongIndexedActGroundingSignal =
    (input.exactActHitCount ?? 0) > 0 || (input.groundedActHitCount ?? 0) > 0;
  const lowSelectionConfidence = (input.selectedActsConfidence ?? 0) < 0.55;
  const borderlineLowSelectionConfidence = (input.selectedActsConfidence ?? 0) <= 0.55;
  const noStableSelectedActs = input.selectedActsCount === 0 || lowSelectionConfidence;
  const hasPrimarySelectedAct = (input.selectedActKinds ?? []).some((kind) => kind === 'PRIMARY_LAW');
  const hasRecoverableSelectionSignal =
    hasStrongIndexedActGroundingSignal ||
    (
      input.selectedActsCount > 0 &&
      hasPrimarySelectedAct &&
      (input.selectedActsConfidence ?? 0) >= 0.5 &&
      input.hitsCount >= 8 &&
      (input.topScore ?? 0) >= 0.48
    );
  const nonPrimaryOrEmptySelection =
    input.selectedActsCount === 0 || (!hasPrimarySelectedAct && (input.selectedActKinds?.length ?? 0) > 0);
  const indexedSinglePrimarySelection =
    hasIndexedActGroundingSignal &&
    input.selectedActsCount === 1 &&
    hasPrimarySelectedAct &&
    !nonPrimaryOrEmptySelection;
  const weakTopScore = (input.topScore ?? 0) < 0.42;
  const sparseOrWeakHits = input.hitsCount <= 5 || weakTopScore;
  const strongSingleActProceduralSurface =
    input.selectedActsCount === 1 &&
    hasPrimarySelectedAct &&
    input.hitsCount >= 20 &&
    (input.topScore ?? 0) >= 0.55;
  const strongProceduralMultiActSurface =
    input.selectedActsCount >= 2 &&
    hasPrimarySelectedAct &&
    input.proceduralOnlySelection === true &&
    input.hitsCount >= 20 &&
    (input.topScore ?? 0) >= 0.55;

  if (
    hasOutOfScopeSignal &&
    input.explicitActScopeCue === true &&
    !hasStrongIndexedActGroundingSignal &&
    (input.metadataGroundedActCount ?? 0) === 0 &&
    noStableSelectedActs &&
    nonPrimaryOrEmptySelection
  ) {
    return 'likely_missing_act';
  }

  if (hasOutOfScopeSignal) return 'out_of_scope';

  if (
    reasonCodes.has('MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED') &&
    (indexedSinglePrimarySelection || strongSingleActProceduralSurface) &&
    hasPrimarySelectedAct &&
    input.selectedActsCount === 1 &&
    !reasonCodes.has('COVERAGE_MISS_SELECTED_ACTS') &&
    (
      input.mixedProcedureAndNonProcedureGoals !== true ||
      hasStrongIndexedActGroundingSignal ||
      (
        (input.metadataGroundedActCount ?? 0) === 0 &&
        !reasonCodes.has('MULTI_GOAL_FAMILY_MISMATCH_TAIL')
      )
    )
  ) {
    return 'weak_evidence';
  }

  if (
    reasonCodes.has('MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED') &&
    input.selectedActsCount === 1 &&
    hasPrimarySelectedAct &&
    input.mixedProcedureAndNonProcedureGoals !== true
  ) {
    return 'weak_evidence';
  }

  if (
    reasonCodes.has('UNGROUNDED_MULTI_GOAL_FALLBACK') &&
    strongSingleActProceduralSurface &&
    input.selectedActsCount === 1 &&
    hasPrimarySelectedAct &&
    input.proceduralOnlySelection === true &&
    input.mixedProcedureAndNonProcedureGoals !== true
  ) {
    return 'weak_evidence';
  }

  if (
    reasonCodes.has('UNGROUNDED_MULTI_GOAL_FALLBACK') &&
    strongProceduralMultiActSurface
  ) {
    return 'weak_evidence';
  }

  if (
    looksLegallySpecific(input) &&
    reasonCodes.has('UNGROUNDED_MULTI_GOAL_FALLBACK') &&
    input.mixedProcedureAndNonProcedureGoals === true &&
    input.proceduralOnlySelection === true &&
    (input.metadataGroundedActCount ?? 0) > 0 &&
    !hasStrongIndexedActGroundingSignal
  ) {
    return 'likely_missing_act';
  }

  if (reasonCodes.has('UNGROUNDED_MULTI_GOAL_FALLBACK')) {
    return hasIndexedActGroundingSignal ? 'weak_evidence' : 'likely_missing_act';
  }

  if (
    input.explicitActScopeCue === true &&
    !hasStrongIndexedActGroundingSignal &&
    (input.metadataGroundedActCount ?? 0) === 0 &&
    noStableSelectedActs &&
    nonPrimaryOrEmptySelection
  ) {
    return 'likely_missing_act';
  }

  if (
    looksLegallySpecific(input) &&
    !hasIndexedActGroundingSignal &&
    nonPrimaryOrEmptySelection &&
    borderlineLowSelectionConfidence &&
    reasonCodes.has('NON_PRIMARY_ONLY_WEAK_CONFIDENCE') &&
    reasonCodes.has('NO_PRIMARY_LAW_EVIDENCE')
  ) {
    return 'likely_missing_act';
  }
  if (
    looksLegallySpecific(input) &&
    !hasIndexedActGroundingSignal &&
    nonPrimaryOrEmptySelection &&
    borderlineLowSelectionConfidence &&
    reasonCodes.has('NON_PRIMARY_ONLY_WEAK_CONFIDENCE') &&
    hasFamilyGuardMissingSignal
  ) {
    return 'likely_missing_act';
  }

  if (looksLegallySpecific(input) && lowSelectionConfidence && hasExplicitMissingTaxonomySignal) {
    return hasRecoverableSelectionSignal ? 'weak_evidence' : 'likely_missing_act';
  }
  if (hasExplicitActScopeNoConvergence) {
    return hasRecoverableSelectionSignal ? 'weak_evidence' : 'likely_missing_act';
  }
  if (hasMetadataActScopeNoConvergence) {
    return hasRecoverableSelectionSignal || (input.metadataGroundedActCount ?? 0) > 0
      ? 'weak_evidence'
      : 'likely_missing_act';
  }
  if (hasGroundedActScopeNoConvergence || hasEvidenceActScopeNoConvergence) {
    return hasRecoverableSelectionSignal ? 'weak_evidence' : 'likely_missing_act';
  }
  if (looksLegallySpecific(input) && reasonCodes.has('NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY')) {
    return hasStrongIndexedActGroundingSignal ? 'weak_evidence' : 'likely_missing_act';
  }
  if (
    looksLegallySpecific(input) &&
    input.mixedProcedureAndNonProcedureGoals === true &&
    input.proceduralOnlySelection === true &&
    (hasMissingActSignal || hasWeakEvidenceSignal)
  ) {
    return 'likely_missing_act';
  }
  if (looksLegallySpecific(input) && lowSelectionConfidence && hasFamilyGuardMissingSignal && hasPrimarySelectedAct) {
    return 'likely_missing_act';
  }
  if (looksLegallySpecific(input) && hasMissingActSignal && noStableSelectedActs && sparseOrWeakHits) {
    return 'likely_missing_act';
  }
  if (
    looksLegallySpecific(input) &&
    !hasIndexedActGroundingSignal &&
    nonPrimaryOrEmptySelection &&
    noStableSelectedActs &&
    hasWeakEvidenceSignal &&
    (input.hitsCount <= 10 || weakTopScore)
  ) {
    return 'likely_missing_act';
  }
  if (hasWeakEvidenceSignal || hasMissingActSignal) return 'weak_evidence';
  return 'weak_evidence';
}
