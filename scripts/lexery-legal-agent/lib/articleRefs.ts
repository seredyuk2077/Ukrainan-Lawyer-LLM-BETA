/**
 * Article reference extraction V2 (U4 backfill, U9 selection).
 * Strong refs only when legal context present; normalized_forms for 332-2 vs 3322 matching.
 */

export interface ArticleRefStructured {
  raw_ref: string;
  /** Dashed form + compact (no hyphen) for DB/payload matching. */
  normalized_forms: string[];
  signal_strength: 'strong' | 'weak';
  evidence: string;
}

function normalizedFormsForRef(raw: string): string[] {
  const forms = new Set<string>();
  const t = raw.trim();
  forms.add(t);
  const dash = t.match(/^(\d{1,5})-(\d{1,3})$/);
  if (dash) {
    forms.add(dash[1]! + dash[2]!);
  }
  return [...forms];
}

/** Tokens that invalidate list context (age/year/days). Unicode-safe: no \\b (Cyrillic not word char in JS). */
const LIST_CONTEXT_INVALIDATING = /(?:^|[\s,;.])(років|рік|року|днів|дні|мені)(?:[\s,;.]|$)/iu;
/** After number: age/year/days context => not article. Match word then boundary (space/punct/end). */
const AFTER_NUMBER_AGE_YEAR = /^[\s,;.\-–]*(рік|років|року|днів|дні)(?:[\s,;.]|$)/iu;

/** Act/number pattern like №57-95-п: do not treat 57 or 95 as article ref. */
function isInsideActNumberPattern(query: string, start: number, end: number): boolean {
  const before = query.slice(Math.max(0, start - 25), start);
  const after = query.slice(end, Math.min(query.length, end + 15));
  // № at end of before => we're first number in №X-Y-...
  if (/№\s*$/i.test(before)) return true;
  // digits-dash at end of before => we're second number in №57-95-п
  if (/№\d+\s*-\s*$/i.test(before)) return true;
  return false;
}

function hasLegalContext(query: string, start: number, end: number): { strong: boolean; evidence: string } {
  const before = query.slice(Math.max(0, start - 50), start);
  const after = query.slice(end, Math.min(query.length, end + 30));

  if (isInsideActNumberPattern(query, start, end)) {
    return { strong: false, evidence: 'act_number_pattern' };
  }
  if (AFTER_NUMBER_AGE_YEAR.test(after)) {
    return { strong: false, evidence: 'bare_number' };
  }

  // Suffix-of-before only: longer prefixes first so "статті" is not consumed by "ст". Optional dot for "ст 185".
  if (/(стаття|статті|ст\.?|article|art\.?|§)\s*$/i.test(before)) {
    return { strong: true, evidence: 'legal_prefix' };
  }

  // List context: segment from *last* legal prefix to number must be list-only (no "років", "рік", "дні")
  const legalPrefixRe = /(стаття|статті|ст\.?|article|art\.?|§)/gi;
  let lastPrefixEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = legalPrefixRe.exec(before)) !== null) {
    lastPrefixEnd = match.index + match[0].length;
  }
  if (lastPrefixEnd >= 0) {
    const segment = before.slice(lastPrefixEnd);
    if (LIST_CONTEXT_INVALIDATING.test(segment)) return { strong: false, evidence: 'bare_number' };
    if (/^[\s,\d\-–]*(та|і|або)?[\s,\d\-–]*\s*$/i.test(segment)) return { strong: true, evidence: 'legal_list' };
  }

  if (/^\s*[\d,\s\-–]*\s*(ККУ|КК\s+України|КПК|КУпАП|ЦК|ГК|ПКУ|КЗпП|КАС|ПК\b|Кодекс)/i.test(after)) {
    return { strong: true, evidence: 'legal_suffix' };
  }
  return { strong: false, evidence: 'bare_number' };
}

/**
 * Extract structured article refs with strong/weak and normalized forms.
 * Strong = legal context (ст./стаття/article/§ or number before act alias). Weak = bare numbers.
 */
export function extractArticleRefsStructured(query: string): ArticleRefStructured[] {
  const seen = new Set<string>();
  const out: ArticleRefStructured[] = [];

  const collect = (raw: string, strong: boolean, evidence: string) => {
    const key = raw.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      raw_ref: key,
      normalized_forms: normalizedFormsForRef(key),
      signal_strength: strong ? 'strong' : 'weak',
      evidence,
    });
  };

  const reDashed = /\b(\d{1,5})-(\d{1,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = reDashed.exec(query)) !== null) {
    const raw = `${m[1]!}-${m[2]!}`;
    const { strong, evidence } = hasLegalContext(query, m.index, m.index + m[0].length);
    collect(raw, strong, evidence);
  }

  const reSimple = /(?<!\d-)\b(\d{1,5})\b(?!-\d{1,3}\b)/g;
  while ((m = reSimple.exec(query)) !== null) {
    const raw = m[1]!;
    if (seen.has(raw)) continue;
    const { strong, evidence } = hasLegalContext(query, m.index, m.index + m[0].length);
    collect(raw, strong, evidence);
  }

  return out;
}

/** All normalized forms (dashed + compact) for strong refs only. Used for U9 queryNum and U4 backfill. */
export function getStrongArticleRefsNormalized(query: string): Set<string> {
  const set = new Set<string>();
  for (const r of extractArticleRefsStructured(query)) {
    if (r.signal_strength === 'strong') {
      for (const n of r.normalized_forms) set.add(n);
    }
  }
  return set;
}

/**
 * Backward compat: returns Set of raw ref strings only (strong refs). Size = number of distinct refs.
 * For matching hit.article_number in normalized space use getStrongArticleRefsNormalized.
 */
export function extractArticleNumbersFromQuery(query: string): Set<string> {
  const set = new Set<string>();
  for (const r of extractArticleRefsStructured(query)) {
    if (r.signal_strength === 'strong') set.add(r.raw_ref);
  }
  return set;
}
