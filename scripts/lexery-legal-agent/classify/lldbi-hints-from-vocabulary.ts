/**
 * U2 — derived lldbi hints on rules/degraded path (data-driven from LLDBI vocabulary).
 * Ніяких хардкод-списків категорій/типів: тільки vocabulary + підбор за запитом/domain.
 */
import type { LldbiVocabularyResult } from '../retrieval/lldbi-vocabulary.js'; // from scripts/lexery-legal-agent/classify -> ../retrieval

const MIN_DOC_TYPE_SCORE = 0.2;
const MIN_CATEGORY_SCORE = 0.3;
const TOP_DOC_TYPES = 3;
const TOP_CATEGORIES = 3;

/** Загальні стоп-слова для токенізації doc_type (не доменний словник). */
const DOC_TYPE_STOP = new Set(
  ['україни', 'україна', 'кму', 'президента', 'верховної', 'ради', 'кабінету', 'міністрів', 'європейського', 'парламенту', 'суду', 'судді'].map((s) =>
    s.normalize('NFC').toLowerCase()
  )
);

function toKey(s: string): string {
  return (s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string, stopWords?: Set<string>): string[] {
  const key = toKey(text);
  const tokens = key.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  if (!stopWords) return [...new Set(tokens)];
  return [...new Set(tokens.filter((t) => !stopWords.has(t)))];
}

/** Редакційна відстань (Левенштейн) для fuzzy match — універсально для будь-якого ключа. */
function editSimilarity(a: string, b: string): number {
  const sa = toKey(a);
  const sb = toKey(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const n = sa.length;
  const m = sb.length;
  const d: number[][] = Array(n + 1)
    .fill(0)
    .map(() => Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  const maxLen = Math.max(n, m, 1);
  return 1 - d[n][m] / maxLen;
}

export interface DerivedLldbiHintsInput {
  queryText: string;
  domainHint?: string | null;
  legalDomain?: string | null;
  heuristicConfidence: number;
  vocabulary: LldbiVocabularyResult;
}

export interface DerivedLldbiHintsResult {
  categories_ranked_top3: string[];
  document_types_ranked_top3: string[];
  routing_confidence: number;
  routing_source: 'heuristic';
  meta: {
    derived: true;
    reasons: string[];
  };
}

/** Map LegalDomain (U2 tagLegalDomain) to taxonomy category key for U4 domainHint + vocabulary match. */
export function legalDomainToTaxonomyKey(domain: string): string | null {
  const d = domain.trim().toLowerCase();
  if (d === 'criminal') return 'criminal';
  if (d === 'civil') return 'civil';
  if (d === 'labor') return 'labor_social';
  if (d === 'admin') return 'administrative';
  if (d === 'tax') return 'tax_customs';
  if (d === 'health') return 'healthcare';
  if (d === 'corporate') return 'business_corporate';
  if (d === 'education') return 'education_science';
  return null;
}

/**
 * Похідні document_types з vocabulary: token overlap + substring з запиту.
 * Повністю data-driven; нові типи в vocabulary автоматично враховуються.
 */
function rankDocumentTypes(
  queryText: string,
  documentTypes: string[],
  reasons: string[]
): { value: string; score: number }[] {
  const qTokens = tokenize(queryText);
  const qKey = toKey(queryText);
  if (!qKey && !qTokens.length) return [];

  const scored: { value: string; score: number }[] = [];
  for (const dt of documentTypes) {
    if (!dt || !dt.trim()) continue;
    const dtTokens = tokenize(dt, DOC_TYPE_STOP);
    let score = 0;
    // Token overlap (нормалізований)
    let overlap = 0;
    for (const t of dtTokens) {
      if (qTokens.includes(t)) overlap += 1;
      else if (qKey.includes(t) || qTokens.some((qt) => t.includes(qt) || qt.includes(t))) overlap += 0.5;
    }
    if (dtTokens.length > 0) score += (overlap / Math.max(dtTokens.length, qTokens.length)) * 0.8;
    // Substring: запит містить ключовий корінь doc_type
    const dtKey = toKey(dt);
    if (qKey.includes(dtKey) || dtKey.includes(qKey)) score += 0.5;
    else if (dtKey.length >= 4 && qKey.includes(dtKey.slice(0, 4))) score += 0.2;

    if (score >= MIN_DOC_TYPE_SCORE) {
      scored.push({ value: dt, score });
      if (overlap > 0 || score >= 0.4) reasons.push(`doc_type:${dt.slice(0, 30)}`);
    }
  }
  scored.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
  return scored.slice(0, TOP_DOC_TYPES);
}

/**
 * Похідні categories: спочатку domainHint → vocabulary.categories (exact/prefix/fuzzy),
 * потім legalDomain → taxonomy key → vocabulary. Без фіксованих пар "admin→administrative".
 */
function rankCategories(
  domainHint: string | null | undefined,
  legalDomain: string | null | undefined,
  categories: string[],
  reasons: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (c: string) => {
    const k = toKey(c);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };

  // 1) domainHint: спочатку exact/prefix, потім fuzzy — щоб "criminal" не замінявся на "civil" через схожість
  if (domainHint && domainHint.trim()) {
    const hintKey = toKey(domainHint).replace(/\s+/g, '_');
    for (const cat of categories) {
      const cKey = toKey(cat).replace(/\s+/g, '_');
      if (cKey === hintKey) {
        add(cat);
        reasons.push('HAS_DOMAIN_MATCH');
        break;
      }
      if (cKey.startsWith(hintKey) || hintKey.startsWith(cKey)) {
        add(cat);
        reasons.push('HAS_DOMAIN_PREFIX');
        break;
      }
    }
    if (out.length === 0) {
      for (const cat of categories) {
        const cKey = toKey(cat).replace(/\s+/g, '_');
        if (editSimilarity(hintKey, cKey) >= MIN_CATEGORY_SCORE) {
          add(cat);
          reasons.push('HAS_DOMAIN_FUZZY');
          break;
        }
      }
    }
  }

  // 2) legalDomain → taxonomy key → vocabulary: exact спочатку, потім fuzzy
  const taxonomyKey = legalDomain ? legalDomainToTaxonomyKey(legalDomain) : null;
  if (taxonomyKey && out.length < TOP_CATEGORIES) {
    for (const cat of categories) {
      const cKey = toKey(cat).replace(/\s+/g, '_');
      if (cKey === taxonomyKey) {
        add(cat);
        if (!reasons.includes('HAS_DOMAIN_MATCH') && !reasons.includes('HAS_LEGAL_DOMAIN')) reasons.push('HAS_LEGAL_DOMAIN');
        break;
      }
    }
    if (out.length === 0 || (taxonomyKey && !seen.has(toKey(taxonomyKey)))) {
      for (const cat of categories) {
        const cKey = toKey(cat).replace(/\s+/g, '_');
        if (editSimilarity(taxonomyKey!, cKey) >= MIN_CATEGORY_SCORE) {
          add(cat);
          if (!reasons.includes('HAS_DOMAIN_MATCH') && !reasons.includes('HAS_LEGAL_DOMAIN')) reasons.push('HAS_LEGAL_DOMAIN');
          break;
        }
      }
    }
  }

  return out.slice(0, TOP_CATEGORIES);
}

/**
 * Виводить lldbi hints з vocabulary для rules/degraded path.
 * Вхід: query, optional domainHint/legalDomain, confidence, vocabulary.
 * Вихід: categories_ranked_top3, document_types_ranked_top3, routing_confidence, routing_source, meta.
 */
export function deriveLldbiHintsFromVocabulary(input: DerivedLldbiHintsInput): DerivedLldbiHintsResult {
  const { queryText, domainHint, legalDomain, heuristicConfidence, vocabulary } = input;
  const reasons: string[] = [];

  if (!vocabulary.documentTypes?.length && !vocabulary.categories?.length) {
    return {
      categories_ranked_top3: [],
      document_types_ranked_top3: [],
      routing_confidence: heuristicConfidence,
      routing_source: 'heuristic',
      meta: { derived: true, reasons: ['NO_VOCABULARY'] },
    };
  }

  const document_types_ranked_top3 = rankDocumentTypes(
    queryText,
    vocabulary.documentTypes ?? [],
    reasons
  ).map((x) => x.value);

  const categories_ranked_top3 = rankCategories(
    domainHint,
    legalDomain,
    vocabulary.categories ?? [],
    reasons
  );

  if (reasons.length === 0 && document_types_ranked_top3.length === 0 && categories_ranked_top3.length === 0) {
    reasons.push('LOW_SCORE');
  }

  return {
    categories_ranked_top3,
    document_types_ranked_top3,
    routing_confidence: heuristicConfidence,
    routing_source: 'heuristic',
    meta: { derived: true, reasons },
  };
}
