import {
  SELECTED_ACTS_MAX_OUT,
  type BuildSelectedActsOutput,
  type SelectedActOutput,
  type SelectedActsKindsCount,
} from '../selected-acts.js';
import { normalizeRadaNreg, uniqueStrings } from '../helpers/retrieval-utils.js';

export type SelectedActsSourcesBreakdownLike = BuildSelectedActsOutput['selected_acts_sources_breakdown'] & {
  from_routing_hints?: string[];
};

export function summarizeSelectedActs(acts: SelectedActOutput[]): {
  selected_acts_kinds_count: SelectedActsKindsCount;
  selected_acts_document_types_top?: string[];
} {
  const kindsCount: SelectedActsKindsCount = {};
  const docTypeCounts = new Map<string, number>();

  for (const act of acts) {
    const kind = act.act_kind;
    if (kind) {
      kindsCount[kind] = (kindsCount[kind] ?? 0) + 1;
    }
    const docType = act.document_type?.trim();
    if (docType) {
      docTypeCounts.set(docType, (docTypeCounts.get(docType) ?? 0) + 1);
    }
  }

  const selected_acts_document_types_top = [...docTypeCounts.entries()]
    .sort((a, b) => {
      const countDiff = b[1] - a[1];
      if (countDiff !== 0) return countDiff;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 5)
    .map(([docType]) => docType);

  return {
    selected_acts_kinds_count: kindsCount,
    selected_acts_document_types_top:
      selected_acts_document_types_top.length > 0 ? selected_acts_document_types_top : undefined,
  };
}

export interface FinalizeSelectedActsAfterRoutingInput {
  selected_acts_before_routing: SelectedActOutput[];
  selected_acts_final: SelectedActOutput[];
  base_confidence: number;
  base_decision: BuildSelectedActsOutput['selected_acts_decision'];
  routing_hints_added_primary_law: boolean;
  routing_hints_added_nregs?: string[];
  retrieval_evidence_nregs?: string[];
}

export interface FinalizeSelectedActsAfterRoutingOutput {
  selected_acts_final: SelectedActOutput[];
  selected_acts_confidence_final: number;
  selected_acts_confidence_pre_routing: number;
  selected_acts_decision_final: BuildSelectedActsOutput['selected_acts_decision'];
  selected_acts_kinds_count_final: SelectedActsKindsCount;
  selected_acts_document_types_top_final?: string[];
  routing_hints_recovered_with_retrieval_evidence: boolean;
}

export function updateSelectedActsFinalMeta(
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput,
  selectedActsFinal: SelectedActOutput[],
  minConfidenceCap: number,
  addedReasonCodes: string[]
): FinalizeSelectedActsAfterRoutingOutput {
  const summary = summarizeSelectedActs(selectedActsFinal);
  const nextReasonCodes = uniqueStrings([
    ...(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? []),
    ...addedReasonCodes,
  ]);
  return {
    ...selectedActsFinalMeta,
    selected_acts_final: selectedActsFinal,
    selected_acts_confidence_final:
      selectedActsFinal.length === 0
        ? Math.min(selectedActsFinalMeta.selected_acts_confidence_final, minConfidenceCap)
        : Math.min(selectedActsFinalMeta.selected_acts_confidence_final, Math.max(minConfidenceCap, 0.55)),
    selected_acts_decision_final: {
      ...selectedActsFinalMeta.selected_acts_decision_final,
      reason_codes: nextReasonCodes,
    },
    selected_acts_kinds_count_final: summary.selected_acts_kinds_count,
    selected_acts_document_types_top_final: summary.selected_acts_document_types_top,
  };
}

export function syncSelectedActsSourcesBreakdown(
  selectedActsSourcesBreakdown: SelectedActsSourcesBreakdownLike | undefined,
  selectedActsFinal: Array<Pick<SelectedActOutput, 'rada_nreg' | 'source_tags'>>
): SelectedActsSourcesBreakdownLike | undefined {
  if (!selectedActsSourcesBreakdown && selectedActsFinal.length === 0) return undefined;

  const selectedNregs = new Set(
    selectedActsFinal.map((act) => normalizeRadaNreg(act.rada_nreg)).filter(Boolean)
  );
  const retainMatchingNregs = (values: Array<string | null | undefined>): string[] =>
    uniqueStrings(values.filter((radaNreg) => selectedNregs.has(normalizeRadaNreg(radaNreg))));

  const next: SelectedActsSourcesBreakdownLike = {
    from_taxonomy: retainMatchingNregs(selectedActsSourcesBreakdown?.from_taxonomy ?? []),
    from_acts_search: retainMatchingNregs(selectedActsSourcesBreakdown?.from_acts_search ?? []),
    from_chunks_evidence: retainMatchingNregs(selectedActsSourcesBreakdown?.from_chunks_evidence ?? []),
    from_routing_hints: retainMatchingNregs(selectedActsSourcesBreakdown?.from_routing_hints ?? []),
  };

  for (const act of selectedActsFinal) {
    const radaNreg = act.rada_nreg?.trim();
    const normalizedRadaNreg = normalizeRadaNreg(radaNreg);
    if (!radaNreg || !normalizedRadaNreg) continue;
    const sourceTags = new Set(act.source_tags ?? []);
    if (sourceTags.has('TAXONOMY')) {
      next.from_taxonomy = uniqueStrings([...(next.from_taxonomy ?? []), radaNreg]);
    }
    if (sourceTags.has('ACTS_SEARCH')) {
      next.from_acts_search = uniqueStrings([...(next.from_acts_search ?? []), radaNreg]);
    }
    if (sourceTags.has('CHUNKS_EVIDENCE')) {
      next.from_chunks_evidence = uniqueStrings([...(next.from_chunks_evidence ?? []), radaNreg]);
    }
    if (sourceTags.has('ROUTING_HINTS')) {
      next.from_routing_hints = uniqueStrings([...(next.from_routing_hints ?? []), radaNreg]);
    }
  }

  return next;
}

const ROUTING_HINTS_CONFIDENCE_FLOOR = 0.6;

export function finalizeSelectedActsAfterRouting(
  input: FinalizeSelectedActsAfterRoutingInput
): FinalizeSelectedActsAfterRoutingOutput {
  const { selected_acts_before_routing } = input;
  const baseReasonCodes = uniqueStrings(input.base_decision.reason_codes ?? []);
  const finalReasonCodes = [...baseReasonCodes];
  const retrievalEvidenceNregs = new Set(
    uniqueStrings(input.retrieval_evidence_nregs ?? []).map((value) => normalizeRadaNreg(value)).filter(Boolean)
  );
  const routingHintsAddedNregs = uniqueStrings(input.routing_hints_added_nregs ?? []);
  const beforeRoutingNregs = new Set(
    selected_acts_before_routing.map((act) => normalizeRadaNreg(act.rada_nreg)).filter(Boolean)
  );
  let selectedActsFinal = [...input.selected_acts_final];
  const unsupportedAddedNregs = routingHintsAddedNregs.filter(
    (radaNreg) => !retrievalEvidenceNregs.has(normalizeRadaNreg(radaNreg))
  );
  if (unsupportedAddedNregs.length > 0) {
    const unsupportedSet = new Set(unsupportedAddedNregs.map((radaNreg) => normalizeRadaNreg(radaNreg)).filter(Boolean));
    selectedActsFinal = selectedActsFinal.filter((act) => !unsupportedSet.has(normalizeRadaNreg(act.rada_nreg)));
    finalReasonCodes.push('ROUTING_HINTS_UNSUPPORTED_REMOVED');
  }
  if (selectedActsFinal.length > SELECTED_ACTS_MAX_OUT) {
    const overflow = selectedActsFinal.length - SELECTED_ACTS_MAX_OUT;
    if (overflow > 0) {
      const overflowAdded = routingHintsAddedNregs.filter(
        (radaNreg) =>
          !beforeRoutingNregs.has(normalizeRadaNreg(radaNreg)) &&
          !retrievalEvidenceNregs.has(normalizeRadaNreg(radaNreg))
      );
      if (overflowAdded.length > 0) {
        const toDrop = new Set(
          overflowAdded.slice(0, overflow).map((radaNreg) => normalizeRadaNreg(radaNreg)).filter(Boolean)
        );
        selectedActsFinal = selectedActsFinal.filter((act) => !toDrop.has(normalizeRadaNreg(act.rada_nreg)));
        finalReasonCodes.push('ROUTING_HINTS_CAP_TRIMMED');
      }
    }
  }
  const retainedRoutingActs = routingHintsAddedNregs.filter((radaNreg) =>
    selectedActsFinal.some((act) => normalizeRadaNreg(act.rada_nreg) === normalizeRadaNreg(radaNreg))
  );
  const routingHintsRecoveredWithRetrievalEvidence =
    retainedRoutingActs.length > 0 &&
    retainedRoutingActs.some((radaNreg) => retrievalEvidenceNregs.has(normalizeRadaNreg(radaNreg)));

  let selected_acts_confidence_final = input.base_confidence;
  if (
    input.routing_hints_added_primary_law &&
    routingHintsRecoveredWithRetrievalEvidence &&
    selectedActsFinal.length > selected_acts_before_routing.length &&
    selected_acts_confidence_final < ROUTING_HINTS_CONFIDENCE_FLOOR
  ) {
    selected_acts_confidence_final = ROUTING_HINTS_CONFIDENCE_FLOOR;
  }

  if (retainedRoutingActs.length > 0 && !finalReasonCodes.includes('ROUTING_HINTS_ADDED_PRIMARY_LAW')) {
    finalReasonCodes.push('ROUTING_HINTS_ADDED_PRIMARY_LAW');
  }

  const summary = summarizeSelectedActs(selectedActsFinal);
  return {
    selected_acts_final: selectedActsFinal,
    selected_acts_confidence_final,
    selected_acts_confidence_pre_routing: input.base_confidence,
    selected_acts_decision_final: {
      ...input.base_decision,
      reason_codes: finalReasonCodes,
    },
    selected_acts_kinds_count_final: summary.selected_acts_kinds_count,
    selected_acts_document_types_top_final: summary.selected_acts_document_types_top,
    routing_hints_recovered_with_retrieval_evidence: routingHintsRecoveredWithRetrievalEvidence,
  };
}
