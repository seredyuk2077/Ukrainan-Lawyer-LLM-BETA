const STICKY_SINGLE_GOAL_LOW_CONF_REASON_CODES = new Set([
  'COVERAGE_GUARD_FAILED',
  'COVERAGE_MISS_SELECTED_ACTS',
  'EXACT_ACT_SCOPE_NO_CONVERGENCE',
  'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
  'FAMILY_GUARD_NO_EVIDENCE',
  'FAMILY_GUARD_SKIPPED_STRONG_PRIMARY_COVERAGE',
  'GROUNDED_ACT_SCOPE_NO_CONVERGENCE',
  'MISSING_TAXONOMY_CONVERGENCE',
  'MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED',
  'NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY',
]);

export function hasStickySingleGoalLowConfidenceReason(reasonCodes: string[]): boolean {
  return reasonCodes.some((reasonCode) => STICKY_SINGLE_GOAL_LOW_CONF_REASON_CODES.has(reasonCode));
}

export function canRelaxCoverageGuardWithActGrounding(input: {
  selectedActsReasonCodes: string[];
  familyReasonCodes: string[];
  qrSignaledOod: boolean;
  exactActHitCount: number;
  groundedActHitCount: number;
  metadataGroundedSelectedActsCount: number;
}): boolean {
  if (!input.selectedActsReasonCodes.includes('COVERAGE_GUARD_FAILED')) return false;
  if (!input.familyReasonCodes.includes('FAMILY_DOMINANT_OK')) return false;
  if (input.qrSignaledOod) return false;
  return (
    input.exactActHitCount > 0 ||
    input.groundedActHitCount > 0 ||
    input.metadataGroundedSelectedActsCount > 0
  );
}

export function shouldFlagProceduralPrimaryWithoutActGrounding(input: {
  proceduralOnlyPrimarySelection: boolean;
  explicitActScopeCue: boolean;
  interrogativePrimaryLawLocatorQuery?: boolean;
  structuredActIdentifiersCount: number;
  documentTypeHintsCount: number;
  anchorsCount: number;
  exactActHitCount: number;
  groundedActHitCount: number;
  metadataGroundedPrimaryActsCount: number;
  leadSelectedMetadataGrounded: boolean;
}): boolean {
  const softPrimaryLawLocatorQuery = input.interrogativePrimaryLawLocatorQuery === true;
  const requiresActLevelGrounding =
    ((input.explicitActScopeCue || input.documentTypeHintsCount > 0) && !softPrimaryLawLocatorQuery) ||
    input.structuredActIdentifiersCount > 0 ||
    input.anchorsCount > 0;
  return (
    input.proceduralOnlyPrimarySelection &&
    requiresActLevelGrounding &&
    input.exactActHitCount === 0 &&
    input.groundedActHitCount === 0 &&
    input.metadataGroundedPrimaryActsCount === 0 &&
    !input.leadSelectedMetadataGrounded
  );
}
