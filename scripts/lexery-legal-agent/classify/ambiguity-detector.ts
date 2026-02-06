/**
 * [U2d] Ambiguity Detector — heuristics (LEX-86).
 * Returns strength: "hard" (override LLM: AMBIG_TERMS, too-short) | "soft" (merge/OR).
 */
import type { AmbiguityResult, AmbiguityReasonCode, LegalDomain, ExtractedEntity } from './types.js';

const AMBIG_TERMS = [
  'мобілізація', 'поліція', 'права', 'обов\'язки', 'відповідальність',
  'мобилизация', 'полиция', 'права', 'обязанности',
];

export function detectAmbiguity(
  query: string,
  domain: LegalDomain,
  entities: ExtractedEntity[]
): AmbiguityResult {
  const reasons: string[] = [];
  const reason_codes: AmbiguityReasonCode[] = [];
  const ambig_terms: string[] = [];
  const q = query.trim().toLowerCase().normalize('NFC');

  const hasEntities = entities.length > 0;
  const hasDirectRef = entities.some((e) => e.type === 'article_ref' || e.type === 'act_abbrev');

  if (!hasEntities && q.length < 30) {
    reasons.push('no_entities_short_query');
    reason_codes.push('TOO_SHORT_QUERY');
  }

  if (domain === 'general' && !hasDirectRef && q.length > 10) {
    reasons.push('general_domain_no_direct_ref');
    reason_codes.push('GENERAL_DOMAIN_NO_DIRECT_REF');
  }

  for (const term of AMBIG_TERMS) {
    if (q.includes(term.toLowerCase().normalize('NFC'))) {
      ambig_terms.push(term);
      reasons.push('ambiguous_term');
      if (!reason_codes.includes('AMBIG_TERM_MATCH')) reason_codes.push('AMBIG_TERM_MATCH');
      break;
    }
  }

  const is_ambiguous = reasons.length > 0;
  const hasHard = reason_codes.includes('AMBIG_TERM_MATCH') || reason_codes.includes('TOO_SHORT_QUERY');
  const strength: 'hard' | 'soft' = hasHard ? 'hard' : 'soft';

  return {
    is_ambiguous,
    reasons: [...new Set(reasons)],
    ambig_terms: ambig_terms.length ? ambig_terms : undefined,
    strength,
    reason_codes: reason_codes.length ? reason_codes : undefined,
  };
}
