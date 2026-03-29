/**
 * U4 ActTaxonomyStore — runtime act candidates from LLDBI metadata.
 * Uses aliases, title, summary, keywords, topics, category/doc type, and validity from Supabase;
 * keeps retrieval read-only and tolerant when taxonomy data is unavailable.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../lib/config.js';
import {
  extractStructuredActIdentifiers,
  looksLikeStructuredActIdentifier,
  normalizeStructuredActIdentifier,
} from '../lib/structured-act-identifier.js';
export {
  extractStructuredActIdentifiers,
  looksLikeStructuredActIdentifier,
} from '../lib/structured-act-identifier.js';
import {
  incrementTaxonomyRefreshSuccess,
  incrementTaxonomyRefreshFailed,
  setTaxonomySnapshotAgeSeconds,
  addU4TaxonomyCategoryHintsUsed,
  addU4TaxonomyDocTypeHintsUsed,
  addU4TaxonomyHintsInjectedActs,
} from '../gateway/observability.js';
import { tolerantNormalizeToStrings } from './tolerant-normalizer.js';
import {
  extractInterrogativeActLocatorSignals,
  looksLikeCompactActTitleFragmentQuery,
} from './descriptive-act-title.js';

const LEGISLATION_TABLE = 'legislation_documents';
const MIN_TOKEN_LEN = 2;
const MIN_METADATA_TOKEN_LEN = 4;
const MAX_ANCHOR_TOKENS = 3;
const MAX_QUERY_PHRASE_WORDS = 4;
const TITLE_MATCH_BOOST = 1.4;
const SUMMARY_MATCH_BOOST = 0.45;
const KEYWORD_PHRASE_BOOST = 1.6;
const TOPIC_PHRASE_BOOST = 1.3;
const ALIAS_PHRASE_BOOST = 3;
const EXACT_IDENTIFIER_MATCH_BOOST = 8;
const TITLE_FRAGMENT_GROUNDED_BOOST = 3.6;
const VALIDITY_IN_FORCE_BOOST = 0.1;
const VALIDITY_STALE_PENALTY = 0.35;
const CATEGORY_HINT_SCORE_BOOST = 0.25;
const APPROX_REFERENCE_GROUNDING_BOOST = 2.6;
const APPROX_REFERENCE_MIN_SCORE = 3;
const APPROX_REFERENCE_MIN_MARGIN = 1;
const EXACT_TEXT_GROUNDING_MIN_MARGIN = 0.9;
const TITLE_FRAGMENT_GROUNDING_MIN_MARGIN = 1.1;
const TITLE_FRAGMENT_MIN_TOKENS = 4;
const TITLE_FRAGMENT_MIN_PHRASE_WORDS = 3;
const DOCUMENT_NUMBER_MATCH_BOOST = 2.4;
const DOCUMENT_NUMBER_MISMATCH_PENALTY = 1.1;
const RADA_DATRED_MATCH_BOOST = 3.4;
const RADA_DATRED_MISMATCH_PENALTY = 1.6;
const RADA_MONTH_MATCH_BOOST = 1.9;
const RADA_MONTH_MISMATCH_PENALTY = 0.9;
const REFERENCED_DOCUMENT_NUMBER_MATCH_BOOST = 3;
const REFERENCED_DOCUMENT_NUMBER_MISMATCH_PENALTY = 0.6;
const REFERENCED_RADA_DATRED_MATCH_BOOST = 4;
const REFERENCED_RADA_DATRED_MISMATCH_PENALTY = 0.85;
const REFERENCED_RADA_MONTH_MATCH_BOOST = 2.2;
const REFERENCED_RADA_MONTH_MISMATCH_PENALTY = 0.45;
const RECURRING_SERIES_DATE_IDENTITY_BOOST = 16;
const MIN_RECURRING_SERIES_SIZE = 3;

const AMENDMENT_TITLE_PREFIXES = [
  'про внесення змін',
  'про внесення зміни',
  'про внесення змін і доповнень',
  'про затвердження змін',
  'про визнання таким, що втратив чинність',
  'про визнання такими, що втратили чинність',
];

const AMENDMENT_QUERY_MARKERS = [
  'змін',
  'зміни',
  'зміною',
  'внести',
  'внесення',
  'редакц',
  'доповн',
  'скасув',
  'втратив чинність',
  'втратили чинність',
  'нова редакц',
];

const QUERY_STOPWORDS = new Set([
  'а',
  'або',
  'але',
  'в',
  'від',
  'до',
  'за',
  'з',
  'і',
  'й',
  'із',
  'коли',
  'на',
  'не',
  'під',
  'по',
  'про',
  'та',
  'у',
  'це',
  'чи',
  'що',
  'щодо',
  'яка',
  'яке',
  'який',
  'які',
  'як',
]);

const PRIMARY_LAW_LOCATOR_NOISE_TOKENS = new Set([
  'який',
  'яка',
  'яке',
  'які',
  'якого',
  'якої',
  'якому',
  'яким',
  'якими',
  'яких',
  'саме',
  'акт',
  'акта',
  'актом',
  'закон',
  'закону',
  'законом',
  'закони',
  'кодекс',
  'кодексу',
  'кодексом',
  'конвенція',
  'конвенції',
  'договор',
  'договір',
  'договору',
  'статут',
  'статуту',
  'спеціальний',
  'спеціального',
  'спеціальним',
  'спеціальні',
  'профільний',
  'профільного',
  'профільним',
  'профільні',
  'визначає',
  'визначити',
  'встановлює',
  'встановити',
  'регулює',
  'регулювати',
  'передбачає',
  'передбачити',
  'дозволяє',
  'дозволити',
  'право',
  'права',
  'правом',
  'праву',
]);

const UKRAINIAN_MONTH_NUMBERS = new Map<string, string>([
  ['січень', '01'],
  ['січня', '01'],
  ['січні', '01'],
  ['лютий', '02'],
  ['лютого', '02'],
  ['лютому', '02'],
  ['березень', '03'],
  ['березня', '03'],
  ['березні', '03'],
  ['квітень', '04'],
  ['квітня', '04'],
  ['квітні', '04'],
  ['травень', '05'],
  ['травня', '05'],
  ['травні', '05'],
  ['червень', '06'],
  ['червня', '06'],
  ['червні', '06'],
  ['липень', '07'],
  ['липня', '07'],
  ['липні', '07'],
  ['серпень', '08'],
  ['серпня', '08'],
  ['серпні', '08'],
  ['вересень', '09'],
  ['вересня', '09'],
  ['вересні', '09'],
  ['жовтень', '10'],
  ['жовтня', '10'],
  ['жовтні', '10'],
  ['листопад', '11'],
  ['листопада', '11'],
  ['листопаді', '11'],
  ['грудень', '12'],
  ['грудня', '12'],
  ['грудні', '12'],
]);

const UKRAINIAN_MONTH_PATTERN = [...new Set(UKRAINIAN_MONTH_NUMBERS.keys())].join('|');
const TEXTUAL_DATE_REGEX = new RegExp(
  `\\b(\\d{1,2})\\s+(${UKRAINIAN_MONTH_PATTERN})\\s+(\\d{4})(?:\\s+року)?\\b`,
  'giu'
);
const TEXTUAL_MONTH_YEAR_REGEX = new RegExp(
  `\\b(${UKRAINIAN_MONTH_PATTERN})\\s+(\\d{4})(?:\\s+року)?\\b`,
  'giu'
);
const NUMERIC_DATE_REGEX = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/gu;
const ISO_DATE_REGEX = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;

const ACT_REFERENCE_CUE_PATTERNS = [
  'указ(?:у|ом|і|а)?',
  'постанова|постанови|постановою|постанову',
  'наказ(?:у|ом|і|а)?',
  'розпорядження',
  'рішення|рішенню|рішенням|рішенні',
  'закон(?:у|ом|і|а)?',
  'кодекс(?:у|ом|і|а)?',
  'правила|правил',
  'порядок|порядку',
  'інструкція|інструкції',
  'положення',
  'регламент(?:у|ом|і)?',
  'конвенція|конвенції',
  'договір|договору',
  'статут(?:у|ом|і)?',
];

const ACT_REFERENCE_SIGNAL_REGEX = new RegExp(
  `(?:^|[\\s\\W])((?:${ACT_REFERENCE_CUE_PATTERNS.join('|')})\\s+[^\\n,.?!;:]{4,160})(?=$|[\\s\\W])`,
  'giu'
);
const ACT_REFERENCE_MODIFIED_SIGNAL_REGEX = new RegExp(
  `(?:^|[\\s\\W])(((?:(?:урядов|підзаконн|нормативн|нормативно-правов|відомч|галузев|банківськ|регуляторн)\\p{L}*\\s+){1,2})(?:${ACT_REFERENCE_CUE_PATTERNS.join('|')})\\s+[^\\n,.?!;:]{4,160})(?=$|[\\s\\W])`,
  'giu'
);
const REPEAL_TITLE_PREFIX_REGEX =
  /^про визнання такими?, що втрат(?:ив|ило|или) чинність,?\s+/iu;
const TITLE_FRAGMENT_PREFIX_REGEX =
  /^(?:про\s+|правила\s+|порядок\s+|інструкція\s+|положення\s+|регламент\s+|кодекс\s+|конвенція\s+|договір\s+|статут\s+)/iu;
const ACT_REFERENCE_FOLLOW_UP_MARKERS = new Set([
  'де',
  'коли',
  'куди',
  'скільки',
  'хто',
  'чи',
  'що',
  'як',
  'яка',
  'яке',
  'який',
  'якими',
  'яких',
  'яким',
  'якого',
  'якої',
  'яку',
]);

const BROAD_NON_PRIMARY_DECISION_QUERY_REGEX =
  /(?:^|[\s,])(?:(?:(?:урядов|підзаконн|нормативн|нормативно-правов|відомч|галузев|банківськ|регуляторн)\p{L}*\s+){1,2})рішен\p{L}*/iu;
const BROAD_NON_PRIMARY_DECISION_AUTHORITY_REGEX =
  /\b(?:кму|кабмін\p{L}*|кабінет\p{L}*\s+міністр\p{L}*|уряд\p{L}*|нбу|нацбанк\p{L}*|національн\p{L}*\s+банк\p{L}*|міністерств\p{L}*|відомств\p{L}*)\b/iu;
const BROAD_NON_PRIMARY_DECISION_COMPATIBLE_CUES = new Set(['постанова', 'розпорядження', 'наказ']);

interface ActEntry {
  rada_nreg: string;
  title: string;
  aliases: string[];
  summary: string | null;
  category: string | null;
  storage_category: string | null;
  document_type: string | null;
  document_type_slug: string | null;
  document_number: string | null;
  rada_datred: string | null;
  validity_status: string | null;
}

interface TaxonomySnapshot {
  byStructuredId: Map<string, ActEntry[]>;
  byNumericStem: Map<string, ActEntry[]>;
  byAlias: Map<string, ActEntry[]>;
  byAliasExact: Map<string, ActEntry[]>;
  byKeyword: Map<string, ActEntry[]>;
  byTopic: Map<string, ActEntry[]>;
  byTitle: Map<string, ActEntry[]>;
  byTitleExact: Map<string, ActEntry[]>;
  bySummary: Map<string, ActEntry[]>;
  byCategory: Map<string, ActEntry[]>;
  byStorageCategory: Map<string, ActEntry[]>;
  byDocumentType: Map<string, ActEntry[]>;
  byDocumentTypeSlug: Map<string, ActEntry[]>;
  byRecurringSeriesKey: Map<string, ActEntry[]>;
  acts: Map<string, ActEntry>;
  version: number;
  loadedAt: number;
}

function toKey(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCategoryFamilyKey(value: string | null | undefined): string {
  return (
    String(value ?? '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .trim()
  );
}

function getCompatibleDomainCategoryKeys(domainHint: string | null | undefined): string[] {
  const normalized = normalizeCategoryFamilyKey(domainHint);
  if (!normalized || normalized === 'general' || normalized === 'unknown') return [];
  switch (normalized) {
    case 'criminal':
      return ['criminal', 'criminal_procedure'];
    case 'civil':
      return ['civil', 'civil_procedure', 'family'];
    case 'family':
      return ['family', 'civil'];
    case 'administrative':
    case 'admin':
      return ['administrative', 'administrative_offenses', 'civil_procedure_administrative'];
    case 'tax':
    case 'tax_customs':
      return ['tax_customs'];
    case 'labor':
    case 'labor_social':
      return ['labor_social'];
    default:
      return [normalized];
  }
}

function categoryMatchesDomainEnvelope(
  category: string | null | undefined,
  domainHint: string | null | undefined
): boolean {
  const normalizedCategory = normalizeCategoryFamilyKey(category);
  if (!normalizedCategory) return false;
  return getCompatibleDomainCategoryKeys(domainHint).some(
    (familyKey) =>
      normalizedCategory === familyKey ||
      normalizedCategory.startsWith(`${familyKey}_`) ||
      familyKey.startsWith(`${normalizedCategory}_`)
  );
}

function tokenizeQuery(q: string): string[] {
  const normalized = (q ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const tokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
  return [...new Set(tokens)];
}

function normalizeActIdentifier(value: string): string {
  return normalizeStructuredActIdentifier(value);
}

function normalizeNumericStem(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/[^\d]+/gu, '').replace(/^0+/u, '');
  if (!digits) return null;
  return digits;
}

function normalizeDocumentNumber(value: string | null | undefined): string | null {
  const normalized = String(value ?? '')
    .normalize('NFC')
    .replace(/^№\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  return normalized || null;
}

function normalizeRadaDatred(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/u.test(raw)) return raw.slice(0, 10);
  if (/^\d{8}$/u.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return null;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toMonthKey(year: number, month: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

type QueryDocumentIdentitySignals = {
  exactDates: Set<string>;
  monthKeys: Set<string>;
  documentNumbers: Set<string>;
};

function collectQueryDocumentIdentitySignals(values: string[]): QueryDocumentIdentitySignals {
  const exactDates = new Set<string>();
  const monthKeys = new Set<string>();
  const documentNumbers = new Set<string>();

  for (const value of values) {
    const text = String(value ?? '').normalize('NFC');
    if (!text) continue;

    for (const match of text.matchAll(ISO_DATE_REGEX)) {
      const isoDate = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
      const monthKey = toMonthKey(Number(match[1]), Number(match[2]));
      if (isoDate) exactDates.add(isoDate);
      if (monthKey) monthKeys.add(monthKey);
    }
    for (const match of text.matchAll(NUMERIC_DATE_REGEX)) {
      const isoDate = toIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
      const monthKey = toMonthKey(Number(match[3]), Number(match[2]));
      if (isoDate) exactDates.add(isoDate);
      if (monthKey) monthKeys.add(monthKey);
    }
    for (const match of text.matchAll(TEXTUAL_DATE_REGEX)) {
      const month = UKRAINIAN_MONTH_NUMBERS.get(match[2].toLowerCase());
      if (!month) continue;
      const isoDate = toIsoDate(Number(match[3]), Number(month), Number(match[1]));
      const monthKey = toMonthKey(Number(match[3]), Number(month));
      if (isoDate) exactDates.add(isoDate);
      if (monthKey) monthKeys.add(monthKey);
    }
    for (const match of text.matchAll(TEXTUAL_MONTH_YEAR_REGEX)) {
      const month = UKRAINIAN_MONTH_NUMBERS.get(match[1].toLowerCase());
      const monthKey = month ? toMonthKey(Number(match[2]), Number(month)) : null;
      if (monthKey) monthKeys.add(monthKey);
    }

    const referencedNumber = normalizeDocumentNumber(extractReferencedActNumber(text));
    if (referencedNumber) documentNumbers.add(referencedNumber);
  }

  return { exactDates, monthKeys, documentNumbers };
}

function scoreEntryDocumentIdentity(
  entry: Pick<ActEntry, 'document_number' | 'rada_datred'>,
  queryIdentity: QueryDocumentIdentitySignals
): ActCandidateScore {
  let score = 0;
  const reasons: string[] = [];
  const entryDocumentNumber = normalizeDocumentNumber(entry.document_number);
  const entryDate = normalizeRadaDatred(entry.rada_datred);
  const entryMonthKey = entryDate ? entryDate.slice(0, 7) : null;

  if (queryIdentity.documentNumbers.size > 0 && entryDocumentNumber) {
    if (queryIdentity.documentNumbers.has(entryDocumentNumber)) {
      score += DOCUMENT_NUMBER_MATCH_BOOST;
      reasons.push('document_number_match');
    } else {
      score -= DOCUMENT_NUMBER_MISMATCH_PENALTY;
      reasons.push('document_number_penalty');
    }
  }

  if (queryIdentity.exactDates.size > 0 && entryDate) {
    if (queryIdentity.exactDates.has(entryDate)) {
      score += RADA_DATRED_MATCH_BOOST;
      reasons.push('rada_datred_match');
    } else {
      score -= RADA_DATRED_MISMATCH_PENALTY;
      reasons.push('rada_datred_penalty');
    }
  } else if (queryIdentity.exactDates.size === 0 && queryIdentity.monthKeys.size > 0 && entryMonthKey) {
    if (queryIdentity.monthKeys.has(entryMonthKey)) {
      score += RADA_MONTH_MATCH_BOOST;
      reasons.push('rada_month_match');
    } else {
      score -= RADA_MONTH_MISMATCH_PENALTY;
      reasons.push('rada_month_penalty');
    }
  }

  return { score, reasons };
}

function collectEntryReferencedDocumentIdentitySignals(
  entry: Pick<ActEntry, 'title' | 'aliases' | 'document_type' | 'document_number' | 'rada_datred'>
): QueryDocumentIdentitySignals {
  const referencedIdentity = collectQueryDocumentIdentitySignals([
    entry.title,
    ...(entry.aliases ?? []),
    entry.document_type && entry.title ? `${entry.document_type} ${entry.title}` : '',
  ]);
  const ownDocumentNumber = normalizeDocumentNumber(entry.document_number);
  const ownDate = normalizeRadaDatred(entry.rada_datred);
  if (ownDocumentNumber) referencedIdentity.documentNumbers.delete(ownDocumentNumber);
  if (ownDate) {
    referencedIdentity.exactDates.delete(ownDate);
    referencedIdentity.monthKeys.delete(ownDate.slice(0, 7));
  }
  return referencedIdentity;
}

function scoreEntryReferencedDocumentIdentity(
  entry: Pick<ActEntry, 'title' | 'aliases' | 'document_type' | 'document_number' | 'rada_datred'>,
  queryIdentity: QueryDocumentIdentitySignals
): ActCandidateScore {
  let score = 0;
  const reasons: string[] = [];
  const referencedIdentity = collectEntryReferencedDocumentIdentitySignals(entry);

  if (queryIdentity.documentNumbers.size > 0 && referencedIdentity.documentNumbers.size > 0) {
    const hasDocumentNumberMatch = [...queryIdentity.documentNumbers].some((value) =>
      referencedIdentity.documentNumbers.has(value)
    );
    if (hasDocumentNumberMatch) {
      score += REFERENCED_DOCUMENT_NUMBER_MATCH_BOOST;
      reasons.push('referenced_document_number_match');
    } else {
      score -= REFERENCED_DOCUMENT_NUMBER_MISMATCH_PENALTY;
      reasons.push('referenced_document_number_penalty');
    }
  }

  if (queryIdentity.exactDates.size > 0 && referencedIdentity.exactDates.size > 0) {
    const hasExactDateMatch = [...queryIdentity.exactDates].some((value) =>
      referencedIdentity.exactDates.has(value)
    );
    if (hasExactDateMatch) {
      score += REFERENCED_RADA_DATRED_MATCH_BOOST;
      reasons.push('referenced_rada_datred_match');
    } else {
      score -= REFERENCED_RADA_DATRED_MISMATCH_PENALTY;
      reasons.push('referenced_rada_datred_penalty');
    }
  } else if (
    queryIdentity.exactDates.size === 0 &&
    queryIdentity.monthKeys.size > 0 &&
    referencedIdentity.monthKeys.size > 0
  ) {
    const hasMonthMatch = [...queryIdentity.monthKeys].some((value) =>
      referencedIdentity.monthKeys.has(value)
    );
    if (hasMonthMatch) {
      score += REFERENCED_RADA_MONTH_MATCH_BOOST;
      reasons.push('referenced_rada_month_match');
    } else {
      score -= REFERENCED_RADA_MONTH_MISMATCH_PENALTY;
      reasons.push('referenced_rada_month_penalty');
    }
  }

  return { score, reasons };
}

function scoreEntryResolvedDocumentIdentity(
  entry: Pick<ActEntry, 'title' | 'aliases' | 'document_type' | 'document_number' | 'rada_datred'>,
  queryIdentity: QueryDocumentIdentitySignals
): ActCandidateScore {
  const directIdentity = scoreEntryDocumentIdentity(entry, queryIdentity);
  const referencedIdentity = scoreEntryReferencedDocumentIdentity(entry, queryIdentity);
  let score = directIdentity.score + referencedIdentity.score;
  const reasons = uniqueStrings([...directIdentity.reasons, ...referencedIdentity.reasons]);

  const referencedDocumentMatched = referencedIdentity.reasons.includes('referenced_document_number_match');
  const referencedDateMatched =
    referencedIdentity.reasons.includes('referenced_rada_datred_match') ||
    referencedIdentity.reasons.includes('referenced_rada_month_match');

  if (referencedDocumentMatched && directIdentity.reasons.includes('document_number_penalty')) {
    score += DOCUMENT_NUMBER_MISMATCH_PENALTY;
    reasons.push('document_number_penalty_suppressed_by_reference');
  }
  if (referencedDateMatched && directIdentity.reasons.includes('rada_datred_penalty')) {
    score += RADA_DATRED_MISMATCH_PENALTY;
    reasons.push('rada_datred_penalty_suppressed_by_reference');
  }
  if (referencedDateMatched && directIdentity.reasons.includes('rada_month_penalty')) {
    score += RADA_MONTH_MISMATCH_PENALTY;
    reasons.push('rada_month_penalty_suppressed_by_reference');
  }

  return { score, reasons: uniqueStrings(reasons) };
}

function extractPrimaryNumericStem(value: string | null | undefined): string | null {
  const normalized = normalizeActIdentifier(String(value ?? ''));
  const match = normalized.match(/(\d{1,8})/u);
  return normalizeNumericStem(match?.[1] ?? null);
}

export function extractCuedNumericActReferences(
  query: string
): Array<{ cue: string; numericStem: string; rawReference: string }> {
  const out: Array<{ cue: string; numericStem: string; rawReference: string }> = [];
  const seen = new Set<string>();
  const pattern = new RegExp(
    `((?:${ACT_REFERENCE_CUE_PATTERNS.join('|')})(?:\\s+[\\p{L}][\\p{L}.\\-"]{1,24}){0,3}\\s*(?:№|N|No\\.?|#)\\s*(\\d{1,8}))`,
    'giu'
  );
  for (const match of query.normalize('NFC').matchAll(pattern)) {
    const rawReference = match[1]?.trim();
    const numericStem = normalizeNumericStem(match[2]?.trim());
    const cue = normalizeActReferenceCue(rawReference);
    if (!rawReference || !numericStem || !cue) continue;
    const key = `${cue}::${numericStem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cue, numericStem, rawReference });
  }
  return out;
}

function tokenizeWords(value: string): string[] {
  return value
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
      .filter(
      (part) => part.length >= MIN_TOKEN_LEN && !QUERY_STOPWORDS.has(part)
    );
}

function buildPrimaryLawLocatorResidualSignals(query: string): { tokens: string[]; phrases: string[] } {
  const residualTokens = new Set<string>();
  const residualPhrases = new Set<string>();
  for (const signal of extractInterrogativeActLocatorSignals(query)) {
    const normalizedSignal = signal.normalize('NFC').trim();
    if (!normalizedSignal) continue;
    const signalTokens = tokenizeWords(normalizedSignal)
      .map((token) => normalizeReferenceCueToken(token))
      .filter((token) => token.length >= MIN_TOKEN_LEN && !PRIMARY_LAW_LOCATOR_NOISE_TOKENS.has(token));
    if (signalTokens.length === 0) continue;
    for (const token of signalTokens) residualTokens.add(token);
    for (const phrase of buildPhraseSignals(signalTokens, MAX_QUERY_PHRASE_WORDS)) {
      residualPhrases.add(phrase);
    }
  }
  return {
    tokens: [...residualTokens],
    phrases: [...residualPhrases],
  };
}

function normalizeReferenceCueToken(token: string): string {
  return normalizeActReferenceCue(token) ?? token;
}

export function normalizeActReferenceCue(value: string | null | undefined): string | null {
  const firstToken = String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .find(Boolean);
  if (!firstToken) return null;
  if (firstToken.startsWith('указ')) return 'указ';
  if (firstToken.startsWith('ukaz')) return 'указ';
  if (firstToken.startsWith('постан')) return 'постанова';
  if (firstToken.startsWith('postanov')) return 'постанова';
  if (firstToken.startsWith('наказ')) return 'наказ';
  if (firstToken.startsWith('nakaz')) return 'наказ';
  if (firstToken.startsWith('розпоряджен')) return 'розпорядження';
  if (firstToken.startsWith('rozporiad') || firstToken.startsWith('rozporyad')) return 'розпорядження';
  if (firstToken.startsWith('рішен')) return 'рішення';
  if (firstToken.startsWith('rishenn')) return 'рішення';
  if (firstToken.startsWith('закон')) return 'закон';
  if (firstToken.startsWith('zakon')) return 'закон';
  if (firstToken === 'law') return 'закон';
  if (firstToken.startsWith('кодекс')) return 'кодекс';
  if (firstToken.startsWith('kodeks')) return 'кодекс';
  if (firstToken === 'code') return 'кодекс';
  if (firstToken.startsWith('правил') || firstToken.startsWith('правила')) return 'правила';
  if (firstToken === 'rules') return 'правила';
  if (firstToken.startsWith('поряд')) return 'порядок';
  if (firstToken.startsWith('poriad') || firstToken.startsWith('poryad')) return 'порядок';
  if (firstToken === 'procedure') return 'порядок';
  if (firstToken.startsWith('інструкц')) return 'інструкція';
  if (firstToken.startsWith('instruk')) return 'інструкція';
  if (firstToken === 'instruction') return 'інструкція';
  if (firstToken.startsWith('положен')) return 'положення';
  if (firstToken.startsWith('polozh')) return 'положення';
  if (firstToken === 'regulation') return 'положення';
  if (firstToken.startsWith('регламент')) return 'регламент';
  if (firstToken.startsWith('reglament')) return 'регламент';
  if (firstToken.startsWith('конвенц')) return 'конвенція';
  if (firstToken.startsWith('konvent')) return 'конвенція';
  if (firstToken === 'convention') return 'конвенція';
  if (firstToken.startsWith('договор') || firstToken.startsWith('договір')) return 'договір';
  if (firstToken.startsWith('dogov') || firstToken.startsWith('dohov')) return 'договір';
  if (firstToken === 'treaty' || firstToken === 'agreement') return 'договір';
  if (firstToken.startsWith('статут')) return 'статут';
  if (firstToken.startsWith('statut')) return 'статут';
  if (firstToken === 'charter') return 'статут';
  if (firstToken === 'resolution') return 'постанова';
  if (firstToken === 'decree') return 'указ';
  if (firstToken === 'order') return 'наказ';
  return null;
}

function queryUsesBroadNonPrimaryDecisionEnvelope(query: string | null | undefined): boolean {
  const normalized = String(query ?? '').normalize('NFC');
  if (!normalized) return false;
  return (
    BROAD_NON_PRIMARY_DECISION_QUERY_REGEX.test(normalized) ||
    (
      /\bрішен\p{L}*/iu.test(normalized) &&
      BROAD_NON_PRIMARY_DECISION_AUTHORITY_REGEX.test(normalized)
    )
  );
}

export function areActReferenceCuesCompatible(
  requestedCue: string | null | undefined,
  candidateCue: string | null | undefined,
  query?: string | null
): boolean {
  if (!requestedCue || !candidateCue) return false;
  if (requestedCue === candidateCue) return true;
  if (
    requestedCue === 'рішення' &&
    BROAD_NON_PRIMARY_DECISION_COMPATIBLE_CUES.has(candidateCue) &&
    queryUsesBroadNonPrimaryDecisionEnvelope(query)
  ) {
    return true;
  }
  return false;
}

function buildReferenceTokens(value: string | null | undefined): string[] {
  const rawTokens = [...new Set(tokenizeWords(String(value ?? '')).filter((token) => token.length >= 4))];
  const cueNormalizedTokens = rawTokens
    .map((token) => normalizeReferenceCueToken(token))
    .filter((token) => token.length >= 4);
  return uniqueStrings([...rawTokens, ...cueNormalizedTokens]);
}

function extractReferencedActNumber(value: string | null | undefined): string | null {
  const match = String(value ?? '')
    .normalize('NFC')
    .match(/(?:^|[\s(])(?:№|N|No\.?|#)\s*([\p{L}\d][\p{L}\d/-]{0,20})\b/iu);
  const normalized = match?.[1]?.trim();
  return normalized || null;
}

const RUNTIME_CODE_TITLE_ALIAS_PATTERNS: Array<{ pattern: RegExp; aliases: string[] }> = [
  { pattern: /\bцивільний кодекс(?:\s+україни)?\b/iu, aliases: ['ЦКУ', 'ЦК України', 'ЦК'] },
  {
    pattern: /\bцивільний процесуальний кодекс(?:\s+україни)?\b/iu,
    aliases: ['ЦПКУ', 'ЦПК України', 'ЦПК'],
  },
  { pattern: /\bкримінальний кодекс(?:\s+україни)?\b/iu, aliases: ['ККУ', 'КК України', 'КК'] },
  {
    pattern: /\bкримінальний процесуальний кодекс(?:\s+україни)?\b/iu,
    aliases: ['КПКУ', 'КПК України', 'КПК'],
  },
  { pattern: /\bподатковий кодекс(?:\s+україни)?\b/iu, aliases: ['ПКУ', 'ПК України', 'ПК'] },
  { pattern: /\bмитний кодекс(?:\s+україни)?\b/iu, aliases: ['МКУ', 'МК України', 'МК'] },
  { pattern: /\bсімейний кодекс(?:\s+україни)?\b/iu, aliases: ['СКУ', 'СК України', 'СК'] },
  { pattern: /\bгосподарський кодекс(?:\s+україни)?\b/iu, aliases: ['ГКУ', 'ГК України', 'ГК'] },
  {
    pattern: /\bгосподарський процесуальний кодекс(?:\s+україни)?\b/iu,
    aliases: ['ГПКУ', 'ГПК України', 'ГПК'],
  },
  {
    pattern: /\bкодекс адміністративного судочинства(?:\s+україни)?\b/iu,
    aliases: ['КАСУ', 'КАС України'],
  },
  {
    pattern: /\bкодекс україни про адміністративні правопорушення\b/iu,
    aliases: ['КУпАП', 'КУАП', 'КУпАП України'],
  },
  {
    pattern: /\bкодекс законів про працю(?:\s+україни)?\b/iu,
    aliases: ['КЗпП', 'КЗПП', 'КЗпП України'],
  },
  { pattern: /\bземельний кодекс(?:\s+україни)?\b/iu, aliases: ['ЗКУ', 'ЗК України', 'ЗК'] },
  { pattern: /\bбюджетний кодекс(?:\s+україни)?\b/iu, aliases: ['БКУ', 'БК України', 'БК'] },
];

function deriveRuntimeCodeTitleAliases(title: string): string[] {
  const normalizedTitle = title.normalize('NFC').trim();
  if (!normalizedTitle) return [];
  const out = new Set<string>();
  for (const entry of RUNTIME_CODE_TITLE_ALIAS_PATTERNS) {
    if (!entry.pattern.test(normalizedTitle)) continue;
    for (const alias of entry.aliases) out.add(alias);
  }
  return [...out];
}

function deriveRuntimeTitleAliases(title: string, documentType: string | null): string[] {
  const normalizedTitle = title.normalize('NFC').trim();
  if (!normalizedTitle) return [];

  const out = new Set<string>();
  for (const alias of deriveRuntimeCodeTitleAliases(normalizedTitle)) out.add(alias);
  const titleKey = toKey(normalizedTitle);
  if (REPEAL_TITLE_PREFIX_REGEX.test(titleKey)) {
    const referencedSegment = normalizedTitle.replace(REPEAL_TITLE_PREFIX_REGEX, '').trim();
    const cue = normalizeActReferenceCue(referencedSegment) ?? normalizeActReferenceCue(documentType);
    const referencedNumber = extractReferencedActNumber(referencedSegment);

    if (cue && referencedNumber) {
      out.add(`${cue} про втрату чинності № ${referencedNumber}`);
      out.add(`про втрату чинності ${cue} № ${referencedNumber}`);
    }
    if (cue) {
      out.add(`${cue} втратило чинність`);
      out.add(`${cue} про втрату чинності`);
    }
  }

  const normalizedSurface = normalizeRecurringSeriesTitle(normalizedTitle);
  if (normalizedSurface.includes('офіційний курс гривні щодо іноземних валют')) {
    out.add('офіційний курс гривні до іноземних валют');
    out.add('курс гривні до іноземних валют');
    out.add('офіційний валютний курс гривні');
    out.add('валютний курс гривні');
  }

  return [...out];
}

function compactKey(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeRecurringSeriesTitle(title: string | null | undefined): string {
  return String(title ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\([^)]*\)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function buildRecurringSeriesKey(
  entry: Pick<ActEntry, 'title' | 'document_type' | 'document_type_slug' | 'category'>
): string | null {
  const normalizedTitle = normalizeRecurringSeriesTitle(entry.title);
  const normalizedDocumentType = toKey(entry.document_type_slug ?? entry.document_type ?? '');
  if (!normalizedTitle || !normalizedDocumentType) return null;
  return [
    normalizedTitle,
    normalizedDocumentType,
    toKey(entry.category ?? '') || '_uncategorized',
  ].join('::');
}

function hasCandidateMetadataSurfaceMatch(reasons: string[]): boolean {
  return reasons.some((reason) =>
    [
      'exact_alias_match',
      'exact_title_match',
      'alias_match',
      'title_match',
      'summary_match',
      'keyword_match',
      'topic_match',
    ].includes(reason)
  );
}

function scoreRecurringSeriesDateIdentity(
  snap: Pick<TaxonomySnapshot, 'byRecurringSeriesKey'>,
  entry: Pick<ActEntry, 'title' | 'document_type' | 'document_type_slug' | 'category' | 'rada_datred'>,
  queryIdentity: QueryDocumentIdentitySignals,
  reasons: string[]
): ActCandidateScore {
  if (!queryIdentity.exactDates.size || !hasCandidateMetadataSurfaceMatch(reasons)) {
    return { score: 0, reasons: [] };
  }
  const entryDate = normalizeRadaDatred(entry.rada_datred);
  if (!entryDate || !queryIdentity.exactDates.has(entryDate)) {
    return { score: 0, reasons: [] };
  }
  const recurringSeriesKey = buildRecurringSeriesKey(entry);
  if (!recurringSeriesKey) return { score: 0, reasons: [] };
  const seriesEntries = snap.byRecurringSeriesKey.get(recurringSeriesKey) ?? [];
  const uniqueDatedEntries = new Set(
    seriesEntries
      .map((seriesEntry) => normalizeRadaDatred(seriesEntry.rada_datred))
      .filter(Boolean)
  );
  if (uniqueDatedEntries.size < MIN_RECURRING_SERIES_SIZE) {
    return { score: 0, reasons: [] };
  }
  return {
    score: RECURRING_SERIES_DATE_IDENTITY_BOOST,
    reasons: ['recurring_series_rada_datred_match'],
  };
}

function tokensSoftMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 6 || b.length < 6) return false;
  return a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5));
}

export function isAmendmentLikeActTitle(title: string | null | undefined): boolean {
  const key = toKey(title ?? '');
  if (!key) return false;
  return AMENDMENT_TITLE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function queryLooksAmendmentFocused(query: string | null | undefined): boolean {
  const key = toKey(query ?? '');
  if (!key) return false;
  return AMENDMENT_QUERY_MARKERS.some((marker) => key.includes(marker));
}

function scoreExactTextGroundingEntry(entry: ActEntry, signal: string, query: string): number {
  const signalKey = toKey(signal);
  if (!signalKey) return Number.NEGATIVE_INFINITY;

  let score = 0;
  const titleKey = toKey(entry.title);
  const aliasExact = entry.aliases.some((alias) => toKey(alias) === signalKey);
  const titleExact = titleKey === signalKey;
  const requestedReferencedNumber = extractReferencedActNumber(signal) ?? extractReferencedActNumber(query);
  const entryReferencedNumber = extractReferencedActNumber(entry.title);
  const candidateTokens = new Set([
    ...buildReferenceTokens(entry.title),
    ...entry.aliases.flatMap((alias) => buildReferenceTokens(alias)),
  ]);
  const signalTokens = buildReferenceTokens(signal);
  const tokenMatches = signalTokens.filter((token) => candidateTokens.has(token)).length;

  if (titleExact) score += 2.6;
  if (aliasExact) score += 2.3;
  if (titleKey && (titleKey.includes(signalKey) || signalKey.includes(titleKey))) score += 0.45;
  if (requestedReferencedNumber && entryReferencedNumber === requestedReferencedNumber) score += 2.4;
  else if (requestedReferencedNumber && entryReferencedNumber && entryReferencedNumber !== requestedReferencedNumber) {
    score -= 1.6;
  }
  score += Math.min(1.2, tokenMatches * 0.35);
  if (entry.validity_status === 'in_force') score += VALIDITY_IN_FORCE_BOOST;
  if (!queryLooksAmendmentFocused(query) && isAmendmentLikeActTitle(entry.title)) {
    score -= 1.8;
  }
  score += scoreEntryResolvedDocumentIdentity(entry, collectQueryDocumentIdentitySignals([signal, query])).score;
  return score;
}

function normalizeLogicalActFamilyTitle(title: string | null | undefined): string {
  return String(title ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\([^)]*\)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function entriesShareSingleLogicalActFamily(entries: ActEntry[]): boolean {
  if (entries.length < 2) return false;
  const normalizedTitles = new Set(entries.map((entry) => normalizeLogicalActFamilyTitle(entry.title)));
  if (normalizedTitles.size !== 1) return false;
  const categories = new Set(entries.map((entry) => entry.category ?? ''));
  const docTypes = new Set(entries.map((entry) => entry.document_type_slug ?? entry.document_type ?? ''));
  return categories.size === 1 && docTypes.size === 1;
}

function resolveLogicalActFamilyRepresentative(
  entries: ActEntry[],
  signal: string,
  query: string
): ActEntry | null {
  if (!entriesShareSingleLogicalActFamily(entries)) return null;
  return [...entries].sort((left, right) => {
    const scoreDiff = scoreExactTextGroundingEntry(right, signal, query) - scoreExactTextGroundingEntry(left, signal, query);
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff > 0 ? 1 : -1;
    return left.rada_nreg.localeCompare(right.rada_nreg);
  })[0] ?? null;
}

function resolveUniqueInForceLogicalActSuccessor(
  entries: ActEntry[],
  signals: Array<string | null | undefined>
): ActEntry | null {
  if (!entriesShareSingleLogicalActFamily(entries)) return null;
  const identity = collectQueryDocumentIdentitySignals(signals.map((signal) => String(signal ?? '')));
  if (
    identity.documentNumbers.size > 0 ||
    identity.exactDates.size > 0 ||
    identity.monthKeys.size > 0
  ) {
    return null;
  }
  const inForceEntries = entries.filter((entry) => entry.validity_status === 'in_force');
  if (inForceEntries.length !== 1) return null;
  const staleEntries = entries.filter(
    (entry) => entry.validity_status && entry.validity_status !== 'in_force'
  );
  if (staleEntries.length === 0) return null;
  return inForceEntries[0] ?? null;
}

function resolveExactTextGroundingAmbiguity(
  entries: ActEntry[],
  signal: string,
  query: string
): ActEntry | null {
  const inForceSuccessor = resolveUniqueInForceLogicalActSuccessor(entries, [signal, query]);
  if (inForceSuccessor) return inForceSuccessor;

  let best: { entry: ActEntry; score: number } | null = null;
  let secondScore = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const score = scoreExactTextGroundingEntry(entry, signal, query);
    if (!best || score > best.score) {
      secondScore = best?.score ?? secondScore;
      best = { entry, score };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (!best) return null;
  if (best.score - secondScore < EXACT_TEXT_GROUNDING_MIN_MARGIN) return null;
  return best.entry;
}

function collectTitleFragmentCandidates(snap: TaxonomySnapshot, fragment: string): ActEntry[] {
  const key = toKey(fragment);
  if (!key || key.length < 5) return [];

  const candidates = new Map<string, ActEntry>();
  for (const entry of snap.byTitleExact.get(key) ?? []) {
    candidates.set(entry.rada_nreg, entry);
  }
  for (const entry of snap.byAliasExact.get(key) ?? []) {
    candidates.set(entry.rada_nreg, entry);
  }
  for (const entry of snap.acts.values()) {
    const titleKey = toKey(entry.title);
    if (!titleKey) continue;
    if (titleKey.includes(key) || key.includes(titleKey)) {
      candidates.set(entry.rada_nreg, entry);
    }
  }
  if (candidates.size === 0) {
    const phraseSignals = buildPhraseSignals(buildReferenceTokens(fragment), MAX_QUERY_PHRASE_WORDS)
      .filter((phrase) => phrase.split(/\s+/u).filter(Boolean).length >= TITLE_FRAGMENT_MIN_PHRASE_WORDS)
      .sort((left, right) => right.split(/\s+/u).length - left.split(/\s+/u).length);
    for (const phrase of phraseSignals) {
      const phraseKey = toKey(phrase);
      if (!phraseKey) continue;
      for (const entry of snap.byTitle.get(phraseKey) ?? []) {
        candidates.set(entry.rada_nreg, entry);
      }
      for (const entry of snap.byAlias.get(phraseKey) ?? []) {
        candidates.set(entry.rada_nreg, entry);
      }
    }
  }
  return [...candidates.values()];
}

type TitleFragmentGroundingScore = {
  score: number;
  matchedTokenCount: number;
  tokenCoverage: number;
  matchedPhraseCount: number;
  maxPhraseWords: number;
};

function scoreTitleFragmentGroundingEntry(
  entry: ActEntry,
  fragment: string,
  query?: string
): TitleFragmentGroundingScore {
  const fragmentKey = toKey(fragment);
  const fragmentTokens = buildReferenceTokens(fragment);
  const requestedReferencedNumber = extractReferencedActNumber(fragment);
  const entryReferencedNumber = extractReferencedActNumber(entry.title);
  if (!fragmentKey || fragmentTokens.length === 0) {
    return {
      score: Number.NEGATIVE_INFINITY,
      matchedTokenCount: 0,
      tokenCoverage: 0,
      matchedPhraseCount: 0,
      maxPhraseWords: 0,
    };
  }

  const titleKey = toKey(entry.title);
  const titledDocumentKey = entry.document_type ? toKey(`${entry.document_type} ${entry.title}`) : '';
  const aliasKeys = entry.aliases.map((alias) => toKey(alias)).filter(Boolean);
  const candidateTokens = [
    ...buildReferenceTokens(entry.title),
    ...buildReferenceTokens(entry.document_type ?? ''),
    ...entry.aliases.flatMap((alias) => buildReferenceTokens(alias)),
  ];

  let matchedTokenCount = 0;
  for (const token of fragmentTokens) {
    if (candidateTokens.some((candidateToken) => tokensSoftMatch(token, candidateToken))) {
      matchedTokenCount += 1;
    }
  }
  const tokenCoverage = matchedTokenCount / fragmentTokens.length;

  let score = 0;
  if (titleKey && (titleKey.includes(fragmentKey) || fragmentKey.includes(titleKey))) score += 2.8;
  if (titledDocumentKey && (titledDocumentKey.includes(fragmentKey) || fragmentKey.includes(titledDocumentKey))) {
    score += 3.1;
  }
  if (requestedReferencedNumber && entryReferencedNumber === requestedReferencedNumber) score += 2.6;
  else if (requestedReferencedNumber && entryReferencedNumber && entryReferencedNumber !== requestedReferencedNumber) {
    score -= 1.8;
  }
  score += scoreEntryResolvedDocumentIdentity(
    entry,
    collectQueryDocumentIdentitySignals(query ? [fragment, query] : [fragment])
  ).score;

  let matchedPhraseCount = 0;
  let maxPhraseWords = 0;
  for (const phrase of buildPhraseSignals(fragmentTokens, MAX_QUERY_PHRASE_WORDS)) {
    const phraseWords = phrase.split(/\s+/u).filter(Boolean).length;
    if (phraseWords < TITLE_FRAGMENT_MIN_PHRASE_WORDS) continue;
    const phraseKey = toKey(phrase);
    if (!phraseKey) continue;
    const phraseMatched =
      (!!titleKey && titleKey.includes(phraseKey)) ||
      (!!titledDocumentKey && titledDocumentKey.includes(phraseKey)) ||
      aliasKeys.some((aliasKey) => aliasKey.includes(phraseKey) || phraseKey.includes(aliasKey));
    if (!phraseMatched) continue;
    matchedPhraseCount += 1;
    maxPhraseWords = Math.max(maxPhraseWords, phraseWords);
    score += phraseWords >= 4 ? 0.95 : 0.55;
  }

  score += Math.min(2.4, matchedTokenCount * 0.35);
  if (tokenCoverage >= 0.85) score += 1.1;
  else if (tokenCoverage >= 0.65) score += 0.55;
  else if (tokenCoverage < 0.45) score -= 1.1;
  if (entry.validity_status === 'in_force') score += VALIDITY_IN_FORCE_BOOST;
  if (!queryLooksAmendmentFocused(fragment) && isAmendmentLikeActTitle(entry.title)) {
    score -= 1.8;
  }

  return {
    score,
    matchedTokenCount,
    tokenCoverage,
    matchedPhraseCount,
    maxPhraseWords,
  };
}

function resolveTitleFragmentGroundingAmbiguity(
  entries: ActEntry[],
  fragment: string,
  query?: string
): ActEntry | null {
  const inForceSuccessor = resolveUniqueInForceLogicalActSuccessor(entries, [fragment, query]);
  if (inForceSuccessor) return inForceSuccessor;

  let best:
    | {
        entry: ActEntry;
        score: TitleFragmentGroundingScore;
      }
    | null = null;
  let secondScore = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const score = scoreTitleFragmentGroundingEntry(entry, fragment, query);
    if (!best || score.score > best.score.score) {
      secondScore = best?.score.score ?? secondScore;
      best = { entry, score };
    } else if (score.score > secondScore) {
      secondScore = score.score;
    }
  }

  if (!best) return null;
  if (best.score.matchedTokenCount < TITLE_FRAGMENT_MIN_TOKENS) return null;
  if (
    best.score.maxPhraseWords < 4 &&
    best.score.matchedPhraseCount < 2 &&
    best.score.tokenCoverage < 0.75
  ) {
    return null;
  }
  if (best.score.score - secondScore < TITLE_FRAGMENT_GROUNDING_MIN_MARGIN) return null;
  return best.entry;
}

function resolveTitleFragmentGroundingEntries(
  snap: TaxonomySnapshot,
  fragment: string,
  query?: string
): ActEntry[] {
  const candidates = collectTitleFragmentCandidates(snap, fragment);
  if (candidates.length <= 1) return candidates;

  const exactTextGrounded = resolveExactTextGroundingAmbiguity(candidates, fragment, query ?? fragment);
  if (exactTextGrounded) return [exactTextGrounded];

  const titleFragmentGrounded = resolveTitleFragmentGroundingAmbiguity(candidates, fragment, query);
  if (titleFragmentGrounded) return [titleFragmentGrounded];

  return candidates.sort((left, right) => left.rada_nreg.localeCompare(right.rada_nreg));
}

function resolveCuedNumericReferenceAmbiguity(
  entries: ActEntry[],
  reference: { cue: string; numericStem: string; rawReference: string },
  query: string
): ActEntry | null {
  const fragments = uniqueStrings([
    query,
    reference.rawReference,
    ...extractActReferenceSignals(query),
    ...extractQuotedActTitleFragments(query),
  ])
    .filter((fragment) => buildReferenceTokens(fragment).length >= TITLE_FRAGMENT_MIN_TOKENS)
    .sort((left, right) => buildReferenceTokens(right).length - buildReferenceTokens(left).length);

  for (const fragment of fragments) {
    const grounded = resolveTitleFragmentGroundingAmbiguity(entries, fragment, query);
    if (grounded) return grounded;
  }
  return null;
}

export function extractActReferenceSignals(query: string): string[] {
  const out = new Set<string>();
  const addSignal = (rawSignal: string | null | undefined): void => {
    const signal = String(rawSignal ?? '')
      .normalize('NFC')
      .trim()
      .replace(/\s+/gu, ' ');
    if (!signal) return;
    out.add(signal);
    for (const compactSignal of buildCompactActReferenceSignals(signal)) out.add(compactSignal);
  };
  for (const match of query.normalize('NFC').matchAll(ACT_REFERENCE_SIGNAL_REGEX)) {
    addSignal(match[1]);
  }
  for (const match of query.normalize('NFC').matchAll(ACT_REFERENCE_MODIFIED_SIGNAL_REGEX)) {
    addSignal(match[1]);
  }
  for (const signal of extractInterrogativeActLocatorSignals(query)) addSignal(signal);
  return [...out];
}

function buildCompactActReferenceSignals(signal: string): string[] {
  const tokens = signal.normalize('NFC').match(/[\p{L}\p{N}/-]+/gu) ?? [];
  if (tokens.length < 2) return [];

  const cueIndex = tokens.findIndex((token) => normalizeActReferenceCue(token) !== null);
  const canonicalTokens = cueIndex >= 0 ? [...tokens.slice(cueIndex)] : [...tokens];
  const canonicalCue = normalizeActReferenceCue(canonicalTokens[0]);
  if (canonicalCue) canonicalTokens[0] = canonicalCue;

  const out = new Set<string>();
  out.add(tokens.join(' '));
  out.add(canonicalTokens.join(' '));

  let informativeAfterCue = 0;
  let cutIndex = -1;
  for (let index = 1; index < canonicalTokens.length; index += 1) {
    const rawToken = canonicalTokens[index] ?? '';
    const token = toKey(rawToken).replace(/[^\p{L}\p{N}]+/gu, '');
    if (!token) continue;
    if (ACT_REFERENCE_FOLLOW_UP_MARKERS.has(token) && informativeAfterCue >= 1) {
      cutIndex = index;
      break;
    }
    if (!QUERY_STOPWORDS.has(token)) informativeAfterCue += 1;
  }

  if (cutIndex >= 2) {
    out.add(canonicalTokens.slice(0, cutIndex).join(' '));
  }

  return [...out];
}

export function extractQuotedActTitleFragments(value: string): string[] {
  const normalized = value.normalize('NFC');
  ACT_REFERENCE_SIGNAL_REGEX.lastIndex = 0;
  const hasActCue =
    normalizeActReferenceCue(normalized) !== null ||
    ACT_REFERENCE_SIGNAL_REGEX.test(normalized);
  ACT_REFERENCE_SIGNAL_REGEX.lastIndex = 0;
  const out = new Set<string>();
  const collectQuotedSegments = (openQuote: string, closeQuote: string): string[] => {
    const segments: string[] = [];
    if (openQuote === closeQuote) {
      let outerStart = -1;
      for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        if (char !== openQuote) continue;
        if (outerStart < 0) {
          outerStart = index + 1;
          continue;
        }
        segments.push(normalized.slice(outerStart, index));
        outerStart = -1;
      }
      if (outerStart >= 0) {
        segments.push(normalized.slice(outerStart));
      }
      return segments;
    }
    let depth = 0;
    let outerStart = -1;
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (char === openQuote) {
        if (depth === 0) outerStart = index + 1;
        depth += 1;
        continue;
      }
      if (char === closeQuote && depth > 0) {
        depth -= 1;
        if (depth === 0 && outerStart >= 0) {
          segments.push(normalized.slice(outerStart, index));
          outerStart = -1;
        }
      }
    }
    if (depth > 0 && outerStart >= 0) {
      segments.push(normalized.slice(outerStart));
    }
    return segments;
  };
  const addFragment = (rawFragment: string | null | undefined): void => {
    const fragment = String(rawFragment ?? '')
      .trim()
      .replace(/\s+/gu, ' ')
      .replace(/[.,;:!?…]+$/u, '')
      .trim();
    if (!fragment) return;
    const rawTokens = fragment
      .normalize('NFC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= MIN_TOKEN_LEN);
    const contentTokens = tokenizeWords(fragment);
    if (rawTokens.length < 2) return;
    if (contentTokens.length < 2 && !TITLE_FRAGMENT_PREFIX_REGEX.test(fragment)) return;
    if (TITLE_FRAGMENT_PREFIX_REGEX.test(fragment) || hasActCue) out.add(fragment);
  };
  for (const fragment of uniqueStrings([
    ...collectQuotedSegments('«', '»'),
    ...collectQuotedSegments('"', '"'),
  ])) {
    addFragment(fragment);
  }
  return [...out];
}

export function shouldSkipApproximateActReferenceGrounding(signal: string): boolean {
  return extractQuotedActTitleFragments(signal).length > 0;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function addToMap(map: Map<string, ActEntry[]>, key: string, entry: ActEntry): void {
  const k = toKey(key);
  if (!k) return;
  const list = map.get(k) ?? [];
  if (!list.some((e) => e.rada_nreg === entry.rada_nreg)) list.push(entry);
  map.set(k, list);
}

function buildPhraseSignals(tokens: string[], maxWords: number): string[] {
  const out = new Set<string>();
  for (let size = 2; size <= Math.min(maxWords, tokens.length); size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const slice = tokens.slice(index, index + size);
      if (slice.some((token) => token.length < MIN_TOKEN_LEN)) continue;
      const longTokenCount = slice.filter((token) => token.length >= MIN_METADATA_TOKEN_LEN).length;
      const shortTokenCount = slice.length - longTokenCount;
      if (longTokenCount === 0) continue;
      if (shortTokenCount > 1) continue;
      out.add(slice.join(' '));
    }
  }
  return [...out];
}

function metadataSignals(
  value: unknown,
  options?: { includePhrases?: boolean; maxWords?: number; includeTokenParts?: boolean }
): string[] {
  const values = tolerantNormalizeToStrings(value);
  const out = new Set<string>();
  for (const item of values) {
    const normalized = toKey(item);
    if (!normalized) continue;
    out.add(normalized);
    const parts = tokenizeWords(normalized).filter((part) => part.length >= MIN_METADATA_TOKEN_LEN);
    const cueNormalizedParts = parts
      .map((part) => normalizeReferenceCueToken(part))
      .filter((part) => part.length >= MIN_METADATA_TOKEN_LEN);
    const signalParts = uniqueStrings([...parts, ...cueNormalizedParts]);
    if (options?.includeTokenParts !== false) {
      for (const part of signalParts) out.add(part);
    }
    if (options?.includePhrases) {
      for (const phrase of buildPhraseSignals(parts, options.maxWords ?? MAX_QUERY_PHRASE_WORDS)) {
        out.add(phrase);
      }
      for (const phrase of buildPhraseSignals(cueNormalizedParts, options.maxWords ?? MAX_QUERY_PHRASE_WORDS)) {
        out.add(phrase);
      }
    }
  }
  return [...out];
}

function aliasSignals(value: unknown): string[] {
  return metadataSignals(value, { includePhrases: true, includeTokenParts: false });
}

export function buildTaxonomyQuerySignals(query: string): { tokens: string[]; phrases: string[] } {
  const rawTokens = tokenizeQuery(query);
  const cueNormalizedTokens = rawTokens.map((token) => normalizeReferenceCueToken(token));
  const informativeTokens = tokenizeWords(query);
  const cueNormalizedInformativeTokens = informativeTokens.map((token) => normalizeReferenceCueToken(token));
  const residualLocatorSignals = buildPrimaryLawLocatorResidualSignals(query);
  const primaryLawLocatorQuery = residualLocatorSignals.tokens.length > 0;
  const filteredRawTokens = primaryLawLocatorQuery
    ? rawTokens.filter((token) => !PRIMARY_LAW_LOCATOR_NOISE_TOKENS.has(normalizeReferenceCueToken(token)))
    : rawTokens;
  const filteredCueNormalizedTokens = primaryLawLocatorQuery
    ? cueNormalizedTokens.filter((token) => !PRIMARY_LAW_LOCATOR_NOISE_TOKENS.has(token))
    : cueNormalizedTokens;
  const filteredCueNormalizedInformativeTokens = primaryLawLocatorQuery
    ? cueNormalizedInformativeTokens.filter((token) => !PRIMARY_LAW_LOCATOR_NOISE_TOKENS.has(token))
    : cueNormalizedInformativeTokens;
  const phrases = uniqueStrings([
    ...buildPhraseSignals(
      primaryLawLocatorQuery ? filteredCueNormalizedInformativeTokens : informativeTokens,
      MAX_QUERY_PHRASE_WORDS
    ),
    ...buildPhraseSignals(filteredCueNormalizedInformativeTokens, MAX_QUERY_PHRASE_WORDS),
    ...residualLocatorSignals.phrases,
  ]);
  const structuredIdentifiers = extractStructuredActIdentifiers(query);
  const tokenSignals = primaryLawLocatorQuery
    ? uniqueStrings([
        ...filteredCueNormalizedInformativeTokens,
        ...residualLocatorSignals.tokens,
      ])
    : uniqueStrings([
        ...filteredRawTokens,
        ...filteredCueNormalizedTokens,
        ...filteredCueNormalizedInformativeTokens,
      ]);
  return {
    tokens: uniqueStrings([...tokenSignals, ...structuredIdentifiers]),
    phrases: [...new Set([...phrases, ...structuredIdentifiers])],
  };
}

function isCompactTitleGroundingPhraseCandidate(phrase: string): boolean {
  const tokens = buildReferenceTokens(phrase);
  if (tokens.length < TITLE_FRAGMENT_MIN_PHRASE_WORDS) return false;

  const alphaTokens = tokens.filter((token) => {
    if (!/\p{L}/u.test(token) || /^\d+$/u.test(token)) return false;
    if (QUERY_STOPWORDS.has(token)) return false;
    if (PRIMARY_LAW_LOCATOR_NOISE_TOKENS.has(token)) return false;
    return true;
  });
  if (alphaTokens.length < 2) return false;
  if (!alphaTokens.some((token) => token.length >= 5)) return false;

  const identitySignals = collectQueryDocumentIdentitySignals([phrase]);
  if (
    alphaTokens.length < 3 &&
    (
      identitySignals.documentNumbers.size > 0 ||
      identitySignals.exactDates.size > 0 ||
      identitySignals.monthKeys.size > 0
    )
  ) {
    return false;
  }

  return true;
}

function getActReferenceTexts(entry: ActEntry): string[] {
  const texts = new Set<string>();
  for (const alias of entry.aliases) texts.add(alias);
  if (entry.title) texts.add(entry.title);
  if (entry.document_type && entry.title) texts.add(`${entry.document_type} ${entry.title}`);
  return [...texts];
}

function entryMatchesActCue(entry: ActEntry, cue: string, query?: string): boolean {
  const texts = [entry.document_type, entry.document_type_slug, entry.title, ...entry.aliases];
  return texts.some((text) => areActReferenceCuesCompatible(cue, normalizeActReferenceCue(text), query));
}

function filterGroundingEntriesByRequestedCue(
  entries: ActEntry[],
  signal: string,
  query: string,
  options?: { allowActReferenceSignalFallback?: boolean; allowQueryLevelCueFallback?: boolean }
): ActEntry[] {
  const cue =
    normalizeActReferenceCue(signal) ??
    (
      options?.allowActReferenceSignalFallback === false
        ? null
        : extractActReferenceSignals(query)
            .map((referenceSignal) => normalizeActReferenceCue(referenceSignal))
            .find(Boolean)
    ) ??
    (options?.allowQueryLevelCueFallback === false ? null : normalizeActReferenceCue(query));
  if (!cue) return entries;
  const matched = entries.filter((entry) => entryMatchesActCue(entry, cue, query));
  return matched.length > 0 ? matched : [];
}

function resolveApproximateActReference(
  snap: TaxonomySnapshot,
  signal: string
): { entry: ActEntry; score: number } | null {
  const cue = normalizeActReferenceCue(signal);
  if (!cue) return null;

  const signalTokens = buildReferenceTokens(signal).filter((token) => normalizeActReferenceCue(token) !== cue);
  if (signalTokens.length === 0) return null;
  const signalCompact = compactKey(signal);

  let best: { entry: ActEntry; score: number } | null = null;
  let secondScore = 0;

  for (const entry of snap.acts.values()) {
    let entryBestScore = 0;
    for (const text of getActReferenceTexts(entry)) {
      const textCue =
        normalizeActReferenceCue(text) ??
        normalizeActReferenceCue(entry.document_type) ??
        normalizeActReferenceCue(entry.document_type_slug);
      if (!areActReferenceCuesCompatible(cue, textCue, signal)) continue;

      const candidateTokens = buildReferenceTokens(text).filter((token) => normalizeActReferenceCue(token) !== cue);
      if (candidateTokens.length === 0) continue;

      let exactMatches = 0;
      let softMatches = 0;
      for (const token of signalTokens) {
        if (candidateTokens.includes(token)) {
          exactMatches += 1;
          continue;
        }
        if (candidateTokens.some((candidate) => tokensSoftMatch(token, candidate))) {
          softMatches += 1;
        }
      }
      if (exactMatches + softMatches < 2) continue;

      const candidateCompact = compactKey(text);
      const compactContainment =
        signalCompact &&
        candidateCompact &&
        (candidateCompact.includes(signalCompact) || signalCompact.includes(candidateCompact))
          ? 0.6
          : 0;
      const score = 1.4 + exactMatches * 1.1 + softMatches * 0.65 + compactContainment;
      if (score > entryBestScore) entryBestScore = score;
    }

    if (entryBestScore <= 0) continue;
    if (!best || entryBestScore > best.score) {
      secondScore = best?.score ?? secondScore;
      best = { entry, score: entryBestScore };
    } else if (entryBestScore > secondScore) {
      secondScore = entryBestScore;
    }
  }

  if (!best) return null;
  if (best.score < APPROX_REFERENCE_MIN_SCORE) return null;
  if (best.score - secondScore < APPROX_REFERENCE_MIN_MARGIN) return null;
  return best;
}

let legislationClient: SupabaseClient | null = null;
let snapshot: TaxonomySnapshot | null = null;
let nextRefreshAt = 0;

function getLegislationClient(): SupabaseClient | null {
  const url = config.supabaseLegislationUrl?.trim();
  const key = config.supabaseLegislationServiceKey?.trim();
  if (!url || !key) return null;
  if (!legislationClient) {
    legislationClient = createClient(url, key, { auth: { persistSession: false } });
  }
  return legislationClient;
}

async function loadSnapshot(): Promise<TaxonomySnapshot | null> {
  const client = getLegislationClient();
  if (!client) return null;

  const { data, error } = await client
    .from(LEGISLATION_TABLE)
    .select(
      'rada_nreg, title, summary, category, storage_category, document_type, document_type_slug, aliases, keywords, topics, validity_status'
      + ', document_number, rada_datred'
    )
    .eq('qdrant_status', 'indexed');

  if (error) {
    incrementTaxonomyRefreshFailed();
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  const byStructuredId = new Map<string, ActEntry[]>();
  const byNumericStem = new Map<string, ActEntry[]>();
  const byAlias = new Map<string, ActEntry[]>();
  const byAliasExact = new Map<string, ActEntry[]>();
  const byKeyword = new Map<string, ActEntry[]>();
  const byTopic = new Map<string, ActEntry[]>();
  const byTitle = new Map<string, ActEntry[]>();
  const byTitleExact = new Map<string, ActEntry[]>();
  const bySummary = new Map<string, ActEntry[]>();
  const byCategory = new Map<string, ActEntry[]>();
  const byStorageCategory = new Map<string, ActEntry[]>();
  const byDocumentType = new Map<string, ActEntry[]>();
  const byDocumentTypeSlug = new Map<string, ActEntry[]>();
  const byRecurringSeriesKey = new Map<string, ActEntry[]>();
  const acts = new Map<string, ActEntry>();

  function normDocType(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim().replace(/\s+/g, ' ');
    return s || null;
  }

  for (const row of rows) {
    const rada_nreg = typeof row?.rada_nreg === 'string' ? row.rada_nreg.trim() : '';
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    const aliases = uniqueStrings([
      ...tolerantNormalizeToStrings(row?.aliases),
      ...deriveRuntimeTitleAliases(
        typeof row?.title === 'string' ? row.title.trim() : '',
        row?.document_type != null ? String(row.document_type).trim() : null
      ),
    ]);
    const summary = typeof row?.summary === 'string' ? row.summary.trim() : null;
    const category = row?.category != null ? String(row.category).trim() : null;
    const storage_category =
      row?.storage_category != null ? String(row.storage_category).trim() : null;
    const document_type = normDocType(row?.document_type);
    const document_type_slug =
      row?.document_type_slug != null ? String(row.document_type_slug).trim() : null;
    const document_number =
      row?.document_number != null ? String(row.document_number).trim() : null;
    const rada_datred = normalizeRadaDatred(row?.rada_datred);
    const validity_status =
      row?.validity_status != null ? String(row.validity_status).trim().toLowerCase() : null;
    if (!rada_nreg) continue;

    const entry: ActEntry = {
      rada_nreg,
      title,
      aliases,
      summary,
      category,
      storage_category,
      document_type,
      document_type_slug,
      document_number,
      rada_datred,
      validity_status,
    };
    const titledDocument = document_type && title ? `${document_type} ${title}` : '';
    acts.set(rada_nreg, entry);
    addToMap(byStructuredId, normalizeActIdentifier(rada_nreg), entry);
    const numericStem = extractPrimaryNumericStem(rada_nreg);
    if (numericStem) addToMap(byNumericStem, numericStem, entry);

    for (const a of aliasSignals(aliases)) addToMap(byAlias, a, entry);
    for (const alias of aliases) {
      addToMap(byAliasExact, alias, entry);
      if (looksLikeStructuredActIdentifier(alias)) {
        addToMap(byStructuredId, normalizeActIdentifier(alias), entry);
      }
    }
    for (const keyword of metadataSignals(row?.keywords, { includePhrases: true })) {
      addToMap(byKeyword, keyword, entry);
    }
    for (const topic of metadataSignals(row?.topics, { includePhrases: true })) {
      addToMap(byTopic, topic, entry);
    }
    for (const titleSignal of metadataSignals(title, { includePhrases: true })) {
      addToMap(byTitle, titleSignal, entry);
    }
    for (const titleSignal of metadataSignals(titledDocument, { includePhrases: true })) {
      addToMap(byTitle, titleSignal, entry);
    }
    if (title) addToMap(byTitleExact, title, entry);
    if (titledDocument) addToMap(byTitleExact, titledDocument, entry);
    for (const summarySignal of metadataSignals(summary, { includePhrases: false })) {
      addToMap(bySummary, summarySignal, entry);
    }
    if (category) addToMap(byCategory, category, entry);
    if (storage_category) addToMap(byStorageCategory, storage_category, entry);
    if (document_type) addToMap(byDocumentType, document_type, entry);
    if (document_type_slug) addToMap(byDocumentTypeSlug, document_type_slug, entry);
    const recurringSeriesKey = buildRecurringSeriesKey(entry);
    if (recurringSeriesKey) addToMap(byRecurringSeriesKey, recurringSeriesKey, entry);
  }

  incrementTaxonomyRefreshSuccess();
  const loadedAt = Date.now();
  setTaxonomySnapshotAgeSeconds(0);

  return {
    byStructuredId,
    byNumericStem,
    byAlias,
    byAliasExact,
    byKeyword,
    byTopic,
    byTitle,
    byTitleExact,
    bySummary,
    byCategory,
    byStorageCategory,
    byDocumentType,
    byDocumentTypeSlug,
    byRecurringSeriesKey,
    acts,
    version: loadedAt,
    loadedAt,
  };
}

async function ensureSnapshot(): Promise<TaxonomySnapshot | null> {
  const now = Date.now();
  const ttlMs = (config.actTaxonomyTtlSec ?? 3600) * 1000;
  if (snapshot && now < nextRefreshAt) return snapshot;
  const fresh = await loadSnapshot();
  if (fresh) {
    snapshot = fresh;
    nextRefreshAt = now + ttlMs;
    return snapshot;
  }
  if (snapshot) {
    setTaxonomySnapshotAgeSeconds((now - snapshot.loadedAt) / 1000);
    return snapshot;
  }
  return null;
}

export interface TaxonomyCandidatesInput {
  query: string;
  /** Domain from query_profile (e.g. "criminal") — used as hint only, no hardcoded mapping. */
  domainHint?: string;
  /** U2 lldbi: categories_ranked_top3 — inject acts from byCategory for each. */
  categoryHints?: string[];
  /** U2 lldbi: document_types_ranked_top3 — inject acts from byDocumentType for each. */
  documentTypeHints?: string[];
  /** U2 entities: act_abbrev, law_title, article_ref for scoring. */
  entities?: { act_abbrev?: string; law_title?: string; article_ref?: string }[];
}

export interface AliasHit {
  rada_nreg: string;
  title: string;
  alias: string;
  category?: string | null;
}

export interface TaxonomyHintsUsed {
  categories_used: string[];
  document_types_used: string[];
  injected_counts: { by_domain: number; by_category_hints: number; by_doc_type_hints: number };
}

export interface TaxonomyCandidatesResult {
  rada_nreg_candidates: string[];
  category_hints: string[];
  alias_hits: AliasHit[];
  exact_act_hit_count: number;
  exact_act_nregs: string[];
  grounded_act_hit_count: number;
  grounded_act_nregs: string[];
  anchor_tokens: string[];
  taxonomy_hints_used?: TaxonomyHintsUsed;
  debug: {
    taxonomy_snapshot_version: number | null;
    taxonomy_snapshot_age_seconds: number | null;
    source: 'supabase' | 'none';
  };
}

/**
 * Get act candidates from taxonomy: alias/keyword/topic match from DB; domain and category as metadata hints; entities for scoring.
 * No hardcoded categories or act names.
 */
const DOMAIN_CATEGORY_BOOST = 1;
const KEYWORD_MATCH_BOOST = 1.25;
const TOPIC_MATCH_BOOST = 1;
const MAX_DOMAIN_ACTS = 15;
const MAX_HINTS_INJECTED_TOTAL = 30;
const HINTS_TOP_K_PER_KEY = 10;

export async function getTaxonomyCandidates(
  input: TaxonomyCandidatesInput
): Promise<TaxonomyCandidatesResult> {
  const { query, domainHint, categoryHints = [], documentTypeHints = [], entities = [] } = input;
  const empty: TaxonomyCandidatesResult = {
    rada_nreg_candidates: [],
    category_hints: domainHint ? [domainHint] : [],
    alias_hits: [],
    exact_act_hit_count: 0,
    exact_act_nregs: [],
    grounded_act_hit_count: 0,
    grounded_act_nregs: [],
    anchor_tokens: [],
    debug: { taxonomy_snapshot_version: null, taxonomy_snapshot_age_seconds: null, source: 'none' },
  };

  const snap = await ensureSnapshot();
  if (!snap) {
    if (domainHint) empty.category_hints = [domainHint];
    return empty;
  }

  const now = Date.now();
  const ageSec = (now - snap.loadedAt) / 1000;
  setTaxonomySnapshotAgeSeconds(ageSec);

  const radaNregScores = new Map<string, number>();
  const aliasHits: AliasHit[] = [];
  const metadataMatchedNregs = new Set<string>();
  const exactActHitNregs = new Set<string>();
  const groundedActHitNregs = new Set<string>();
  const categoryHintsSet = new Set<string>();
  for (const familyKey of getCompatibleDomainCategoryKeys(domainHint)) {
    if (familyKey) categoryHintsSet.add(familyKey);
  }

  const { tokens, phrases } = buildTaxonomyQuerySignals(query);
  const phraseSet = new Set(phrases);
  const seenAliasHits = new Set<string>();

  const pushAliasHit = (entry: ActEntry, alias: string): void => {
    const key = `${entry.rada_nreg}::${toKey(alias)}`;
    if (seenAliasHits.has(key)) return;
    seenAliasHits.add(key);
    aliasHits.push({
      rada_nreg: entry.rada_nreg,
      title: entry.title,
      alias,
      category: entry.category,
    });
  };

  const exactStructuredSignals = uniqueStrings([
    ...extractStructuredActIdentifiers(query),
    ...entities
      .map((entity) => entity?.act_abbrev?.trim())
      .filter((value): value is string => !!value && looksLikeStructuredActIdentifier(value))
      .map((value) => normalizeActIdentifier(value)),
  ]);

  for (const signal of exactStructuredSignals) {
    const key = normalizeActIdentifier(signal);
    for (const entry of snap.byStructuredId.get(key) ?? []) {
      exactActHitNregs.add(entry.rada_nreg);
      groundedActHitNregs.add(entry.rada_nreg);
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + EXACT_IDENTIFIER_MATCH_BOOST
      );
      pushAliasHit(entry, signal);
      if (entry.category) categoryHintsSet.add(entry.category);
    }
  }

  const cuedNumericReferences = extractCuedNumericActReferences(query);
  for (const reference of cuedNumericReferences) {
    if (reference.numericStem.length < 3) continue;
    let candidates = (snap.byNumericStem.get(reference.numericStem) ?? []).filter((entry) =>
      entryMatchesActCue(entry, reference.cue)
    );
    if (candidates.length > 1) {
      const resolved = resolveCuedNumericReferenceAmbiguity(candidates, reference, query);
      if (resolved) candidates = [resolved];
    }
    if (candidates.length !== 1) continue;
    const [entry] = candidates;
    groundedActHitNregs.add(entry.rada_nreg);
    radaNregScores.set(
      entry.rada_nreg,
      (radaNregScores.get(entry.rada_nreg) ?? 0) + EXACT_IDENTIFIER_MATCH_BOOST * 0.85
    );
    pushAliasHit(entry, reference.rawReference);
    if (entry.category) categoryHintsSet.add(entry.category);
  }

  const actReferenceSignals = extractActReferenceSignals(query);
  const quotedTitleSignals = uniqueStrings([
    ...extractQuotedActTitleFragments(query),
    ...actReferenceSignals.flatMap((signal) => extractQuotedActTitleFragments(signal)),
    ...entities.flatMap((entity) => extractQuotedActTitleFragments(entity?.law_title ?? '')),
  ]);
  const exactTextSignals = uniqueStrings([
    query,
    ...actReferenceSignals,
    ...quotedTitleSignals,
    ...entities.map((entity) => entity?.act_abbrev),
    ...entities.map((entity) => entity?.law_title),
  ]);
  const exactAliasGroundingSignals = uniqueStrings([
    ...tokens,
    ...phrases.filter((phrase) => buildReferenceTokens(phrase).length <= 3),
    ...entities.map((entity) => entity?.act_abbrev),
  ]);
  const queryIdentitySignals = collectQueryDocumentIdentitySignals(exactTextSignals);
  for (const signal of exactTextSignals) {
    const key = toKey(signal);
    if (!key) continue;
    let groundedEntries = [
      ...new Map(
        [...(snap.byAliasExact.get(key) ?? []), ...(snap.byTitleExact.get(key) ?? [])].map((entry) => [
          entry.rada_nreg,
          entry,
        ] as const)
      ).values(),
    ];
    groundedEntries = filterGroundingEntriesByRequestedCue(groundedEntries, signal, query);
    if (groundedEntries.length === 0) continue;
    if (groundedEntries.length > 1) {
      const resolvedEntry = resolveExactTextGroundingAmbiguity(groundedEntries, signal, query);
      if (resolvedEntry) {
        groundedEntries = [resolvedEntry];
      } else {
        const familyRepresentative = resolveLogicalActFamilyRepresentative(groundedEntries, signal, query);
        if (familyRepresentative) groundedEntries = [familyRepresentative];
      }
    }
    if (groundedEntries.length !== 1) continue;
    const [entry] = groundedEntries;
    groundedActHitNregs.add(entry.rada_nreg);
    radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + ALIAS_PHRASE_BOOST);
    pushAliasHit(entry, signal);
    if (entry.category) categoryHintsSet.add(entry.category);
  }

  for (const signal of exactAliasGroundingSignals) {
    const key = toKey(signal);
    if (!key) continue;
    let groundedEntries = filterGroundingEntriesByRequestedCue(snap.byAliasExact.get(key) ?? [], signal, query, {
      allowActReferenceSignalFallback: false,
      allowQueryLevelCueFallback: false,
    });
    if (groundedEntries.length === 0) continue;
    if (groundedEntries.length > 1) {
      const resolvedEntry = resolveExactTextGroundingAmbiguity(groundedEntries, signal, query);
      if (resolvedEntry) {
        groundedEntries = [resolvedEntry];
      } else {
        const familyRepresentative = resolveLogicalActFamilyRepresentative(groundedEntries, signal, query);
        if (familyRepresentative) groundedEntries = [familyRepresentative];
      }
    }
    if (groundedEntries.length !== 1) continue;
    const [entry] = groundedEntries;
    exactActHitNregs.add(entry.rada_nreg);
    groundedActHitNregs.add(entry.rada_nreg);
    radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + ALIAS_PHRASE_BOOST);
    pushAliasHit(entry, signal);
    if (entry.category) categoryHintsSet.add(entry.category);
  }

  const compactTitleGroundingSignals = uniqueStrings([
    ...quotedTitleSignals,
    ...actReferenceSignals,
    ...entities.map((entity) => entity?.law_title),
    ...(looksLikeCompactActTitleFragmentQuery(query, { includeRulesLikeTitles: true }) ? [query] : []),
  ]);
  const fallbackTitleGroundingSignals = uniqueStrings([
    ...(
      queryIdentitySignals.documentNumbers.size > 0 ||
      queryIdentitySignals.exactDates.size > 0 ||
      queryIdentitySignals.monthKeys.size > 0
        ? [query]
        : []
    ),
    ...phrases.filter((phrase) => isCompactTitleGroundingPhraseCandidate(phrase)),
  ]);
  if (groundedActHitNregs.size === 0) {
    for (const signal of [...compactTitleGroundingSignals, ...fallbackTitleGroundingSignals]) {
      const groundedEntries = filterGroundingEntriesByRequestedCue(
        resolveTitleFragmentGroundingEntries(snap, signal, query),
        signal,
        query
      );
      if (groundedEntries.length !== 1) continue;
      const [entry] = groundedEntries;
      groundedActHitNregs.add(entry.rada_nreg);
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + TITLE_FRAGMENT_GROUNDED_BOOST
      );
      pushAliasHit(entry, signal);
      if (entry.category) categoryHintsSet.add(entry.category);
    }
  }

  if (groundedActHitNregs.size === 0) {
    for (const signal of exactTextSignals) {
      if (shouldSkipApproximateActReferenceGrounding(signal)) continue;
      const resolved = resolveApproximateActReference(snap, signal);
      if (!resolved) continue;
      groundedActHitNregs.add(resolved.entry.rada_nreg);
      radaNregScores.set(
        resolved.entry.rada_nreg,
        (radaNregScores.get(resolved.entry.rada_nreg) ?? 0) + APPROX_REFERENCE_GROUNDING_BOOST
      );
      pushAliasHit(resolved.entry, signal);
      if (resolved.entry.category) categoryHintsSet.add(resolved.entry.category);
    }
  }

  const applyMetadataMatches = (
    signal: string,
    options: {
      aliasBoost: number;
      keywordBoost: number;
      topicBoost: number;
      titleBoost: number;
      summaryBoost: number;
    }
  ): void => {
    const key = toKey(signal);
    if (!key) return;
    for (const entry of snap.byAlias.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.aliasBoost
      );
      metadataMatchedNregs.add(entry.rada_nreg);
      pushAliasHit(entry, signal);
    }
    for (const entry of snap.byKeyword.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.keywordBoost
      );
      metadataMatchedNregs.add(entry.rada_nreg);
      if (entry.category) categoryHintsSet.add(entry.category);
    }
    for (const entry of snap.byTopic.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.topicBoost
      );
      metadataMatchedNregs.add(entry.rada_nreg);
      if (entry.category) categoryHintsSet.add(entry.category);
    }
    for (const entry of snap.byTitle.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.titleBoost
      );
      metadataMatchedNregs.add(entry.rada_nreg);
      if (entry.category) categoryHintsSet.add(entry.category);
    }
    for (const entry of snap.bySummary.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.summaryBoost
      );
      metadataMatchedNregs.add(entry.rada_nreg);
      if (entry.category) categoryHintsSet.add(entry.category);
    }
  };

  for (const phrase of phrases) {
    applyMetadataMatches(phrase, {
      aliasBoost: ALIAS_PHRASE_BOOST,
      keywordBoost: KEYWORD_PHRASE_BOOST,
      topicBoost: TOPIC_PHRASE_BOOST,
      titleBoost: TITLE_MATCH_BOOST,
      summaryBoost: SUMMARY_MATCH_BOOST,
    });
  }

  for (const token of tokens) {
    if (phraseSet.has(token)) continue;
    applyMetadataMatches(token, {
      aliasBoost: 2,
      keywordBoost: KEYWORD_MATCH_BOOST,
      topicBoost: TOPIC_MATCH_BOOST,
      titleBoost: TITLE_MATCH_BOOST * 0.6,
      summaryBoost: SUMMARY_MATCH_BOOST,
    });
  }

  for (const e of entities) {
    const abbrev = e?.act_abbrev?.trim();
    if (abbrev) {
      const key = toKey(abbrev);
      for (const entry of snap.byAlias.get(key) ?? []) {
        radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + 3);
        pushAliasHit(entry, abbrev);
      }
    }
  }

  const injectedByDomain: string[] = [];
  const injectedByCategoryHints: string[] = [];
  const injectedByDocTypeHints: string[] = [];
  const categoriesUsed: string[] = [];
  const documentTypesUsed: string[] = [];

  // Domain-based act injection (cap K=15, compatible procedure families included for soft legal queries)
  const compatibleDomainKeys = getCompatibleDomainCategoryKeys(domainHint);
  for (const [index, domainKey] of compatibleDomainKeys.entries()) {
    const boost = index === 0 ? DOMAIN_CATEGORY_BOOST : DOMAIN_CATEGORY_BOOST * 0.85;
    for (const entry of snap.byCategory.get(toKey(domainKey)) ?? []) {
      if (injectedByDomain.length >= MAX_DOMAIN_ACTS) break;
      if (injectedByDomain.includes(entry.rada_nreg)) continue;
      injectedByDomain.push(entry.rada_nreg);
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + boost
      );
    }
    if (injectedByDomain.length >= MAX_DOMAIN_ACTS) break;
  }

  // Category hints injection (U2 lldbi.categories_ranked_top3)
  let hintsBudget = MAX_HINTS_INJECTED_TOTAL - injectedByDomain.length;
  const seenHints = new Set<string>();
  for (const hint of categoryHints) {
    if (hintsBudget <= 0) break;
    const key = toKey(hint);
    if (!key) continue;
    const entries = snap.byCategory.get(key) ?? [];
    if (entries.length > 0) categoriesUsed.push(hint);
    let added = 0;
    for (const entry of entries) {
      if (added >= HINTS_TOP_K_PER_KEY || hintsBudget <= 0) break;
      if (seenHints.has(entry.rada_nreg)) continue;
      seenHints.add(entry.rada_nreg);
      injectedByCategoryHints.push(entry.rada_nreg);
      radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + DOMAIN_CATEGORY_BOOST);
      added++;
      hintsBudget--;
    }
  }

  // Document type hints injection (U2 lldbi.document_types_ranked_top3)
  for (const hint of documentTypeHints) {
    if (hintsBudget <= 0) break;
    const key = toKey(hint);
    if (!key) continue;
    const entries = snap.byDocumentType.get(key) ?? snap.byDocumentTypeSlug.get(key) ?? [];
    if (entries.length > 0) documentTypesUsed.push(hint);
    let added = 0;
    for (const entry of entries) {
      if (added >= HINTS_TOP_K_PER_KEY || hintsBudget <= 0) break;
      if (seenHints.has(entry.rada_nreg)) continue;
      seenHints.add(entry.rada_nreg);
      injectedByDocTypeHints.push(entry.rada_nreg);
      radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + DOMAIN_CATEGORY_BOOST);
      added++;
      hintsBudget--;
    }
  }

  if (categoriesUsed.length > 0) addU4TaxonomyCategoryHintsUsed(categoriesUsed.length);
  if (documentTypesUsed.length > 0) addU4TaxonomyDocTypeHintsUsed(documentTypesUsed.length);
  const totalHintsInjected = injectedByCategoryHints.length + injectedByDocTypeHints.length;
  if (totalHintsInjected > 0) addU4TaxonomyHintsInjectedActs(totalHintsInjected);

  if (
    queryIdentitySignals.documentNumbers.size > 0 ||
    queryIdentitySignals.exactDates.size > 0 ||
    queryIdentitySignals.monthKeys.size > 0
  ) {
    for (const [radaNreg, currentScore] of radaNregScores.entries()) {
      const entry = snap.acts.get(radaNreg);
      if (!entry) continue;
      const resolvedIdentity = scoreEntryResolvedDocumentIdentity(entry, queryIdentitySignals);
      const recurringSeriesIdentity = metadataMatchedNregs.has(radaNreg)
        ? scoreRecurringSeriesDateIdentity(snap, entry, queryIdentitySignals, resolvedIdentity.reasons)
        : { score: 0, reasons: [] };
      if (resolvedIdentity.score === 0 && recurringSeriesIdentity.score === 0) continue;
      radaNregScores.set(radaNreg, currentScore + resolvedIdentity.score + recurringSeriesIdentity.score);
    }
  }

  for (const hit of aliasHits) {
    if (hit.category) categoryHintsSet.add(hit.category);
  }
  const categoryHintsOut = [...categoryHintsSet];

  const sorted = [...radaNregScores.entries()].sort((a, b) => b[1] - a[1]);
  const rada_nreg_candidates = sorted.map(([nreg]) => nreg);

  // Anchor tokens: alias-hit aliases only (structural, data-driven from DB).
  // Title-word fallback removed: appending act title words to the embedding query is a lexical
  // prior that can bias semantic retrieval toward the act name rather than the article content.
  const anchorTokens: string[] = [];
  const seenNreg = new Set<string>();
  const addAnchor = (value: string | null | undefined): void => {
    const short = typeof value === 'string' ? value.trim() : '';
    if (!short) return;
    const compact = short.length <= 90 ? short : short.slice(0, 87) + '...';
    if (!compact || anchorTokens.includes(compact)) return;
    anchorTokens.push(compact);
  };
  for (const hit of aliasHits) {
    if (anchorTokens.length >= MAX_ANCHOR_TOKENS) break;
    if (!groundedActHitNregs.has(hit.rada_nreg)) continue;
    addAnchor(hit.title);
  }
  for (const hit of aliasHits) {
    if (anchorTokens.length >= MAX_ANCHOR_TOKENS) break;
    if (groundedActHitNregs.size > 0 && !groundedActHitNregs.has(hit.rada_nreg)) continue;
    if (seenNreg.has(hit.rada_nreg)) continue;
    seenNreg.add(hit.rada_nreg);
    addAnchor(hit.alias.length <= 50 ? hit.alias : hit.alias.slice(0, 47) + '...');
  }

  const taxonomy_hints_used: TaxonomyHintsUsed = {
    categories_used: categoriesUsed,
    document_types_used: documentTypesUsed,
    injected_counts: {
      by_domain: injectedByDomain.length,
      by_category_hints: injectedByCategoryHints.length,
      by_doc_type_hints: injectedByDocTypeHints.length,
    },
  };

  return {
    rada_nreg_candidates,
    category_hints: categoryHintsOut,
    alias_hits: aliasHits.slice(0, 20),
    exact_act_hit_count: exactActHitNregs.size,
    exact_act_nregs: [...exactActHitNregs],
    grounded_act_hit_count: groundedActHitNregs.size,
    grounded_act_nregs: [...groundedActHitNregs],
    anchor_tokens: anchorTokens.slice(0, MAX_ANCHOR_TOKENS),
    taxonomy_hints_used,
    debug: {
      taxonomy_snapshot_version: snap.version,
      taxonomy_snapshot_age_seconds: Math.round(ageSec * 10) / 10,
      source: 'supabase',
    },
  };
}

export interface ActMeta {
  rada_nreg: string;
  title: string;
  summary?: string | null;
  category: string | null;
  storage_category?: string | null;
  document_type: string | null;
  document_type_slug?: string | null;
  document_number?: string | null;
  rada_datred?: string | null;
  validity_status?: string | null;
}

/** Get act metadata by rada_nreg (from snapshot; no DB write). */
export async function getActMeta(rada_nreg: string): Promise<ActMeta | null> {
  const snap = await ensureSnapshot();
  if (!snap) return null;
  const entry = snap.acts.get(rada_nreg.trim());
  if (!entry) return null;
  return {
    rada_nreg: entry.rada_nreg,
    title: entry.title,
    summary: entry.summary,
    category: entry.category,
    storage_category: entry.storage_category,
    document_type: entry.document_type,
    document_type_slug: entry.document_type_slug,
    document_number: entry.document_number,
    rada_datred: entry.rada_datred,
    validity_status: entry.validity_status,
  };
}

/** Resolve act by alias (exact key match in taxonomy). Returns rada_nreg[]. */
export async function findActByAlias(alias: string): Promise<string[]> {
  const snap = await ensureSnapshot();
  if (!snap) return [];
  const structuredKey = normalizeActIdentifier(alias);
  const exactEntries =
    looksLikeStructuredActIdentifier(alias) && structuredKey
      ? snap.byStructuredId.get(structuredKey) ?? []
      : [];
  const key = toKey(alias);
  if (!key && exactEntries.length === 0) return [];
  const entries = [...exactEntries, ...(snap.byAlias.get(key) ?? [])];
  return [...new Set(entries.map((e) => e.rada_nreg))].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve an explicit quoted title fragment to rada_nreg[] using indexed act titles only.
 * This is intentionally narrower than the removed title-based routing heuristics:
 * it exists solely for reference expansion of already-extracted quoted legal titles.
 */
export async function findActByTitleFragment(fragment: string, query?: string): Promise<string[]> {
  const snap = await ensureSnapshot();
  if (!snap) return [];
  return resolveTitleFragmentGroundingEntries(snap, fragment, query).map((entry) => entry.rada_nreg);
}

/** Find act candidates by alias token overlap (structural only). Returns rada_nreg[]. */
export async function findCandidatesByAliasTokens(tokens: string[]): Promise<string[]> {
  const snap = await ensureSnapshot();
  if (!snap) return [];
  const scores = new Map<string, number>();
  for (const t of tokens) {
    const key = toKey(t);
    if (!key) continue;
    for (const entry of snap.byAlias.get(key) ?? []) {
      scores.set(entry.rada_nreg, (scores.get(entry.rada_nreg) ?? 0) + 2);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([nreg]) => nreg);
}

export interface ActCandidateScore {
  score: number;
  reasons: string[];
}

/** Score one act candidate by query tokens and domain hint (no DB write). */
export async function scoreActCandidate(
  rada_nreg: string,
  querySignals: string[],
  domainHint?: string
): Promise<ActCandidateScore> {
  const snap = await ensureSnapshot();
  if (!snap) return { score: 0, reasons: [] };
  const entry = snap.acts.get(rada_nreg.trim());
  if (!entry) return { score: 0, reasons: [] };
  let score = 0;
  const reasons: string[] = [];
  const signals = [...new Set(querySignals.map((signal) => toKey(signal)).filter(Boolean))];
  const documentIdentity = scoreEntryResolvedDocumentIdentity(
    entry,
    collectQueryDocumentIdentitySignals(querySignals)
  );
  score += documentIdentity.score;
  for (const reason of documentIdentity.reasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  for (const key of signals) {
    if (!key) continue;
    const isPhrase = key.includes(' ');
    for (const e of snap.byStructuredId.get(normalizeActIdentifier(key)) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += EXACT_IDENTIFIER_MATCH_BOOST;
        if (!reasons.includes('exact_identifier_match')) reasons.push('exact_identifier_match');
      }
    }
    for (const e of snap.byAliasExact.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += ALIAS_PHRASE_BOOST;
        if (!reasons.includes('exact_alias_match')) reasons.push('exact_alias_match');
      }
    }
    for (const e of snap.byTitleExact.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += TITLE_MATCH_BOOST;
        if (!reasons.includes('exact_title_match')) reasons.push('exact_title_match');
      }
    }
    for (const e of snap.byAlias.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? ALIAS_PHRASE_BOOST : 2;
        if (!reasons.includes('alias_match')) reasons.push('alias_match');
      }
    }
    for (const e of snap.byKeyword.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? KEYWORD_PHRASE_BOOST : KEYWORD_MATCH_BOOST;
        if (!reasons.includes('keyword_match')) reasons.push('keyword_match');
      }
    }
    for (const e of snap.byTopic.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? TOPIC_PHRASE_BOOST : TOPIC_MATCH_BOOST;
        if (!reasons.includes('topic_match')) reasons.push('topic_match');
      }
    }
    for (const e of snap.byTitle.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? TITLE_MATCH_BOOST : TITLE_MATCH_BOOST * 0.6;
        if (!reasons.includes('title_match')) reasons.push('title_match');
      }
    }
    for (const e of snap.bySummary.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += SUMMARY_MATCH_BOOST;
        if (!reasons.includes('summary_match')) reasons.push('summary_match');
      }
    }
  }
  if (domainHint && entry.category && categoryMatchesDomainEnvelope(entry.category, domainHint)) {
    score += CATEGORY_HINT_SCORE_BOOST;
    reasons.push('category_hint');
  }
  if (entry.validity_status === 'in_force') {
    score += VALIDITY_IN_FORCE_BOOST;
    reasons.push('validity_in_force');
  } else if (entry.validity_status === 'expired' || entry.validity_status === 'not_in_force') {
    score -= VALIDITY_STALE_PENALTY;
    reasons.push('validity_penalty');
  }
  const recurringSeriesIdentity = scoreRecurringSeriesDateIdentity(
    snap,
    entry,
    collectQueryDocumentIdentitySignals(querySignals),
    reasons
  );
  score += recurringSeriesIdentity.score;
  for (const reason of recurringSeriesIdentity.reasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { score, reasons };
}
