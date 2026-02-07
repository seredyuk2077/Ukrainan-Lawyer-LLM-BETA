/**
 * U5 Gate — evaluateGate: retrieval_trace + query_profile + search_plan → expand decision (LEX-118)
 */
import type { GateDecision, GateDecisionReasonCode } from './types.js';
import type { RetrievalTrace, RawHit } from '../retrieval/types.js';
import type { QueryProfile } from '../classify/types.js';
import type { SearchPlan } from '../plan/types.js';
import { config } from '../lib/config.js';

export interface EvaluateGateInput {
  retrievalTrace: RetrievalTrace | null;
  rawHits: RawHit[];
  queryProfile: QueryProfile | null;
  searchPlan: SearchPlan | null;
}

export function evaluateGate(input: EvaluateGateInput): GateDecision {
  const start = Date.now();
  const { retrievalTrace, rawHits, queryProfile, searchPlan } = input;
  const minHits = config.gateMinHitsThreshold;
  const minAvgScore = config.gateMinAvgScore;
  const version = config.gateDecisionVersion;

  const hitsCount = rawHits.length;
  const topScore = retrievalTrace?.top_score ?? (rawHits.length > 0 ? Math.max(...rawHits.map((h) => h.score)) : null);
  const avgScore =
    rawHits.length > 0
      ? rawHits.reduce((s, h) => s + h.score, 0) / rawHits.length
      : null;
  const degradedLldbi = !!retrievalTrace?.degraded_sources?.lldbi;
  const ambiguous = !!queryProfile?.ambiguity?.is_ambiguous;
  const needDeepRetrieval = !!queryProfile?.routing_flags?.need_deep_retrieval;
  const hasDirectCitation = !!queryProfile?.computed_flags?.has_direct_citation;
  const planUseDoclist = !!searchPlan?.sources?.use_doclist;

  const signals = {
    hits_count: hitsCount,
    top_score: topScore,
    avg_score: avgScore,
    has_direct_citation: hasDirectCitation,
    ambiguous,
    degraded_lldbi: degradedLldbi,
    need_deep_retrieval: needDeepRetrieval,
  };

  const reasons: GateDecisionReasonCode[] = [];

  if (config.forceExpand) {
    reasons.push('FORCE_EXPAND');
    const duration = Date.now() - start;
    return {
      expand: true,
      reason_codes: reasons,
      thresholds: { min_hits: minHits, min_avg_score: minAvgScore },
      signals,
      meta: { decision_version: version, evaluated_at_ms: start, duration_ms: duration },
    };
  }

  if (!config.doclistEnabled) {
    if (planUseDoclist) reasons.push('DOCLIST_DISABLED');
    const duration = Date.now() - start;
    return {
      expand: false,
      reason_codes: reasons.length ? reasons : ['OK'],
      thresholds: { min_hits: minHits, min_avg_score: minAvgScore },
      signals,
      meta: { decision_version: version, evaluated_at_ms: start, duration_ms: duration },
    };
  }

  if (degradedLldbi) {
    reasons.push('DEGRADED_LLDBI');
  }
  if (hitsCount < minHits) {
    reasons.push('FEW_HITS');
  }
  if (avgScore != null && avgScore < minAvgScore) {
    reasons.push('LOW_SCORE');
  }
  if (ambiguous) {
    reasons.push('AMBIGUOUS_QUERY');
  }
  if (needDeepRetrieval) {
    reasons.push('NEED_DEEP_RETRIEVAL');
  }

  const directRefMissing = hasDirectCitation && queryProfile?.entities?.length && !rawHits.some((h) => {
    const hitNreg = (h.rada_nreg ?? '').toLowerCase();
    for (const e of queryProfile!.entities) {
      const actNorm = (e.norm?.act ?? e.value ?? '').toLowerCase();
      if (actNorm && hitNreg && (hitNreg.includes(actNorm) || actNorm.includes(hitNreg))) return true;
    }
    return false;
  });
  if (directRefMissing) {
    reasons.push('DIRECT_REF_MISSING');
  }

  const expand = reasons.length > 0;
  if (!expand) {
    reasons.push('OK');
  }

  const duration = Date.now() - start;
  return {
    expand,
    reason_codes: reasons,
    thresholds: { min_hits: minHits, min_avg_score: minAvgScore },
    signals,
    meta: { decision_version: version, evaluated_at_ms: start, duration_ms: duration },
  };
}
