/**
 * U3 Plan — Rules engine: "де шукати?" (LEX-112)
 * QueryProfile + RoutingFlags → SearchPlan (sources, thresholds, reason_codes).
 */
import type { SearchPlan, SearchPlanSources } from './types.js';
import type { QueryProfile, RoutingFlags } from '../classify/types.js';
import { config } from '../lib/config.js';

const PLAN_VERSION = 1;
const RULES_VERSION = 'u3-v1';

function hasDirectCitation(profile: QueryProfile | null): boolean {
  if (!profile?.computed_flags?.has_direct_citation) return false;
  return profile.entities?.some(
    (e) => e.type === 'article_ref' || e.type === 'act_abbrev'
  ) ?? false;
}

/** Structural legal cues only: article refs, act abbrevs, law titles, or computed has_direct_citation with those entity types. */
function hasStructuralLegalCues(profile: QueryProfile | null): boolean {
  if (!profile?.entities?.length) {
    return (profile?.computed_flags?.has_direct_citation === true) && hasDirectCitation(profile);
  }
  return profile.entities.some(
    (e) => e.type === 'article_ref' || e.type === 'act_abbrev' || e.type === 'law_title'
  ) || (profile.computed_flags?.has_direct_citation === true && hasDirectCitation(profile));
}

function isAmbiguousHard(profile: QueryProfile | null): boolean {
  if (!profile?.ambiguity?.is_ambiguous) return false;
  return profile.ambiguity.strength === 'hard'
    || (profile.ambiguity.reason_codes?.includes('TOO_SHORT_QUERY') ?? false);
}

/** Build SearchPlan from RunRecord query_profile + routing_flags. Degraded fallback when profile missing. */
export function buildSearchPlanFromProfile(
  queryProfile: QueryProfile | null,
  routingFlags: RoutingFlags | undefined
): { plan: SearchPlan; reason_codes: string[] } {
  const now = new Date().toISOString();
  const reasons: string[] = [];

  if (!queryProfile) {
    const plan: SearchPlan = {
      version: PLAN_VERSION,
      sources: {
        use_lldbi: true,
        use_memory: false,
        use_doclist: false,
        use_web: false,
      },
      thresholds: { top_k_chunks: 20, min_score: 0.5 },
      reason_codes: ['degraded_no_profile'],
      meta: { built_at: now, rules_version: RULES_VERSION },
    };
    return { plan, reason_codes: ['degraded_no_profile'] };
  }

  const hasCitation = hasDirectCitation(queryProfile);
  const ambiguousHard = isAmbiguousHard(queryProfile);
  const needDeep = routingFlags?.need_deep_retrieval === true;
  const inputLarge = routingFlags?.input_is_large === true;
  const hasAttachments = routingFlags?.has_attachments === true;
  const tableLike = routingFlags?.input_looks_like_table === true;
  const rawContextMode = routingFlags?.context_mode;
  const resolved = rawContextMode === 'law' || rawContextMode === 'memory' || rawContextMode === 'mixed';
  const allowsLegalExpansion = resolved && rawContextMode !== 'memory';

  const sources: SearchPlanSources = {
    use_lldbi: true,
    use_memory: false,
    use_doclist: false,
    use_web: false,
  };

  if (!resolved) {
    reasons.push('CONTEXT_MODE_UNRESOLVED');
    const structuralLegal = hasStructuralLegalCues(queryProfile);
    if (structuralLegal) {
      // Degraded legal fallback: allow LLDBI so structurally legal queries get retrieval; still degraded, not clean route.
      sources.use_lldbi = true;
      sources.use_memory = false;
      sources.use_doclist = false;
      sources.use_web = false;
      reasons.push('DEGRADED_STRUCTURAL_LEGAL_FALLBACK');
    } else {
      sources.use_lldbi = false;
      sources.use_memory = false;
      sources.use_doclist = false;
      sources.use_web = false;
    }
  } else {
    const contextMode = rawContextMode as 'law' | 'memory' | 'mixed';
    if (contextMode === 'memory') {
      sources.use_memory = true;
      sources.use_lldbi = false;
      sources.use_doclist = false;
      sources.use_web = false;
      reasons.push('memory_mode');
    } else if (contextMode === 'mixed') {
      sources.use_memory = true;
      sources.use_lldbi = true;
      reasons.push('mixed_mode');
    }
  }

  if (hasCitation) {
    reasons.push('direct_citation');
  }
  if (ambiguousHard) {
    if (allowsLegalExpansion && config.doclistEnabled) {
      sources.use_doclist = true;
    }
    reasons.push('ambiguity_hard');
  }
  if (needDeep) {
    if (allowsLegalExpansion && config.doclistEnabled) {
      sources.use_doclist = true;
    }
    reasons.push('need_deep_retrieval');
  }
  if (routingFlags?.need_web === true) {
    if (allowsLegalExpansion) {
      sources.use_web = true;
    }
    reasons.push('need_web');
  }

  const topKChunks = resolved && rawContextMode === 'mixed' ? config.mixedModeLawTopKChunks : 20;
  const plan: SearchPlan = {
    version: PLAN_VERSION,
    sources,
    thresholds: {
      top_k_chunks: topKChunks,
      top_k_acts: 10,
      min_score: 0.5,
      embedding_required: true,
    },
    reason_codes: reasons.length ? reasons : ['default_lldbi'],
    meta: {
      built_at: now,
      rules_version: RULES_VERSION,
      use_preview: inputLarge ?? undefined,
      assemble_attachments: hasAttachments ?? undefined,
      context_mode_status: resolved ? 'resolved' : 'unresolved',
      used_degraded_fallback: !resolved && reasons.includes('DEGRADED_STRUCTURAL_LEGAL_FALLBACK') ? true : undefined,
    },
  };

  return { plan, reason_codes: reasons };
}
