/**
 * U4 Query shaping — deterministic retrieval (NFC, whitespace, typo fix).
 * Anchors only from ActTaxonomyStore (data-driven); no hardcoded domain→act mapping.
 */

/** Universal typo fixes (extend via data file if needed). No domain-specific mappings. */
const TYPO_FIXES: Array<[RegExp, string]> = [
  [/вбиство/gi, 'вбивство'],
];

export interface ShapedQuery {
  shapedQuery: string;
  anchorsUsed: string[];
}

function normalizeNfcAndWhitespace(s: string): string {
  const nfc = typeof s.normalize === 'function' ? s.normalize('NFC') : s;
  return nfc.replace(/\s+/g, ' ').trim();
}

function applyTypoFixes(s: string): string {
  let out = s;
  for (const [re, replacement] of TYPO_FIXES) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Shape query for retrieval: NFC, whitespace, typo fix, optional anchor tokens from taxonomy only.
 * @param query - user query
 * @param domainHint - from query_profile.domain (unused for anchors; taxonomy uses it internally)
 * @param taxonomyAnchorTokens - from ActTaxonomyStore.getTaxonomyCandidates(...).anchor_tokens; if provided, appended to query
 */
export function shapeQueryForRetrieval(
  query: string,
  _domainHint?: string,
  taxonomyAnchorTokens?: string[]
): ShapedQuery {
  const normalized = normalizeNfcAndWhitespace(query);
  const withTypos = applyTypoFixes(normalized);
  const anchorsUsed: string[] = [];

  if (Array.isArray(taxonomyAnchorTokens) && taxonomyAnchorTokens.length > 0) {
    const unique = [...new Set(taxonomyAnchorTokens)].filter((t) => t && t.trim().length > 0);
    anchorsUsed.push(...unique.slice(0, 5));
  }

  const anchorSuffix = anchorsUsed.length > 0 ? ' ' + anchorsUsed.join(' ') : '';
  const shapedQuery = (withTypos + anchorSuffix).trim();

  return { shapedQuery, anchorsUsed };
}
