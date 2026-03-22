import {
  extractStructuredActIdentifiers,
  looksLikeStructuredActIdentifier,
  type ActMeta,
} from './act-taxonomy-store.js';
import { hasExplicitActScopeCue } from './goal-splitter.js';
import {
  classifyActKind,
  type ActCandidateInput,
  type BuildSelectedActsOutput,
  type SelectedActOutput,
} from './selected-acts.js';
import {
  summarizeSelectedActs,
  type FinalizeSelectedActsAfterRoutingOutput,
} from './selected-acts-finalizer.js';

type SelectedActLike = {
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

type SelectedActsSourcesBreakdownLike = BuildSelectedActsOutput['selected_acts_sources_breakdown'] & {
  from_routing_hints?: string[];
};

export interface ResolveSingleActScopeSelectionInput {
  query: string;
  selectedActsFinal: SelectedActLike[];
  selectedActsSourcesBreakdownFinal: SelectedActsSourcesBreakdownLike;
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  reasonCodes: string[];
  chunksEvidenceTopActs: BuildSelectedActsOutput['chunks_evidence_top_acts'];
  actCandidatesTopHydrated: ActCandidateInput[];
  exactActNregs: string[];
  groundedActNregs: string[];
  topScore: number | null;
  getActMeta: (rada_nreg: string) => Promise<ActMeta | null>;
  metadataGroundingReasonCodes: Set<string>;
  nonPrimaryAuthoritativeKinds: Set<string>;
}

export interface ResolveSingleActScopeSelectionOutput {
  selectedActsFinal: SelectedActLike[];
  selectedActsSourcesBreakdownFinal: SelectedActsSourcesBreakdownLike;
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  reasonCodes: string[];
  exactActNregSet: Set<string>;
  exactSingleActConverged: boolean;
  groundedActNregSet: Set<string>;
  groundedSingleActConverged: boolean;
  explicitActScopeCueQuery: boolean;
  metadataSingleActConverged: boolean;
  topActCandidate?: ActCandidateInput;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function pushUnique(reasonCodes: string[], code: string): void {
  if (!reasonCodes.includes(code)) reasonCodes.push(code);
}

function countResidualQueryTokensAfterStructuredIds(query: string): number {
  const stripped = query
    .normalize('NFC')
    .replace(/[\p{L}\p{N}_/‐‑–—−-]{4,32}/gu, (match) =>
      looksLikeStructuredActIdentifier(match) ? ' ' : match
    );
  return stripped.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

function countQueryTokens(query: string): number {
  return query.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

export async function resolveSingleActScopeSelection(
  input: ResolveSingleActScopeSelectionInput
): Promise<ResolveSingleActScopeSelectionOutput> {
  const {
    query,
    chunksEvidenceTopActs,
    actCandidatesTopHydrated,
    exactActNregs,
    groundedActNregs,
    topScore,
    getActMeta,
    metadataGroundingReasonCodes,
    nonPrimaryAuthoritativeKinds,
  } = input;

  let selectedActsFinal = [...input.selectedActsFinal];
  let selectedActsSourcesBreakdownFinal = {
    ...input.selectedActsSourcesBreakdownFinal,
    from_taxonomy: [...input.selectedActsSourcesBreakdownFinal.from_taxonomy],
    from_acts_search: [...input.selectedActsSourcesBreakdownFinal.from_acts_search],
    from_chunks_evidence: [...input.selectedActsSourcesBreakdownFinal.from_chunks_evidence],
    from_routing_hints: input.selectedActsSourcesBreakdownFinal.from_routing_hints
      ? [...input.selectedActsSourcesBreakdownFinal.from_routing_hints]
      : undefined,
  };
  let selectedActsFinalMeta = input.selectedActsFinalMeta;
  const reasonCodes = [...input.reasonCodes];

  const exactActNregSet = new Set(exactActNregs);
  const exactSingleActConverged = exactActNregSet.size === 1;
  const groundedActNregSet = new Set(groundedActNregs);
  const groundedSingleActConverged = groundedActNregSet.size === 1;
  const explicitActScopeCueQuery =
    hasExplicitActScopeCue(query) || extractStructuredActIdentifiers(query).length >= 1;
  const topActCandidate = actCandidatesTopHydrated[0];
  const runnerUpActCandidate = actCandidatesTopHydrated[1];
  const metadataTopActGrounded =
    topActCandidate?.reasons?.some((reasonCode) => metadataGroundingReasonCodes.has(reasonCode)) ?? false;
  const metadataSingleActConverged =
    explicitActScopeCueQuery &&
    !exactSingleActConverged &&
    !groundedSingleActConverged &&
    !!topActCandidate?.rada_nreg &&
    metadataTopActGrounded &&
    (topActCandidate?.score ?? 0) >= ((runnerUpActCandidate?.score ?? 0) + 2);

  const explicitIdentifierScopedQuery =
    exactSingleActConverged &&
    extractStructuredActIdentifiers(query).length >= 1 &&
    countResidualQueryTokensAfterStructuredIds(query) <= 2;
  const compactGroundedActScopedQuery =
    !explicitIdentifierScopedQuery &&
    groundedSingleActConverged &&
    countQueryTokens(query) <= 6;

  if (
    (explicitIdentifierScopedQuery || compactGroundedActScopedQuery || metadataSingleActConverged) &&
    selectedActsFinal.length > 1 &&
    selectedActsFinal.some((act) =>
      explicitIdentifierScopedQuery
        ? exactActNregSet.has(act.rada_nreg)
        : compactGroundedActScopedQuery
          ? groundedActNregSet.has(act.rada_nreg)
          : act.rada_nreg === topActCandidate?.rada_nreg
    )
  ) {
    selectedActsFinal = selectedActsFinal
      .filter((act) =>
        explicitIdentifierScopedQuery
          ? exactActNregSet.has(act.rada_nreg)
          : compactGroundedActScopedQuery
            ? groundedActNregSet.has(act.rada_nreg)
            : act.rada_nreg === topActCandidate?.rada_nreg
      )
      .slice(0, 1);
    pushUnique(
      reasonCodes,
      explicitIdentifierScopedQuery
        ? 'EXACT_ACT_SCOPE_TRIMMED'
        : compactGroundedActScopedQuery
          ? 'GROUNDED_ACT_SCOPE_TRIMMED'
          : 'METADATA_ACT_SCOPE_TRIMMED'
    );
  }

  const chunksEvidenceByNreg = new Map(chunksEvidenceTopActs.map((item) => [item.rada_nreg, item] as const));
  const leadSelectedActBeforeScopeTrim = selectedActsFinal[0];
  const secondSelectedActBeforeScopeTrim = selectedActsFinal[1];
  const leadSelectedEvidenceBeforeScopeTrim = leadSelectedActBeforeScopeTrim
    ? chunksEvidenceByNreg.get(leadSelectedActBeforeScopeTrim.rada_nreg)
    : undefined;
  const secondSelectedEvidenceBeforeScopeTrim = secondSelectedActBeforeScopeTrim
    ? chunksEvidenceByNreg.get(secondSelectedActBeforeScopeTrim.rada_nreg)
    : undefined;
  const dominantExplicitNonPrimaryScope =
    explicitActScopeCueQuery &&
    selectedActsFinal.length > 1 &&
    !selectedActsFinal.some((act) => act.act_kind === 'PRIMARY_LAW') &&
    nonPrimaryAuthoritativeKinds.has(leadSelectedActBeforeScopeTrim?.act_kind ?? '') &&
    (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.75 &&
    (leadSelectedEvidenceBeforeScopeTrim?.count_in_top30 ?? 0) >= 5 &&
    (leadSelectedEvidenceBeforeScopeTrim?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
    (topScore ?? 0) >= 0.5 &&
    (
      secondSelectedEvidenceBeforeScopeTrim == null ||
      (leadSelectedEvidenceBeforeScopeTrim?.rank_mass_top30 ?? 0) >=
        (secondSelectedEvidenceBeforeScopeTrim.rank_mass_top30 ?? 0) + 0.35 ||
      (leadSelectedEvidenceBeforeScopeTrim?.count_in_top30 ?? 0) >=
        (secondSelectedEvidenceBeforeScopeTrim.count_in_top30 ?? 0) + 3
    );
  if (dominantExplicitNonPrimaryScope && leadSelectedActBeforeScopeTrim) {
    selectedActsFinal = [leadSelectedActBeforeScopeTrim];
    pushUnique(reasonCodes, 'AUTHORITATIVE_NON_PRIMARY_SCOPE_TRIMMED');
    const summary = summarizeSelectedActs(selectedActsFinal as SelectedActOutput[]);
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_final: selectedActsFinal as SelectedActOutput[],
      selected_acts_confidence_final: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.75),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: uniqueStrings([
          ...(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? []),
          'AUTHORITATIVE_NON_PRIMARY_SCOPE_TRIMMED',
        ]),
      },
      selected_acts_kinds_count_final: summary.selected_acts_kinds_count,
      selected_acts_document_types_top_final: summary.selected_acts_document_types_top,
    };
  }

  const scopeConstrainedNregSet =
    exactSingleActConverged && exactActNregSet.size === 1
      ? exactActNregSet
      : groundedSingleActConverged && groundedActNregSet.size === 1
        ? groundedActNregSet
        : metadataSingleActConverged && topActCandidate?.rada_nreg
          ? new Set([topActCandidate.rada_nreg])
        : null;
  const scopeConstraintCode =
    exactSingleActConverged && exactActNregSet.size === 1
      ? 'EXACT_ACT_SCOPE_FORCED'
      : groundedSingleActConverged && groundedActNregSet.size === 1
        ? 'GROUNDED_ACT_SCOPE_FORCED'
        : metadataSingleActConverged && topActCandidate?.rada_nreg
          ? 'METADATA_ACT_SCOPE_FORCED'
        : null;
  const scopeRecoveredCode =
    exactSingleActConverged && exactActNregSet.size === 1
      ? 'EXACT_ACT_SCOPE_RECOVERED'
      : groundedSingleActConverged && groundedActNregSet.size === 1
        ? 'GROUNDED_ACT_SCOPE_RECOVERED'
        : metadataSingleActConverged && topActCandidate?.rada_nreg
          ? 'METADATA_ACT_SCOPE_RECOVERED'
        : null;

  if (scopeConstrainedNregSet) {
    const scopedSelectedActs = selectedActsFinal.filter((act) => scopeConstrainedNregSet.has(act.rada_nreg));
    const hadOutOfScopeActs = scopedSelectedActs.length !== selectedActsFinal.length;
    if (hadOutOfScopeActs) {
      selectedActsFinal = scopedSelectedActs;
      if (scopeConstraintCode) pushUnique(reasonCodes, scopeConstraintCode);
    }
    if (selectedActsFinal.length === 0) {
      const scopeNreg = [...scopeConstrainedNregSet][0];
      const evidence = chunksEvidenceTopActs.find((item) => item.rada_nreg === scopeNreg);
      const scopeCandidate = actCandidatesTopHydrated.find((item) => item.rada_nreg === scopeNreg);
      const runnerUpCandidate = actCandidatesTopHydrated.find((item) => item.rada_nreg !== scopeNreg);
      const metadataGroundedScopeCandidate =
        scopeCandidate?.reasons?.some((reasonCode) => metadataGroundingReasonCodes.has(reasonCode)) ?? false;
      const dominantMetadataGroundedScopeCandidate =
        metadataGroundedScopeCandidate &&
        (scopeCandidate?.score ?? 0) >= ((runnerUpCandidate?.score ?? 0) + 2);
      const recoverableScopedTaxonomy =
        scopeCandidate?.rada_nreg === scopeNreg &&
        explicitActScopeCueQuery &&
        (exactSingleActConverged || groundedSingleActConverged || dominantMetadataGroundedScopeCandidate) &&
        (scopeCandidate?.score ?? 0) >= Math.max(3, (runnerUpCandidate?.score ?? 0) + 1.5);
      const recoverableScopedEvidence =
        evidence != null &&
        (
          evidence.best_rank_in_top30 <= 8 ||
          (
            explicitIdentifierScopedQuery &&
            evidence.best_rank_in_top30 <= 30 &&
            (evidence.max_ordering_score ?? 0) >= 0.25
          ) ||
          (
            (groundedSingleActConverged || metadataSingleActConverged) &&
            dominantMetadataGroundedScopeCandidate &&
            evidence.best_rank_in_top30 <= 15 &&
            (evidence.max_ordering_score ?? 0) >= 0.33
          )
        );
      if (recoverableScopedEvidence && evidence) {
        const meta =
          scopeCandidate?.title && scopeCandidate.document_type !== undefined && scopeCandidate.category !== undefined
            ? null
            : await getActMeta(scopeNreg);
        const actTitle = scopeCandidate?.title ?? meta?.title ?? scopeNreg;
        selectedActsFinal = [
          {
            rada_nreg: scopeNreg,
            act_title: actTitle,
            score: evidence.max_ordering_score || scopeCandidate?.score,
            why_selected: `scope_recovery best_rank=${evidence.best_rank_in_top30} max_score=${evidence.max_ordering_score.toFixed(2)}`,
            reason_tag: 'CHUNKS_EVIDENCE',
            source_tags: uniqueStrings(['CHUNKS_EVIDENCE', ...(scopeRecoveredCode ? [scopeRecoveredCode] : [])]),
            document_type: scopeCandidate?.document_type ?? meta?.document_type ?? null,
            category: scopeCandidate?.category ?? meta?.category ?? null,
            storage_category: meta?.storage_category ?? null,
            act_kind: classifyActKind(
              actTitle,
              scopeCandidate?.document_type ?? meta?.document_type ?? null,
              scopeCandidate?.category ?? meta?.category ?? null
            ),
            flags: {
              recovered: true,
              keep_one: false,
              draft: false,
              opinion: false,
            },
            confidence: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.6),
          },
        ];
        if (scopeRecoveredCode) pushUnique(reasonCodes, scopeRecoveredCode);
        selectedActsSourcesBreakdownFinal = {
          from_taxonomy: uniqueStrings([...selectedActsSourcesBreakdownFinal.from_taxonomy, scopeNreg]),
          from_acts_search: selectedActsSourcesBreakdownFinal.from_acts_search.filter(Boolean),
          from_chunks_evidence: uniqueStrings([...selectedActsSourcesBreakdownFinal.from_chunks_evidence, scopeNreg]),
          from_routing_hints: selectedActsSourcesBreakdownFinal.from_routing_hints?.filter(Boolean),
        };
      } else if (recoverableScopedTaxonomy && scopeCandidate) {
        const meta =
          scopeCandidate.title && scopeCandidate.document_type !== undefined && scopeCandidate.category !== undefined
            ? null
            : await getActMeta(scopeNreg);
        const actTitle = scopeCandidate.title ?? meta?.title ?? scopeNreg;
        selectedActsFinal = [
          {
            rada_nreg: scopeNreg,
            act_title: actTitle,
            score: scopeCandidate.score,
            why_selected: `scope_grounding candidate_score=${(scopeCandidate.score ?? 0).toFixed(2)}`,
            reason_tag: 'TAXONOMY',
            source_tags: uniqueStrings(['TAXONOMY', 'EMPTY_RECOVERED', ...(scopeRecoveredCode ? [scopeRecoveredCode] : [])]),
            document_type: scopeCandidate.document_type ?? meta?.document_type ?? null,
            category: scopeCandidate.category ?? meta?.category ?? null,
            storage_category: meta?.storage_category ?? null,
            act_kind: classifyActKind(
              actTitle,
              scopeCandidate.document_type ?? meta?.document_type ?? null,
              scopeCandidate.category ?? meta?.category ?? null
            ),
            flags: {
              recovered: true,
              keep_one: false,
              draft: false,
              opinion: false,
            },
            confidence: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.45),
          },
        ];
        pushUnique(reasonCodes, 'EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY');
        if (scopeRecoveredCode) pushUnique(reasonCodes, scopeRecoveredCode);
        selectedActsSourcesBreakdownFinal = {
          from_taxonomy: uniqueStrings([...selectedActsSourcesBreakdownFinal.from_taxonomy, scopeNreg]),
          from_acts_search: selectedActsSourcesBreakdownFinal.from_acts_search.filter(Boolean),
          from_chunks_evidence: selectedActsSourcesBreakdownFinal.from_chunks_evidence.filter(Boolean),
          from_routing_hints: selectedActsSourcesBreakdownFinal.from_routing_hints?.filter(Boolean),
        };
      }
    }
    if (hadOutOfScopeActs || selectedActsFinal.length > 0) {
      const summary = summarizeSelectedActs(selectedActsFinal as SelectedActOutput[]);
      selectedActsFinalMeta = {
        ...selectedActsFinalMeta,
        selected_acts_final: selectedActsFinal as SelectedActOutput[],
        selected_acts_confidence_final:
          selectedActsFinal.length > 0
            ? Math.max(
                selectedActsFinalMeta.selected_acts_confidence_final,
                reasonCodes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY') ? 0.45 : 0.6
              )
            : Math.min(selectedActsFinalMeta.selected_acts_confidence_final, 0.5),
        selected_acts_decision_final: {
          ...selectedActsFinalMeta.selected_acts_decision_final,
          reason_codes: uniqueStrings([
            ...(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? []),
            ...(scopeConstraintCode ? [scopeConstraintCode] : []),
            ...(selectedActsFinal.length > 0 && scopeRecoveredCode ? [scopeRecoveredCode] : []),
          ]),
        },
        selected_acts_kinds_count_final: summary.selected_acts_kinds_count,
        selected_acts_document_types_top_final: summary.selected_acts_document_types_top,
      };
    }
  }

  const finalSelectedActNregs = new Set(selectedActsFinal.map((act) => act.rada_nreg).filter(Boolean));
  selectedActsSourcesBreakdownFinal = {
    from_taxonomy: selectedActsSourcesBreakdownFinal.from_taxonomy.filter((radaNreg) =>
      finalSelectedActNregs.has(radaNreg)
    ),
    from_acts_search: selectedActsSourcesBreakdownFinal.from_acts_search.filter((radaNreg) =>
      finalSelectedActNregs.has(radaNreg)
    ),
    from_chunks_evidence: selectedActsSourcesBreakdownFinal.from_chunks_evidence.filter((radaNreg) =>
      finalSelectedActNregs.has(radaNreg)
    ),
    from_routing_hints: selectedActsSourcesBreakdownFinal.from_routing_hints?.filter((radaNreg) =>
      finalSelectedActNregs.has(radaNreg)
    ),
  };

  return {
    selectedActsFinal,
    selectedActsSourcesBreakdownFinal,
    selectedActsFinalMeta,
    reasonCodes,
    exactActNregSet,
    exactSingleActConverged,
    groundedActNregSet,
    groundedSingleActConverged,
    explicitActScopeCueQuery,
    metadataSingleActConverged,
    topActCandidate,
  };
}
