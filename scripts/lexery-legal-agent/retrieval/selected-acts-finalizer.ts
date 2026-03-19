import type { BuildSelectedActsOutput, SelectedActOutput, SelectedActsKindsCount } from './selected-acts.js';

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

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
  const { selected_acts_before_routing, selected_acts_final } = input;
  const baseReasonCodes = uniqueStrings(input.base_decision.reason_codes ?? []);
  const finalReasonCodes = [...baseReasonCodes];
  const retrievalEvidenceNregs = new Set(uniqueStrings(input.retrieval_evidence_nregs ?? []));
  const routingHintsAddedNregs = uniqueStrings(input.routing_hints_added_nregs ?? []);
  const routingHintsRecoveredWithRetrievalEvidence =
    routingHintsAddedNregs.length > 0 &&
    routingHintsAddedNregs.some((radaNreg) => retrievalEvidenceNregs.has(radaNreg));

  let selected_acts_confidence_final = input.base_confidence;
  if (
    input.routing_hints_added_primary_law &&
    routingHintsRecoveredWithRetrievalEvidence &&
    selected_acts_final.length > selected_acts_before_routing.length &&
    selected_acts_confidence_final < ROUTING_HINTS_CONFIDENCE_FLOOR
  ) {
    selected_acts_confidence_final = ROUTING_HINTS_CONFIDENCE_FLOOR;
  }

  if (input.routing_hints_added_count > 0 && !finalReasonCodes.includes('ROUTING_HINTS_ADDED_PRIMARY_LAW')) {
    finalReasonCodes.push('ROUTING_HINTS_ADDED_PRIMARY_LAW');
  }

  const summary = summarizeSelectedActs(selected_acts_final);
  return {
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
