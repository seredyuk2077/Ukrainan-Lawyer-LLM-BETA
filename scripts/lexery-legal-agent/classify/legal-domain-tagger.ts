/**
 * [U2b] LegalDomainTagger — structural cues only (LEX-84)
 * Only act abbreviations and article-ref patterns. No broad topic words or lexical heuristics.
 */
import type { LegalDomain } from './types.js';

// Structural only: act abbrevs (ККУ, ЦКУ, ПКУ, …), article ref (ст. N). No "договір", "позов", "трудовий", etc.
const DOMAIN_RULES: { pattern: RegExp; domain: LegalDomain }[] = [
  { pattern: /(?:^|[\s\W])(ККУ|КК\s+України|КПК)(?:[\s\W]|$)/i, domain: 'criminal' },
  { pattern: /(?:^|[\s\W])ЄРДР(?:[\s\W]|$)/iu, domain: 'criminal' },
  { pattern: /(?:^|[\s\W])ЦКУ(?:[\s\W]|$)/i, domain: 'civil' },
  { pattern: /(?:^|[\s\W])КЗпП(?:[\s\W]|$)/i, domain: 'labor' },
  { pattern: /(?:^|[\s\W])ПКУ(?:[\s\W]|$)/i, domain: 'tax' },
  { pattern: /(?:^|[\s\W])КАС(?:[\s\W]|$)/i, domain: 'admin' },
];

export function tagLegalDomain(query: string): LegalDomain {
  const q = query.trim();
  if (!q) return 'general';

  for (const { pattern, domain } of DOMAIN_RULES) {
    if (pattern.test(q)) return domain;
  }

  return 'general';
}
