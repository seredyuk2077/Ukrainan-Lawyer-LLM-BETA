import {
  SELECTED_ACTS_MAX_OUT,
  type BuildSelectedActsOutput,
  type SelectedActOutput,
  type SelectedActsKindsCount,
} from './selected-acts.js';
import { normalizeRadaNreg, uniqueStrings } from './retrieval-utils.js';

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
  routing_hints_added_count: number;
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
