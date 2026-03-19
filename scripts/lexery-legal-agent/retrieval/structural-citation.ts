import type { RawHit } from './types.js';

type HitMetadata = Record<string, unknown> | undefined;

export interface QueryCitationSelectors {
  article?: string | null;
  articlePart?: string | null;
  point?: string | null;
  subpoint?: string | null;
  paragraph?: string | null;
  note?: string | null;
  noteMentioned: boolean;
  explicitSelectorCount: number;
}

function hitMetadata(hit: Pick<RawHit, 'metadata'>): HitMetadata {
  return hit.metadata as HitMetadata;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCitationValue(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[\s()]+/g, '')
    .trim();
}

export function normalizeCitationPath(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(query: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match?.[1]) {
      const normalized = readString(match[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function normalizeSelectorSyntax(query: string): string {
  return query
    .normalize('NFC')
    .replace(/п\.\s*п\.?/giu, 'пп.')
    .replace(/ч\.\s*ч\.?/giu, 'чч.');
}

export function extractQueryCitationSelectors(query: string): QueryCitationSelectors {
  const normalizedQuery = normalizeSelectorSyntax(query);
  const article = firstMatch(normalizedQuery, [
    /(?:^|[\s\W])ст(?:атт(?:я|і|ю|ею)?)?\.?\s*([0-9]+[0-9a-zа-яіїєґ-]*)(?:[\s\W]|$)/iu,
  ]);
  const articlePart = firstMatch(normalizedQuery, [
    /(?:^|[\s\W])ч(?:ч|астин(?:а|и|і|ою)?)?\.?\s*([0-9]+[0-9a-zа-яіїєґ-]*)(?:[\s\W]|$)/iu,
  ]);
  const point = firstMatch(normalizedQuery, [
    /(?:^|[\s\W])(?<!п)п(?!п)(?:ункт(?:а|у|ом|і)?)?\.?\s*([0-9]+(?:[.\-][0-9a-zа-яіїєґ]+)*)(?:[\s\W]|$)/iu,
  ]);
  const subpoint = firstMatch(normalizedQuery, [
    /(?:^|[\s\W])пп\.?\s*([0-9]+(?:[.\-][0-9a-zа-яіїєґ]+)*)(?:[\s\W]|$)/iu,
    /(?:^|[\s\W])підпункт(?:а|у|ом|і)?\s*([0-9]+(?:[.\-][0-9a-zа-яіїєґ]+)*)(?:[\s\W]|$)/iu,
  ]);
  const paragraph = firstMatch(normalizedQuery, [
    /(?:^|[\s\W])абз(?:ац(?:у|ом|і)?)?\.?\s*([0-9]+[0-9a-zа-яіїєґ-]*)(?:[\s\W]|$)/iu,
  ]);
  const note = firstMatch(normalizedQuery, [
    /(?:^|[\s\W])примітк(?:а|и|у|ою|ці)(?:\s*№)?\s*([0-9]+[0-9a-zа-яіїєґ-]*)(?:[\s\W]|$)/iu,
  ]);
  const noteMentioned = note != null || /(?:^|[\s\W])примітк(?:а|и|у|ою|ці)(?:[\s\W]|$)/iu.test(normalizedQuery);
  const explicitSelectorCount =
    [article, articlePart, point, subpoint, paragraph].filter(Boolean).length + (note ? 1 : 0);
  return {
    article,
    articlePart,
    point,
    subpoint,
    paragraph,
    note,
    noteMentioned,
    explicitSelectorCount,
  };
}

export interface HitCitationSelectors {
  article?: string | null;
  articlePart?: string | null;
  point?: string | null;
  subpoint?: string | null;
  paragraph?: string | null;
  note?: string | null;
  citationPath?: string | null;
  unstructuredFallback: boolean;
}

export function getHitCitationSelectors(
  hit: Pick<
    RawHit,
    | 'article_number'
    | 'unit_number'
    | 'unit_type'
    | 'citation_path'
    | 'article_part_number'
    | 'point_number'
    | 'subpoint_number'
    | 'paragraph_number'
    | 'note_number'
    | 'unstructured_fallback'
    | 'metadata'
  >
): HitCitationSelectors {
  const metadata = hitMetadata(hit);
  const unitType = readString(hit.unit_type) ?? readString(metadata?.unit_type);
  const article = readString(hit.article_number) ?? readString(metadata?.article_number);
  const articlePart =
    readString(hit.article_part_number) ?? readString(metadata?.article_part_number);
  const point =
    readString(hit.point_number) ??
    (unitType === 'point' ? readString(hit.unit_number) : null) ??
    readString(metadata?.point_number) ??
    (unitType === 'point' ? readString(metadata?.unit_number) : null);
  const subpoint =
    readString(hit.subpoint_number) ??
    (unitType === 'subpoint' ? readString(hit.unit_number) : null) ??
    readString(metadata?.subpoint_number);
  const paragraph = readString(hit.paragraph_number) ?? readString(metadata?.paragraph_number);
  const citationPath = readString(hit.citation_path) ?? readString(metadata?.citation_path);
  const note =
    readString(hit.note_number) ??
    readString(metadata?.note_number) ??
    firstMatch(citationPath ?? '', [/(?:^|[\s\W])примітк(?:а|и|у|ою|ці)\s*([0-9]+[0-9a-zа-яіїєґ-]*)(?:[\s\W]|$)/iu]);
  const unstructuredFallback =
    hit.unstructured_fallback === true || metadata?.unstructured_fallback === true;

  return {
    article,
    articlePart,
    point,
    subpoint,
    paragraph,
    note,
    citationPath,
    unstructuredFallback,
  };
}

export function buildCitationPathFromSelectors(selectors: HitCitationSelectors): string | null {
  const parts: string[] = [];
  if (selectors.article) {
    parts.push(`ст. ${selectors.article}`);
    if (selectors.articlePart) parts.push(`ч. ${selectors.articlePart}`);
    if (selectors.point) parts.push(`п. ${selectors.point}`);
    if (selectors.subpoint) parts.push(`пп. ${selectors.subpoint}`);
    if (selectors.paragraph) parts.push(`абз. ${selectors.paragraph}`);
  } else if (selectors.point) {
    parts.push(`п. ${selectors.point}`);
    if (selectors.subpoint) parts.push(`пп. ${selectors.subpoint}`);
    if (selectors.paragraph) parts.push(`абз. ${selectors.paragraph}`);
  }
  if (selectors.note) parts.push(`примітка ${selectors.note}`);
  if (parts.length === 0) return null;
  return parts.join(' ');
}

export function buildHitCitationPath(
  hit: Pick<
    RawHit,
    | 'article_number'
    | 'unit_number'
    | 'unit_type'
    | 'citation_path'
    | 'article_part_number'
    | 'point_number'
    | 'subpoint_number'
    | 'paragraph_number'
    | 'note_number'
    | 'unstructured_fallback'
    | 'metadata'
  >
): string | null {
  const selectors = getHitCitationSelectors(hit);
  if (selectors.citationPath) return selectors.citationPath;
  return buildCitationPathFromSelectors(selectors);
}

export function buildHitCitationKey(
  hit: Pick<
    RawHit,
    | 'article_number'
    | 'unit_number'
    | 'unit_type'
    | 'citation_path'
    | 'article_part_number'
    | 'point_number'
    | 'subpoint_number'
    | 'paragraph_number'
    | 'note_number'
    | 'unstructured_fallback'
    | 'metadata'
  >
): string | null {
  const citationPath = buildHitCitationPath(hit);
  if (citationPath) return normalizeCitationPath(citationPath);

  const selectors = getHitCitationSelectors(hit);
  if (selectors.unstructuredFallback) return null;
  const parts: string[] = [];
  if (selectors.article) parts.push(`article:${normalizeCitationValue(selectors.article)}`);
  if (selectors.articlePart) parts.push(`part:${normalizeCitationValue(selectors.articlePart)}`);
  if (selectors.point) parts.push(`point:${normalizeCitationValue(selectors.point)}`);
  if (selectors.subpoint) parts.push(`subpoint:${normalizeCitationValue(selectors.subpoint)}`);
  if (selectors.paragraph) parts.push(`paragraph:${normalizeCitationValue(selectors.paragraph)}`);
  if (selectors.note) parts.push(`note:${normalizeCitationValue(selectors.note)}`);
  if (parts.length > 0) return parts.join('|');
  return null;
}

export function countCitationMatches(query: QueryCitationSelectors, hit: HitCitationSelectors): number {
  let matches = 0;
  if (query.article && hit.article && normalizeCitationValue(query.article) === normalizeCitationValue(hit.article)) matches += 1;
  if (query.articlePart && hit.articlePart && normalizeCitationValue(query.articlePart) === normalizeCitationValue(hit.articlePart)) matches += 1;
  if (query.point && hit.point && normalizeCitationValue(query.point) === normalizeCitationValue(hit.point)) matches += 1;
  if (query.subpoint && hit.subpoint && normalizeCitationValue(query.subpoint) === normalizeCitationValue(hit.subpoint)) matches += 1;
  if (query.paragraph && hit.paragraph && normalizeCitationValue(query.paragraph) === normalizeCitationValue(hit.paragraph)) matches += 1;
  if (query.note && hit.note && normalizeCitationValue(query.note) === normalizeCitationValue(hit.note)) matches += 1;
  else if (
    query.noteMentioned &&
    hit.note &&
    (query.article || query.articlePart || query.point || query.subpoint || query.paragraph)
  ) {
    matches += 1;
  }
  return matches;
}
