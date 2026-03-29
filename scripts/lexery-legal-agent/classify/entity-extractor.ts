/**
 * [U2c] Entity Extractor — regex/abbrev (LEX-85)
 */
import type { ExtractedEntity } from './types.js';
import { looksLikeStructuredActIdentifier, normalizeStructuredActIdentifier } from '../lib/structured-act-identifier.js';

const ACT_ABBREVS: Record<string, string> = {
  ККУ: 'Кримінальний кодекс України',
  ЦКУ: 'Цивільний кодекс України',
  КЗпП: 'Кодекс законів про працю України',
  КПК: 'Кримінальний процесуальний кодекс України',
  КАС: 'Кодекс адміністративного судочинства України',
  ПКУ: 'Податковий кодекс України',
  Конституція: 'Конституція України',
};

const AUTHORITIES = [
  'МВС', 'СБУ', 'ДПС', 'НБУ', 'РНБО', 'КМУ', 'ВРУ', 'ОГПУ', 'НАЗК', 'АМКУ', 'МОЗ',
];

const NON_LEGAL_ENTITY_ABBREVIATIONS = new Set(['ТОВ', 'АТ', 'ПАТ', 'ПРАТ', 'ПП', 'ФОП', 'ДП']);

// ст. 115, стаття 115, ст 115, ст.115, ст 115-1 (Cyrillic-safe)
const ARTICLE_REF = /(?:^|[\s\W])(?:ст\.?|стаття|статті|статтю)\s*(\d+(?:-\d+)?)(?:[\s\W]|$)/gi;
// ст.115-1, ст 115¹, стаття 115 з позначкою один
const ARTICLE_REF_SUP = /(?:^|[\s\W])(?:ст\.?|стаття|статті|статтю)\s*(\d+)(?:[-]\d+|\s*[¹²³123]\s*|\s+з\s+позначкою\s+один)(?:[\s\W]|$)/gi;
// ч. 2 ст. 115, частина 1 статті 10
const PART_ARTICLE = /(?:^|[\s\W])(?:ч\.?|частина)\s*(\d+)\s*(?:ст\.?|статті|статтю)\s*(\d+(?:-\d+)?)(?:[\s\W]|$)/gi;
// п. 1 ч. 2 ст. 115, пункт 1 статті 10
const POINT_PART_ARTICLE = /(?:^|[\s\W])(?:п\.?|пункт)\s*(\d+)\s*(?:(?:ч\.?|частини)\s*(\d+)\s*)?(?:ст\.?|статті|статтю)\s*(\d+(?:-\d+)?)(?:[\s\W]|$)/gi;
// ЗУ "Про ..."
const LAW_TITLE = /\bЗУ\s*[«"]\s*Про\s+[^»"]+/gi;
// Generic explicit act-title cues for point/order/procedure style queries.
const GENERIC_LAW_TITLE =
  /(?:^|[\s\W])((?:правил|правила|порядку|порядок|кодексу|кодекс|закону|закон|конституції|конституція|регламенту|регламент|інструкції|інструкція|конвенції|конвенція|указу|указ|постанови|постанова|наказу|наказ|розпорядження|рішення|положення)\s+[^\n,.?!;:]{8,140})(?=$|[\s\W])/giu;
// Short explicit act references with number, e.g. "ПКМ №100", "постанова КМУ №1178", "наказ МОЗ №385".
const SHORT_ACT_REFERENCE =
  /(?:^|[\s\W])((?:(?:пкм|постанова|розпорядження|наказ|рішення|порядок|правила|інструкція|положення|регламент|закон|кодекс|указ)(?:\s+[A-ZА-ЯІЇЄҐ]{2,10})?|[A-ZА-ЯІЇЄҐ]{2,10})\s*№\s*[\d][\p{L}\d/-]{0,20})(?=$|[\s\W])/giu;
const UNICODE_BOUNDARY_CLASS = '[^\\p{L}\\p{N}_]';

function normalizeActToken(token: string): string {
  return normalizeStructuredActIdentifier(
    token
      .normalize('NFC')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .trim()
  );
}

function looksLikeStructuredActReferenceToken(token: string): boolean {
  return looksLikeStructuredActIdentifier(normalizeActToken(token));
}

function buildUnicodeBoundaryRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|${UNICODE_BOUNDARY_CLASS})${escaped}(?=$|${UNICODE_BOUNDARY_CLASS})`, 'iu');
}

function looksLikeCompactLegalActAbbreviation(token: string): boolean {
  const normalized = token.normalize('NFC').trim();
  if (!/^[\p{L}]{3,12}$/u.test(normalized)) return false;
  if (!/[\p{Script=Cyrillic}]/u.test(normalized)) return false;
  if (AUTHORITIES.includes(normalized.toUpperCase())) return false;
  if (NON_LEGAL_ENTITY_ABBREVIATIONS.has(normalized.toUpperCase())) return false;
  const letters = [...normalized];
  const upperCount = letters.filter((char) => /\p{Lu}/u.test(char)).length;
  const lowerCount = letters.filter((char) => /\p{Ll}/u.test(char)).length;
  if (upperCount < 2) return false;
  if (lowerCount === 0 && normalized.length > 6) return false;
  return true;
}

export function extractEntities(query: string): {
  entities: ExtractedEntity[];
  has_direct_citation: boolean;
} {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  const add = (e: ExtractedEntity) => {
    const key = `${e.type}:${e.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push(e);
  };

  const q = query.trim();

  // Act abbreviations (Unicode-safe boundaries; do not treat Cyrillic letters as separators)
  for (const [abbrev, title] of Object.entries(ACT_ABBREVS)) {
    const re = buildUnicodeBoundaryRegex(abbrev);
    if (re.test(q)) {
      add({ type: 'act_abbrev', value: abbrev, norm: { act: title } });
    }
  }

  for (const token of q.match(/[\p{L}]+/gu) ?? []) {
    if (!looksLikeCompactLegalActAbbreviation(token)) continue;
    add({ type: 'act_abbrev', value: token.normalize('NFC') });
  }

  // Article refs (ст. 115, стаття 115, ст 115-1, etc.)
  let m: RegExpExecArray | null;
  let articleRefRegex = new RegExp(ARTICLE_REF.source, 'gi');
  while ((m = articleRefRegex.exec(q)) !== null) {
    add({
      type: 'article_ref',
      value: m[0].trim(),
      norm: { article: m[1], act: undefined },
    });
  }
  // ст. 115-1, 115¹, стаття 115 з позначкою один
  articleRefRegex = new RegExp(ARTICLE_REF_SUP.source, 'gi');
  while ((m = articleRefRegex.exec(q)) !== null) {
    const num = m[1];
    const normArticle = `${num}-1`;
    add({
      type: 'article_ref',
      value: m[0].trim(),
      norm: { article: normArticle, act: undefined },
    });
  }
  // ч. 2 ст. 115
  const partArticleRegex = new RegExp(PART_ARTICLE.source, 'gi');
  while ((m = partArticleRegex.exec(q)) !== null) {
    add({
      type: 'article_ref',
      value: m[0].trim(),
      norm: { article: m[2], part: m[1], act: undefined },
    });
  }
  // п. 1 ч. 2 ст. 115, пункт 1 статті 10
  const pointPartRegex = new RegExp(POINT_PART_ARTICLE.source, 'gi');
  while ((m = pointPartRegex.exec(q)) !== null) {
    const part = m[2] ? `${m[2]}.${m[1]}` : m[1];
    add({
      type: 'article_ref',
      value: m[0].trim(),
      norm: { article: m[3], part, act: undefined },
    });
  }

  // Law title "ЗУ «Про ...»"
  const lawTitleRegex = new RegExp(LAW_TITLE.source, 'gi');
  while ((m = lawTitleRegex.exec(q)) !== null) {
    add({ type: 'law_title', value: m[0].trim() });
  }
  const genericLawTitleRegex = new RegExp(GENERIC_LAW_TITLE.source, 'giu');
  while ((m = genericLawTitleRegex.exec(q)) !== null) {
    add({ type: 'law_title', value: m[1].trim() });
  }
  const shortActReferenceRegex = new RegExp(SHORT_ACT_REFERENCE.source, 'giu');
  while ((m = shortActReferenceRegex.exec(q)) !== null) {
    add({ type: 'law_title', value: m[1].trim() });
  }
  for (const token of q.match(/[\p{L}\p{N}/-]+/gu) ?? []) {
    if (looksLikeStructuredActReferenceToken(token)) {
      add({ type: 'law_title', value: normalizeActToken(token) });
    }
  }

  // Authorities (Cyrillic-safe boundaries)
  for (const auth of AUTHORITIES) {
    const re = buildUnicodeBoundaryRegex(auth);
    if (re.test(q)) {
      add({ type: 'authority', value: auth });
    }
  }

  const has_direct_citation =
    entities.some((e) => e.type === 'article_ref' || e.type === 'act_abbrev');

  return { entities, has_direct_citation };
}
