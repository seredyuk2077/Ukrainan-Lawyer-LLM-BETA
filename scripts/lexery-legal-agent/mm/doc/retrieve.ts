import { getMmDocCanonical, getMmDocChunkText } from './r2.js';
import { searchMmDocsSemantic } from './qdrant.js';
import type { MmDocScopeType, MmDocSearchHit } from './types.js';
import {
  listMmDocsForScope,
  type MmDocScopeAvailability,
} from './store.js';
import { isMmDocCanonicalKeyForRecord } from '../../lib/r2-keys.js';
import { inferExplicitMmDocScope } from '../../lib/queryScopeHints.js';

export interface MmDocRetrievedSnippet extends MmDocSearchHit {
  text: string;
}

interface RankedResolvedHit extends MmDocRetrievedSnippet {
  overlapCount: number;
  overlapRatio: number;
  blendedScore: number;
}

type QueryDocFormatHint = 'pdf' | 'rtf' | 'spreadsheet' | 'image' | 'word';

export interface MmDocSearchScope {
  scopeType: MmDocScopeType;
  scopeId: string | null;
}

const MM_DOC_FALLBACK_MAX_DOCS = 8;
const MM_DOC_FALLBACK_MAX_CHUNKS_PER_DOC = 2;
const MM_DOC_SEMANTIC_FALLBACK_MIN_SCORE = 0.88;

const LEXICAL_STOPWORDS = new Set([
  'і',
  'й',
  'та',
  'або',
  'але',
  'що',
  'це',
  'як',
  'який',
  'яка',
  'яке',
  'які',
  'про',
  'у',
  'в',
  'на',
  'за',
  'до',
  'від',
  'чи',
  'не',
  'так',
  'то',
  'для',
  'з',
  'із',
  'зі',
  'по',
  'при',
  'без',
  'над',
  'під',
  'між',
  'а',
  'the',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'by',
  'at',
  'as',
  'an',
  'a',
]);

function tokenizeLexical(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => !LEXICAL_STOPWORDS.has(token))
    .filter((token) => token.length > 1 || /\d/.test(token));
}

function inferQueryDocFormatHint(queryText: string): QueryDocFormatHint | null {
  const normalized = queryText.toLowerCase();
  if (/\brtf\b/.test(normalized)) return 'rtf';
  if (/\bpdf\b/.test(normalized)) return 'pdf';
  if (/\bxlsx\b|\bexcel\b|\bcsv\b|таблиц|spreadsheet/i.test(queryText)) return 'spreadsheet';
  if (/зображенн|скан|картин|image|\bpng\b|\bjpe?g\b|\bwebp\b/i.test(queryText)) return 'image';
  if (/\bdocx\b|\bdoc\b|word/i.test(normalized)) return 'word';
  return null;
}

function filenameMatchesQueryDocFormat(filename: string | undefined, hint: QueryDocFormatHint | null): boolean {
  if (!filename || !hint) return false;
  const normalized = filename.toLowerCase();
  switch (hint) {
    case 'pdf':
      return normalized.endsWith('.pdf');
    case 'rtf':
      return normalized.endsWith('.rtf');
    case 'spreadsheet':
      return normalized.endsWith('.xlsx') || normalized.endsWith('.xls') || normalized.endsWith('.csv');
    case 'image':
      return ['.png', '.jpg', '.jpeg', '.webp'].some((ext) => normalized.endsWith(ext));
    case 'word':
      return normalized.endsWith('.docx') || normalized.endsWith('.doc');
    default:
      return false;
  }
}

export function getMmDocLexicalOverlapCount(params: {
  queryText: string;
  snippetText: string;
}): number {
  const queryTokens = Array.from(new Set(tokenizeLexical(params.queryText)));
  if (queryTokens.length === 0) return 0;
  const snippetTokens = new Set(tokenizeLexical(params.snippetText));
  let overlapCount = 0;
  for (const token of queryTokens) {
    if (snippetTokens.has(token)) overlapCount++;
  }
  return overlapCount;
}

export function isMmDocHitLexicallyRelevant(params: {
  queryText: string;
  snippetText: string;
  semanticScore: number;
  scopeType?: MmDocScopeType;
}): boolean {
  // Legacy export name kept for unit coverage; production ranking now uses lexical overlap
  // as a bonus and allows a strong semantic fallback when the wording differs.
  const overlapCount = getMmDocLexicalOverlapCount({
    queryText: params.queryText,
    snippetText: params.snippetText,
  });
  if (overlapCount === 0 && tokenizeLexical(params.queryText).length === 0) return true;
  if (overlapCount > 0) return true;
  return params.semanticScore >= MM_DOC_SEMANTIC_FALLBACK_MIN_SCORE;
}

function sortHitsByScore(hits: MmDocSearchHit[]): MmDocSearchHit[] {
  return [...hits].sort((a, b) => b.score - a.score);
}

function dedupeHitsByOrder(hits: MmDocSearchHit[]): MmDocSearchHit[] {
  const seen = new Set<string>();
  const out: MmDocSearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.doc_id}::${hit.json_path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function dedupeRetrievedSnippetsByOrder(hits: MmDocRetrievedSnippet[]): MmDocRetrievedSnippet[] {
  const seen = new Set<string>();
  const out: MmDocRetrievedSnippet[] = [];
  for (const hit of hits) {
    const key = `${hit.doc_id}::${hit.json_path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function getMmDocScopePriority(scopeType: MmDocScopeType, preferredScope: MmDocScopeType | null = null): number {
  if (preferredScope != null) {
    if (scopeType === preferredScope) return 4;
    if (scopeType === 'conversation') return 3;
    if (scopeType === 'project') return 2;
    return 1;
  }
  switch (scopeType) {
    case 'project':
      return 3;
    case 'conversation':
      return 2;
    case 'user_global':
    default:
      return 1;
  }
}

async function resolveScopeHits(params: {
  queryText: string;
  hits: MmDocSearchHit[];
  topK: number;
  tenantId: string | null;
  userId: string;
}): Promise<MmDocRetrievedSnippet[]> {
  const prefetchLimit = Math.max(params.topK * 3, 12);
  const deduped = dedupeHitsByOrder(sortHitsByScore(params.hits)).slice(0, prefetchLimit);
  const resolved = await Promise.all(
    deduped.map(async (hit) => {
      if (
        !isMmDocCanonicalKeyForRecord({
          tenantId: params.tenantId,
          userId: params.userId,
          scopeType: hit.scope_type,
          scopeId: hit.scope_id,
          docId: hit.doc_id,
          r2Key: hit.r2_key,
        })
      ) {
        return null;
      }
      const text = await getMmDocChunkText(hit.r2_key, hit.json_path);
      return text ? { ...hit, text } : null;
    })
  );
  const ranked = rankMmDocResolvedHitsForQuery(
    params.queryText,
    resolved.filter((row): row is MmDocRetrievedSnippet => row != null)
  );
  return ranked
    .slice(0, params.topK)
    .map(({ overlapCount: _overlapCount, ...row }) => row);
}

function compareRankedResolvedHits(a: RankedResolvedHit, b: RankedResolvedHit): number {
  if (b.blendedScore !== a.blendedScore) return b.blendedScore - a.blendedScore;
  if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
  if (b.score !== a.score) return b.score - a.score;
  if ((a.text?.length ?? 0) !== (b.text?.length ?? 0)) return (a.text?.length ?? 0) - (b.text?.length ?? 0);
  return a.chunk_index - b.chunk_index;
}

export function rankMmDocResolvedHitsForQuery(
  queryText: string,
  hits: MmDocRetrievedSnippet[]
): RankedResolvedHit[] {
  const preferredScope = inferExplicitMmDocScope(queryText);
  const formatHint = inferQueryDocFormatHint(queryText);
  const queryTokens = Array.from(new Set(tokenizeLexical(queryText)));
  const queryTokenCount = queryTokens.length;
  const ranked = hits
    .map((row) => {
      const overlapCount = getMmDocLexicalOverlapCount({
        queryText,
        snippetText: row.text,
      });
      const overlapRatio = queryTokenCount > 0 ? overlapCount / queryTokenCount : 0;
      const scopeBonus = getMmDocScopePriority(row.scope_type, preferredScope) * 0.01;
      const formatBonus = filenameMatchesQueryDocFormat(row.filename, formatHint) ? 0.08 : 0;
      const blendedScore = row.score * 0.75 + overlapRatio * 0.25 + scopeBonus + formatBonus;
      return {
        ...row,
        overlapCount,
        overlapRatio,
        blendedScore,
      };
    })
    .filter((row) =>
      isMmDocHitLexicallyRelevant({
        queryText,
        snippetText: row.text,
        semanticScore: row.score,
        scopeType: row.scope_type,
      })
    )
    .sort(compareRankedResolvedHits);
  if (formatHint == null) return ranked;
  const formatMatched = ranked.filter((row) => filenameMatchesQueryDocFormat(row.filename, formatHint));
  return formatMatched.length > 0 ? formatMatched : ranked;
}

function rankFallbackResolvedHits(
  queryText: string,
  hits: MmDocRetrievedSnippet[]
): RankedResolvedHit[] {
  const preferredScope = inferExplicitMmDocScope(queryText);
  const formatHint = inferQueryDocFormatHint(queryText);
  const queryTokens = Array.from(new Set(tokenizeLexical(queryText)));
  const queryTokenCount = queryTokens.length;
  const ranked = hits
    .map((row) => {
      const overlapCount = getMmDocLexicalOverlapCount({
        queryText,
        snippetText: row.text,
      });
      const overlapRatio = queryTokenCount > 0 ? overlapCount / queryTokenCount : 0;
      const formatBonus = filenameMatchesQueryDocFormat(row.filename, formatHint) ? 0.08 : 0;
      const blendedScore =
        row.score * 0.75 + overlapRatio * 0.25 + getMmDocScopePriority(row.scope_type, preferredScope) * 0.01 + formatBonus;
      return {
        ...row,
        overlapCount,
        overlapRatio,
        blendedScore,
      };
    })
    .filter((row) => row.overlapCount > 0)
    .sort((a, b) => {
      if (b.blendedScore !== a.blendedScore) return b.blendedScore - a.blendedScore;
      if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
      const scopeDelta = getMmDocScopePriority(b.scope_type, preferredScope) - getMmDocScopePriority(a.scope_type, preferredScope);
      if (scopeDelta !== 0) return scopeDelta;
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk_index - b.chunk_index;
    });
  if (formatHint == null) return ranked;
  const formatMatched = ranked.filter((row) => filenameMatchesQueryDocFormat(row.filename, formatHint));
  return formatMatched.length > 0 ? formatMatched : ranked;
}

export function resolveMmDocSearchScopes(params: {
  queryText?: string;
  requestedScope?: MmDocScopeType | null;
  conversationId?: string | null;
  projectId?: string | null;
  availability?: MmDocScopeAvailability | null;
}): MmDocSearchScope[] {
  const scopesByType = new Map<MmDocScopeType, MmDocSearchScope>();
  const availability = params.availability ?? null;
  const preferredScope = params.requestedScope ?? inferExplicitMmDocScope(params.queryText ?? '');

  if (params.conversationId && (availability == null || availability.conversation)) {
    scopesByType.set('conversation', {
      scopeType: 'conversation',
      scopeId: params.conversationId,
    });
  }

  if (params.projectId && (availability == null || availability.project)) {
    scopesByType.set('project', {
      scopeType: 'project',
      scopeId: params.projectId,
    });
  }

  if (availability == null || availability.user_global) {
    scopesByType.set('user_global', {
      scopeType: 'user_global',
      scopeId: null,
    });
  }

  const order: MmDocScopeType[] =
    preferredScope != null
      ? [preferredScope, 'conversation', 'project', 'user_global']
      : ['conversation', 'project', 'user_global'];
  const scopes: MmDocSearchScope[] = [];
  const seen = new Set<MmDocScopeType>();
  for (const scopeType of order) {
    if (seen.has(scopeType)) continue;
    seen.add(scopeType);
    const scope = scopesByType.get(scopeType);
    if (scope) scopes.push(scope);
  }
  return scopes;
}

export function mergeMmDocScopeResults(params: {
  queryText: string;
  resolvedByScope: Array<{ scope: MmDocSearchScope; hits: MmDocRetrievedSnippet[] }>;
  topK: number;
  scopedHitThreshold?: number;
}): MmDocRetrievedSnippet[] {
  const topK = Math.max(1, params.topK);
  const scopedHitThreshold = Math.max(1, Math.min(topK, params.scopedHitThreshold ?? 4));
  const merged: MmDocRetrievedSnippet[] = [];
  const seen = new Set<string>();

  for (const { scope, hits } of params.resolvedByScope) {
    if (scope.scopeType === 'user_global' && merged.length >= scopedHitThreshold) {
      break;
    }
    for (const hit of hits) {
      const key = `${hit.doc_id}::${hit.json_path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
  }

  return rankMmDocResolvedHitsForQuery(params.queryText, merged)
    .slice(0, topK)
    .map(({ overlapCount: _overlapCount, ...row }) => row);
}

export async function fallbackRetrieveMmDocsForQuery(params: {
  queryText: string;
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
  topK: number;
}): Promise<MmDocRetrievedSnippet[]> {
  const queryTokens = Array.from(new Set(tokenizeLexical(params.queryText)));
  if (queryTokens.length === 0) return [];

  const records = await listMmDocsForScope({
    tenantId: params.tenantId,
    userId: params.userId,
    conversationId: params.conversationId ?? null,
    projectId: params.projectId ?? null,
  });
  const fallbackCandidates = (
    await Promise.all(
      records.slice(0, MM_DOC_FALLBACK_MAX_DOCS).map(async (record) => {
        if (!record.canonical_r2_key) return [];
        if (
          !isMmDocCanonicalKeyForRecord({
            tenantId: record.tenant_id,
            userId: record.user_id,
            scopeType: record.scope_type,
            scopeId: record.scope_id,
            docId: record.id,
            r2Key: record.canonical_r2_key,
          })
        ) {
          return [];
        }
        const canonical = await getMmDocCanonical(record.canonical_r2_key);
        const rankedChunks = canonical.content.chunks
          .map((chunk) => ({
            chunk,
            overlapCount: getMmDocLexicalOverlapCount({
              queryText: params.queryText,
              snippetText: chunk.text,
            }),
          }))
          .filter((row) => row.overlapCount > 0)
          .sort((a, b) => b.overlapCount - a.overlapCount || a.chunk.chunk_index - b.chunk.chunk_index)
          .slice(0, MM_DOC_FALLBACK_MAX_CHUNKS_PER_DOC);

        return rankedChunks.map(({ chunk, overlapCount }) => ({
          id: `${record.id}:${chunk.chunk_index}`,
          score:
            overlapCount / queryTokens.length +
            getMmDocScopePriority(record.scope_type) * 0.01,
          doc_id: record.id,
          chunk_index: chunk.chunk_index,
          r2_key: record.canonical_r2_key!,
          json_path: `$.content.chunks[${chunk.chunk_index}].text`,
          scope_type: record.scope_type,
          scope_id: record.scope_id,
          filename: record.original_filename,
          title: undefined,
          preview: chunk.text.slice(0, 160),
          text: chunk.text,
        }));
      })
    )
  ).flat();

  return rankFallbackResolvedHits(params.queryText, fallbackCandidates)
    .slice(0, params.topK)
    .map(({ overlapCount: _overlapCount, ...row }) => row);
}

export async function retrieveMmDocsForQuery(params: {
  queryText: string;
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
  requestedScope?: MmDocScopeType | null;
  runId?: string;
  topK?: number;
  availability?: MmDocScopeAvailability | null;
}): Promise<MmDocRetrievedSnippet[]> {
  const topK = params.topK ?? 8;
  const formatHint = inferQueryDocFormatHint(params.queryText);
  const scopes = resolveMmDocSearchScopes({
    queryText: params.queryText,
    requestedScope: params.requestedScope ?? null,
    conversationId: params.conversationId ?? null,
    projectId: params.projectId ?? null,
    availability: params.availability ?? null,
  });

  const resolvedByScope = await Promise.all(
    scopes.map(async (scope) => {
      const hits = await searchMmDocsSemantic({
        queryText: params.queryText,
        tenantId: params.tenantId,
        userId: params.userId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        topK,
        runId: params.runId,
      });
      const resolved = dedupeRetrievedSnippetsByOrder(
        await resolveScopeHits({
          queryText: params.queryText,
          hits,
          topK,
          tenantId: params.tenantId,
          userId: params.userId,
        })
      );
      return { scope, hits: resolved };
    })
  );

  const merged = mergeMmDocScopeResults({
    queryText: params.queryText,
    resolvedByScope,
    topK,
  });
  const fallback = async () =>
    await fallbackRetrieveMmDocsForQuery({
      queryText: params.queryText,
      tenantId: params.tenantId,
      userId: params.userId,
      conversationId: params.conversationId ?? null,
      projectId: params.projectId ?? null,
      topK,
    });
  if (merged.length > 0) {
    if (
      formatHint != null &&
      !merged.some((hit) => filenameMatchesQueryDocFormat(hit.filename, formatHint))
    ) {
      const fallbackHits = await fallback();
      if (fallbackHits.some((hit) => filenameMatchesQueryDocFormat(hit.filename, formatHint))) {
        return fallbackHits;
      }
    }
    return merged;
  }

  return await fallback();
}
