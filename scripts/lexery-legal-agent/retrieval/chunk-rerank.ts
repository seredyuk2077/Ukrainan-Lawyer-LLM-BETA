import type { RawHit } from './types.js';

const QUERY_STOPWORDS = new Set([
  'а',
  'або',
  'але',
  'в',
  'від',
  'де',
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
  'про',
  'та',
  'те',
  'таке',
  'тому',
  'у',
  'чи',
  'що',
  'щодо',
  'яка',
  'яке',
  'який',
  'які',
  'як',
]);

function normalizeToken(token: string): string {
  return token
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’`ʼ]/g, '')
    .replace(/[^a-zа-яіїєґ0-9-]/giu, '')
    .trim();
}

function tokenize(text: string | null | undefined): string[] {
  const source = typeof text === 'string' ? text : '';
  return source
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .map(normalizeToken)
    .filter((token) => token.length >= 2);
}

function softTokenMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 5 || right.length < 5) return false;
  const shared = Math.min(left.length, right.length);
  let prefixLen = 0;
  while (prefixLen < shared && left[prefixLen] === right[prefixLen]) {
    prefixLen += 1;
  }
  return prefixLen >= 5;
}

function collectInformativeTokens(text: string): string[] {
  return tokenize(text).filter((token) => token.length >= 3 && !QUERY_STOPWORDS.has(token));
}

function countOverlap(queryTokens: string[], titleTokens: string[]): number {
  let overlap = 0;
  const usedTitleIdx = new Set<number>();
  for (const queryToken of queryTokens) {
    const matchedIdx = titleTokens.findIndex(
      (titleToken, idx) => !usedTitleIdx.has(idx) && softTokenMatch(queryToken, titleToken)
    );
    if (matchedIdx >= 0) {
      overlap += 1;
      usedTitleIdx.add(matchedIdx);
    }
  }
  return overlap;
}

export function getHitOrderingScore(hit: RawHit): number {
  const orderingScore = hit.ordering_score;
  if (typeof orderingScore === 'number' && Number.isFinite(orderingScore)) return orderingScore;
  const vectorScore = hit.score;
  return typeof vectorScore === 'number' && Number.isFinite(vectorScore) ? vectorScore : 0;
}

export function compareHitsByOrderingScore(a: RawHit, b: RawHit): number {
  const oa = getHitOrderingScore(a);
  const ob = getHitOrderingScore(b);
  if (ob !== oa) return ob - oa;
  const sa = typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : 0;
  const sb = typeof b.score === 'number' && Number.isFinite(b.score) ? b.score : 0;
  if (sb !== sa) return sb - sa;
  const na = (a.rada_nreg ?? '').trim();
  const nb = (b.rada_nreg ?? '').trim();
  if (na !== nb) return na.localeCompare(nb);
  const ra = (a.r2_key ?? '').trim();
  const rb = (b.r2_key ?? '').trim();
  if (ra !== rb) return ra.localeCompare(rb);
  const ja = (a.json_path ?? '').trim();
  const jb = (b.json_path ?? '').trim();
  return ja.localeCompare(jb);
}

export function getChunkTitle(hit: RawHit): string {
  const metadata = hit.metadata as Record<string, unknown> | undefined;
  const chunkTitle = metadata?.chunk_title;
  return typeof chunkTitle === 'string' ? chunkTitle : '';
}

export function getChunkUnitType(hit: RawHit): string | null {
  const metadata = hit.metadata as Record<string, unknown> | undefined;
  const unitType = metadata?.unit_type;
  return typeof unitType === 'string' && unitType.trim().length > 0 ? unitType : null;
}

export function computeChunkStructuralScore(hit: RawHit, query: string): number {
  const queryTokens = collectInformativeTokens(query);
  const chunkTitle = getChunkTitle(hit);
  const titleTokens = collectInformativeTokens(chunkTitle);
  const overlap = queryTokens.length > 0 && titleTokens.length > 0 ? countOverlap(queryTokens, titleTokens) : 0;
  const coverage = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
  const precision = titleTokens.length > 0 ? overlap / titleTokens.length : 0;
  const titleF1 =
    coverage > 0 && precision > 0 ? (2 * coverage * precision) / (coverage + precision) : 0;
  const titleIsQuerySubset =
    titleTokens.length > 0 && titleTokens.every((titleToken) => queryTokens.some((queryToken) => softTokenMatch(queryToken, titleToken)))
      ? 1
      : 0;
  const unitType = getChunkUnitType(hit);
  const articleShapeBoost = unitType === 'article' ? 0.05 : unitType === 'point' ? 0.02 : 0;
  const articleNumberBoost = hit.article_number ? 0.03 : 0;
  const zeroOverlapPenalty = queryTokens.length > 0 && titleTokens.length > 0 && overlap === 0 ? -0.35 : 0;
  return zeroOverlapPenalty + articleShapeBoost + articleNumberBoost + titleF1 * 0.32 + titleIsQuerySubset * 0.32;
}
