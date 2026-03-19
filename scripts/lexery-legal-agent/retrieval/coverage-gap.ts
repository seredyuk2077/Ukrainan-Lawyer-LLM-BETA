export type CoverageGap = 'none' | 'weak_evidence' | 'likely_missing_act' | 'out_of_scope';

export interface DeriveCoverageGapInput {
  lowConfidence: boolean;
  reasonCodes: string[];
  selectedActsCount: number;
  selectedActsConfidence?: number;
  selectedActKinds?: string[];
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
  if (reasonCodes.has('OUT_OF_SCOPE')) return 'out_of_scope';
  if (!input.lowConfidence) return 'none';

  const hasWeakEvidenceSignal =
    reasonCodes.has('LOW_EVIDENCE') ||
    reasonCodes.has('NO_PRIMARY_LAW_EVIDENCE') ||
    reasonCodes.has('ACT_SELECTION_LOW_CONFIDENCE') ||
    reasonCodes.has('EMPTY_SELECTED_ACTS_RECOVERED_FROM_EVIDENCE') ||
    reasonCodes.has('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY') ||
    reasonCodes.has('UNGROUNDED_PRIMARY_FALLBACK') ||
    reasonCodes.has('NON_PRIMARY_ONLY_WEAK_CONFIDENCE') ||
    reasonCodes.has('GOAL_ACT_POOL_WEAK');
  const hasMissingActSignal =
    reasonCodes.has('NO_STRONG_ACT_EVIDENCE') ||
    reasonCodes.has('COVERAGE_MISS_SELECTED_ACTS') ||
    reasonCodes.has('COVERAGE_GUARD_FAILED');
  const lowSelectionConfidence = (input.selectedActsConfidence ?? 0) < 0.55;
  const noStableSelectedActs = input.selectedActsCount === 0 || lowSelectionConfidence;
  const hasPrimarySelectedAct = (input.selectedActKinds ?? []).some((kind) => kind === 'PRIMARY_LAW');
  const nonPrimaryOrEmptySelection =
    input.selectedActsCount === 0 || (!hasPrimarySelectedAct && (input.selectedActKinds?.length ?? 0) > 0);
  const weakTopScore = (input.topScore ?? 0) < 0.42;
  const sparseOrWeakHits = input.hitsCount <= 5 || weakTopScore;

  if (looksLegallySpecific(input) && hasMissingActSignal && noStableSelectedActs && sparseOrWeakHits) {
    return 'likely_missing_act';
  }
  if (
    looksLegallySpecific(input) &&
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
