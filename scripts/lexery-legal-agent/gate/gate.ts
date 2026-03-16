/**
 * U5 Gate — evaluateGate: retrieval_trace + query_profile + search_plan → expand decision (LEX-118)
 * DIRECT_REF_MISSING: article coverage by article_number (normalized); act coverage by act_title/r2_key, not rada_nreg.
 */
import type { GateDecision, GateDecisionReasonCode } from './types.js';
import type { RetrievalTrace, RawHit } from '../retrieval/types.js';
import type { QueryProfile } from '../classify/types.js';
import type { SearchPlan } from '../plan/types.js';
import { config } from '../lib/config.js';

/** Normalized forms for article number matching (332-2 vs 3322). No domain wordlists. */
function articleNormalizedForms(article: string): string[] {
  const t = article.trim();
  if (!t) return [];
  const forms = new Set<string>([t]);
  const dash = t.match(/^(\d{1,5})-(\d{1,3})$/);
  if (dash) forms.add(dash[1]! + dash[2]!);
  return [...forms];
}

function hitArticleNormalizedForms(h: RawHit): string[] {
  const an = h.article_number != null ? String(h.article_number).trim() : '';
  return an ? articleNormalizedForms(an) : [];
}

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
  const planUseLldbi = !!searchPlan?.sources?.use_lldbi;
  const legalRetrievalActive = planUseLldbi || planUseDoclist;

  // Direct ref coverage: article refs (normalized article_number) + act hints (act_title/r2_key), not rada_nreg vs act name
  let directRefsTotal = 0;
  let directRefsHit = 0;
  let directActHintsTotal = 0;
  let directActHintsHit = 0;
  if (hasDirectCitation && queryProfile?.entities?.length) {
    const entityArticleRefs = new Set<string>();
    const entityActHints = new Set<string>();
    for (const e of queryProfile.entities) {
      const art = e.norm?.article?.trim();
      if (art) {
        for (const n of articleNormalizedForms(art)) entityArticleRefs.add(n);
      }
      const actHint = (e.norm?.act ?? (e.type === 'act_abbrev' ? e.value : '')).trim().toLowerCase();
      if (actHint) entityActHints.add(actHint);
    }
    directRefsTotal = entityArticleRefs.size;
    directActHintsTotal = entityActHints.size;
    if (directRefsTotal > 0) {
      const hitArticleForms = new Set<string>();
      for (const h of rawHits) {
        for (const f of hitArticleNormalizedForms(h)) hitArticleForms.add(f);
      }
      for (const ref of entityArticleRefs) {
        if (hitArticleForms.has(ref)) directRefsHit++;
      }
    }
    if (directActHintsTotal > 0) {
      const hitActStrings = rawHits.map((h) => {
        const title = (h.title ?? (h as { act_title?: string }).act_title ?? '').trim().toLowerCase();
        const r2 = (h.r2_key ?? '').toLowerCase();
        return `${title} ${r2}`;
      });
      for (const hint of entityActHints) {
        if (hitActStrings.some((s) => s.includes(hint))) directActHintsHit++;
      }
    }
  }

  const signals = {
    hits_count: hitsCount,
    top_score: topScore,
    avg_score: avgScore,
    has_direct_citation: hasDirectCitation,
    ambiguous,
    degraded_lldbi: degradedLldbi,
    need_deep_retrieval: needDeepRetrieval,
    direct_refs_total: directRefsTotal > 0 ? directRefsTotal : undefined,
    direct_refs_hit: directRefsTotal > 0 ? directRefsHit : undefined,
    direct_act_hints_total: directActHintsTotal > 0 ? directActHintsTotal : undefined,
    direct_act_hints_hit: directActHintsTotal > 0 ? directActHintsHit : undefined,
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

  if (searchPlan && !legalRetrievalActive) {
    const duration = Date.now() - start;
    return {
      expand: false,
      reason_codes: ['OK'],
      thresholds: { min_hits: minHits, min_avg_score: minAvgScore },
      signals,
      meta: { decision_version: version, evaluated_at_ms: start, duration_ms: duration },
    };
  }

  // Only article-ref coverage drives DIRECT_REF_MISSING (act_title often lacks abbreviation e.g. ККУ)
  const directRefMissing =
    hasDirectCitation && directRefsTotal > 0 && directRefsHit < directRefsTotal;

  const weakEvidenceForExpand =
    degradedLldbi ||
    hitsCount < minHits ||
    (avgScore != null && avgScore < minAvgScore) ||
    directRefMissing;

  if (degradedLldbi) {
    reasons.push('DEGRADED_LLDBI');
  }
  if (hitsCount < minHits) {
    reasons.push('FEW_HITS');
  }
  if (avgScore != null && avgScore < minAvgScore) {
    reasons.push('LOW_SCORE');
  }
  // Ambiguity alone should not inflate already well-supported legal runs.
  if (ambiguous && planUseLldbi && weakEvidenceForExpand) {
    reasons.push('AMBIGUOUS_QUERY');
  }
  if (needDeepRetrieval && planUseLldbi) {
    reasons.push('NEED_DEEP_RETRIEVAL');
  }
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
