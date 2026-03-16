/**
 * [U2d] Ambiguity Detector — structure-first ambiguity checks (LEX-86).
 * Returns strength: "hard" only for clearly underspecified short queries; otherwise "soft".
 */
import type { AmbiguityResult, AmbiguityReasonCode, LegalDomain, ExtractedEntity } from './types.js';

export function detectAmbiguity(
  query: string,
  domain: LegalDomain,
  entities: ExtractedEntity[]
): AmbiguityResult {
  const reasons: string[] = [];
  const reason_codes: AmbiguityReasonCode[] = [];
  const ambig_terms: string[] = [];
  const q = query.trim().toLowerCase().normalize('NFC');
  const HARD_SHORT_QUERY_MAX_CHARS = 18;
  const tokenCount = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;

  const hasEntities = entities.length > 0;
  const hasDirectRef = entities.some((e) => e.type === 'article_ref' || e.type === 'act_abbrev');
  const hasConcreteDomain = domain !== 'general';

  // Hard ambiguity is reserved for genuinely underspecified very short queries.
  // Short but concrete domain-specific legal queries should not be pushed into
  // the expensive ambiguity/deep-retrieval path just because they lack entities.
  if (!hasEntities && !hasDirectRef && !hasConcreteDomain && q.length < HARD_SHORT_QUERY_MAX_CHARS && tokenCount <= 3) {
    reasons.push('no_entities_short_query');
    reason_codes.push('TOO_SHORT_QUERY');
  }

  if (domain === 'general' && !hasDirectRef && q.length > 10) {
    reasons.push('general_domain_no_direct_ref');
    reason_codes.push('GENERAL_DOMAIN_NO_DIRECT_REF');
  }

  const is_ambiguous = reasons.length > 0;
  const hasHard = reason_codes.includes('TOO_SHORT_QUERY');
  const strength: 'hard' | 'soft' = hasHard ? 'hard' : 'soft';

  return {
    is_ambiguous,
    reasons: [...new Set(reasons)],
    ambig_terms: ambig_terms.length ? ambig_terms : undefined,
    strength,
    reason_codes: reason_codes.length ? reason_codes : undefined,
  };
}
