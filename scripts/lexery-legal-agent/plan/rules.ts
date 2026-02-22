/**
 * U3 Plan — Rules engine: "де шукати?" (LEX-112)
 * QueryProfile + RoutingFlags → SearchPlan (sources, thresholds, reason_codes).
 */
import type { SearchPlan, SearchPlanSources } from './types.js';
import type { QueryProfile, RoutingFlags } from '../classify/types.js';

const PLAN_VERSION = 1;
const RULES_VERSION = 'u3-v1';

function hasDirectCitation(profile: QueryProfile | null): boolean {
  if (!profile?.computed_flags?.has_direct_citation) return false;
  return profile.entities?.some(
    (e) => e.type === 'article_ref' || e.type === 'act_abbrev'
  ) ?? false;
}

function isAmbiguousHard(profile: QueryProfile | null): boolean {
  if (!profile?.ambiguity?.is_ambiguous) return false;
  return profile.ambiguity.strength === 'hard' || (profile.ambiguity.reason_codes?.length ?? 0) > 0;
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

  const sources: SearchPlanSources = {
    use_lldbi: true,
    use_memory: false,
    use_doclist: false,
    use_web: false,
  };

  if (hasCitation) {
    reasons.push('direct_citation');
  }
  if (ambiguousHard) {
    sources.use_doclist = true;
    reasons.push('ambiguity_hard');
  }
  if (needDeep) {
    sources.use_doclist = true;
    reasons.push('need_deep_retrieval');
  }
  if (routingFlags?.need_web === true) {
    sources.use_web = true;
    reasons.push('need_web');
  }

  const plan: SearchPlan = {
    version: PLAN_VERSION,
    sources,
    thresholds: {
      top_k_chunks: 20,
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
    },
  };

  return { plan, reason_codes: reasons };
}
