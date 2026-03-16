/**
 * Output validator for U10 (DEV RUN v14).
 * Checks: banned phrases, citation presence for crime_composition, article sprawl.
 * Returns pass + warnings; optional single repair step in consumer.
 */
import type { FocusSpec } from './focusSpec.js';

export interface ValidationResult {
  pass: boolean;
  warnings: string[];
  /** True when article ref count > 3 (caller may request compact answer with core norms only). */
  suggestCompact?: boolean;
}

const GROUNDING_STOPWORDS = new Set([
  'і', 'й', 'та', 'або', 'але', 'що', 'це', 'як', 'який', 'яка', 'яке', 'які',
  'про', 'у', 'в', 'на', 'за', 'до', 'від', 'чи', 'не', 'так', 'то', 'для', 'з',
  'із', 'зі', 'по', 'при', 'без', 'над', 'під', 'між', 'а',
  'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
  'were', 'be', 'been', 'by', 'at', 'as', 'an', 'a',
]);

const DOC_ABSENCE_PATTERNS = [
  /відсутн/i,
  /не\s+знайден/i,
  /не\s+виявлен/i,
  /не\s+містить/i,
];

const DOC_ONLY_LEGAL_RAG_PATTERNS = [
  /витяг(?:и)?\s+з\s+норм\s+законодавства/i,
  /норм(?:и|а)?\s+законодавств(?:а|о)?/i,
  /законодавств(?:о|а)?\s+не\s+було\s+надано/i,
  /правов(?:а|і)\s+норм/i,
  /внутрішнь(?:ої|я)\s+бази\s+lexery/i,
  /internal\s+legislation\s+database/i,
];

const LEGAL_NORM_SECTION_RE = /^\s*•?\s*норма(?:\s*\(.*?\))?\s*:/im;

function hasDocAbsencePattern(answerText: string): boolean {
  return DOC_ABSENCE_PATTERNS.some((re) => re.test(answerText));
}

function isDocsOnlyExpectedWithoutLaw(
  focusSpec: FocusSpec,
  options?: { lawCount?: number; docCount?: number }
): boolean {
  return focusSpec.taskType !== 'memory_recall' && focusSpec.maxLawSnippets === 0 && (options?.lawCount ?? 0) === 0;
}

function tokenizeGrounding(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => !GROUNDING_STOPWORDS.has(token))
    .filter((token) => token.length > 1 || /\d/.test(token));
}

/**
 * Count citation-like references (Unicode-safe): ст. N, ст N, стаття N, ч. N ст. M.
 * Longest pattern first so "ч. 1 ст. 185" counts as one.
 */
export function countArticleRefs(text: string): number {
  const re = /(ч\.\s*\d+\s*ст\.?\s*\d+)|(ст\.?\s*\d+)|(стаття\s*\d+)/gi;
  let count = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    count += 1;
  }
  return count;
}

/** DEV RUN v18: universal citation presence — answer should cite article when referring to norms. */
function checkCitationPresence(answerText: string): string[] {
  const w: string[] = [];
  const hasArticleRef = countArticleRefs(answerText) > 0;
  if (!hasArticleRef && answerText.length > 100) {
    w.push('missing_citation');
  }
  const hasPartRef = /ч\.\s*\d+/i.test(answerText);
  if (hasPartRef && !hasArticleRef) {
    w.push('ch_without_st');
  }
  return w;
}

/**
 * One cheap bounded repair for memory recall: remove or shorten gratuitous legal citation phrases.
 * Does not call LLM. Max replacements to avoid destroying the answer.
 */
export function stripGratuitousLegalCitation(answerText: string, maxReplacements = 5): string {
  let out = answerText;
  const patterns: Array<[RegExp, string]> = [
    [/\s*Закон\s+України[^.]*\./gi, ''],
    [/\s*відповідно\s+до\s+ст\.?\s*\d+[^.]*\./gi, ''],
    [/\s*ст\.?\s*\d+(?:\s*,\s*ч\.?\s*\d+)?[^.]*\./g, ''],
    [/\s*стаття\s*\d+[^.]*\./gi, ''],
  ];
  let n = 0;
  for (const [re, repl] of patterns) {
    if (n >= maxReplacements) break;
    const next = out.replace(re, repl);
    if (next !== out) n++;
    out = next;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function sanitizeUnsupportedDocAbsenceAnswer(params: {
  answerText: string;
  queryText: string;
  evidenceTexts: string[];
  docCount: number;
}): string {
  if (params.docCount > 0) return params.answerText;
  if (!hasDocAbsencePattern(params.answerText)) return params.answerText;

  const evidenceTokens = new Set(tokenizeGrounding(params.evidenceTexts.join(' ')));
  const queryTokens = Array.from(new Set(tokenizeGrounding(params.queryText)));
  const answerTokens = new Set(tokenizeGrounding(params.answerText));
  const echoedUnsupported = queryTokens.filter((token) => !evidenceTokens.has(token) && answerTokens.has(token));
  if (echoedUnsupported.length === 0) return params.answerText;

  return 'У доступних документах підтвердження не знайдено. Уточніть документ або джерело.';
}

export function sanitizeDocsOnlyNoEvidenceAnswer(params: {
  answerText: string;
  focusSpec: FocusSpec;
  lawCount?: number;
  docCount?: number;
}): string {
  if (!isDocsOnlyExpectedWithoutLaw(params.focusSpec, { lawCount: params.lawCount, docCount: params.docCount })) {
    return params.answerText;
  }
  if ((params.docCount ?? 0) > 0) return params.answerText;

  const hasUnsupportedLegalFraming =
    countArticleRefs(params.answerText) > 0 ||
    LEGAL_NORM_SECTION_RE.test(params.answerText) ||
    DOC_ONLY_LEGAL_RAG_PATTERNS.some((re) => re.test(params.answerText));
  if (!hasUnsupportedLegalFraming) return params.answerText;

  return 'У доступних документах за цим запитом підтвердження не знайдено. Уточніть документ, чат або проєкт.';
}

export function hasFalseDocAbsenceClaim(params: {
  answerText: string;
  queryText: string;
  evidenceTexts: string[];
  docCount: number;
}): boolean {
  if (params.docCount <= 0) return false;
  if (!hasDocAbsencePattern(params.answerText)) return false;

  const queryTokens = Array.from(new Set(tokenizeGrounding(params.queryText)));
  if (queryTokens.length === 0) return false;
  const evidenceTokens = new Set(tokenizeGrounding(params.evidenceTexts.join(' ')));
  const supportedOverlap = queryTokens.filter((token) => evidenceTokens.has(token));
  const minOverlap = queryTokens.length === 1 ? 1 : 2;
  if (supportedOverlap.length >= minOverlap) return true;
  return supportedOverlap.some((token) => token.length >= 6);
}

/** Phrases that must not appear when history/memory context was provided (memory recall guard). */
const MEMORY_DENIAL_PATTERNS = [
  /не\s+можу\s+пам'ятати\s+попередні\s+запити/i,
  /не\s+маю\s+доступу\s+до\s+попередніх\s+запитів/i,
  /не\s+бачу\s+історію\s+діалогу/i,
];

/**
 * Validate LLM answer against focus spec.
 * Fail if: banned phrase present; crime_composition missing citation/structure; too many article refs.
 * When historyCount>0 or memoryCount>0: forbid "не можу пам'ятати попередні запити" (memory denial guard).
 * When memory_recall and lawCount=0: flag gratuitous legal citation (ст. N etc).
 * DEV RUN v18: always run universal citation checks (missing_citation, ch_without_st).
 */
export function validateOutput(
  answerText: string,
  focusSpec: FocusSpec,
  options?: { historyCount?: number; memoryCount?: number; lawCount?: number; docCount?: number }
): ValidationResult {
  const warnings: string[] = [];
  const lower = answerText.toLowerCase();

  const hasHistoryOrMemory = (options?.historyCount ?? 0) > 0 || (options?.memoryCount ?? 0) > 0;
  if (hasHistoryOrMemory) {
    for (const re of MEMORY_DENIAL_PATTERNS) {
      if (re.test(answerText)) {
        warnings.push('memory_denial_with_context');
        break;
      }
    }
  }

  // Pure memory recall with no law context: legal citation is gratuitous unless user asked for law (cheap fallback only)
  if (focusSpec.taskType === 'memory_recall' && (options?.lawCount ?? 0) === 0 && countArticleRefs(answerText) > 0) {
    warnings.push('gratuitous_legal_citation_in_memory_mode');
  }

  // User-document answers with no law evidence must not fabricate statutes/codes/articles.
  if (isDocsOnlyExpectedWithoutLaw(focusSpec, options)) {
    if (countArticleRefs(answerText) > 0) {
      warnings.push('gratuitous_legal_citation_without_law_evidence');
    }
    if (LEGAL_NORM_SECTION_RE.test(answerText)) {
      warnings.push('legal_norm_section_without_law_evidence');
    }
    if (DOC_ONLY_LEGAL_RAG_PATTERNS.some((re) => re.test(answerText))) {
      warnings.push('legal_rag_framing_without_law_evidence');
    }
  }

  // Citation presence (missing_citation etc) only when answer is expected to cite law
  const expectLawCitation = focusSpec.taskType !== 'memory_recall' && (options?.lawCount ?? 0) > 0;
  if (expectLawCitation) {
    warnings.push(...checkCitationPresence(answerText));
  }

  for (const phrase of focusSpec.bannedPhrases) {
    if (lower.includes(phrase.toLowerCase())) {
      warnings.push(`banned_phrase: "${phrase}"`);
    }
  }

  if (focusSpec.taskType === 'crime_composition') {
    if (focusSpec.primaryNormSourceId && focusSpec.primaryNormConfidence === 'high') {
      const hasCitation = countArticleRefs(answerText) > 0;
      if (!hasCitation) {
        warnings.push('crime_composition: expected citation of primary norm (article/part ref)');
      }
    }
    const hasComposition = /склад\s+злочину|об\'єкт|об\'єктивна\s+сторона|суб\'єкт|суб\'єктивна\s+сторона/i.test(answerText);
    if (!hasComposition) {
      warnings.push('crime_composition: expected "Склад злочину" or 4 elements');
    }
  }

  const articleCount = countArticleRefs(answerText);
  const sprawlThreshold = 3;
  if (articleCount > sprawlThreshold) {
    warnings.push(`article_sprawl: ${articleCount} "ст." refs (prefer ≤${sprawlThreshold} for focused answer)`);
  }

  return {
    pass: warnings.length === 0,
    warnings,
    suggestCompact: articleCount > sprawlThreshold,
  };
}
