/**
 * Focus Spec — deterministic "Answer Focus Plan" before generation (DEV RUN v14).
 * Ensures the system (not only the model) focuses on 1–2 primary norms and required output structure.
 */
import type { LawSourceRef } from '../lib/pipeline/contracts.js';
import type { AssembledPrompt } from '../lib/pipeline/contracts.js';
import { config } from '../lib/config.js';
import { hasExplicitLegalReferenceRequest, isExplicitUserDocumentQuery } from '../lib/queryScopeHints.js';

export type TaskType = 'crime_composition' | 'citation_only' | 'general' | 'memory_recall';

export interface FocusSpec {
  taskType: TaskType;
  /** Best-guess primary norm source id (r2_key::json_path) from evidence. */
  primaryNormSourceId: string | null;
  /** Confidence in primary norm match (low when fallback to top-scored). */
  primaryNormConfidence: 'high' | 'low';
  requiredSections: string[];
  maxLawSnippets: number;
  citationStyle: string;
  bannedPhrases: string[];
  tone: string;
}

export interface FocusSpecBuildOptions {
  mmDocsOnlyPlan?: boolean;
}

const BANNED_PHRASES_DEFAULT = [
  'надані матеріали',
  'наданих матеріалів',
  'надані в контексті матеріали',
  'матеріали користувача',
];
const CITATION_STYLE = 'ua_dstu_npa';
const TONE = 'юридична українська';

/** Detect task type from user question (deterministic). */
function detectTaskType(query: string): TaskType {
  const q = query.toLowerCase();
  if (/склад\s+злочину|склад\s+правопорушення|ч\.\s*1\s*ст\.?|стаття\s+\d+/.test(q)) return 'crime_composition';
  if (/наведи\s+статтю|цитат|посилання\s+на\s+норму/.test(q)) return 'citation_only';
  return 'general';
}

/** Generic comparison-like query (no domain wordlists). */
function isComparisonLikeQuery(query: string): boolean {
  const q = query.toLowerCase();
  if (/різниц|відрізня/.test(q)) return true;
  if (/коли\s+.*\s+а\s+коли|між\s+.*\s+і\s+/.test(q)) return true;
  if (/\bvs\.?\b|проти\s/.test(q)) return true;
  return false;
}

/** Multi-part question: has question mark and conjunction/split (generic). */
function isMultiPartQuery(query: string): boolean {
  if (!query.includes('?')) return false;
  const q = query.toLowerCase();
  return /(\s+та\s+|\s+і\s+|\s+або\s+|\s+чи\s+|[,\/])/.test(q);
}

/**
 * Score a snippet for relevance to query. Data-driven only: no domain/topic wordlists.
 * Uses: normRef presence, article-number match (extract digits from query), heading token overlap.
 */
function scoreSnippetForQuery(
  _sourceId: string,
  ref: LawSourceRef,
  queryLower: string
): number {
  let score = 0;
  const norm = ref.normRef;
  if (!norm) return 0;

  score += 1; // has normRef (structural signal)

  const articleNum =
    norm.articleNumber ??
    (ref.article_number != null ? parseInt(String(ref.article_number), 10) : null);
  if (articleNum != null && !Number.isNaN(articleNum)) {
    const b = '(?<![0-9])';
    const e = '(?![0-9])';
    const num = String(articleNum).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const queryArticleMatch = queryLower.match(
      new RegExp(`ст\\.?\\s*${b}${num}${e}|${b}${num}${e}\\s*кк|статт[яі]\\s*${b}${num}${e}`, 'i')
    );
    if (queryArticleMatch) score += 5;
  }

  if (norm.heading && typeof norm.heading === 'string') {
    const headingLower = norm.heading.toLowerCase();
    const headingWords = headingLower.replace(/[^\p{L}\d\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
    const queryTokens = queryLower.replace(/[^\p{L}\d\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 1);
    const minPrefixLen = 4;
    const overlap = queryTokens.filter((t) =>
      headingWords.some((h) => {
        if (t.includes(h) || h.includes(t)) return true;
        let i = 0;
        while (i < t.length && i < h.length && t[i] === h[i]) i++;
        return i >= minPrefixLen;
      })
    ).length;
    if (overlap > 0) score += Math.min(overlap, 3);
  }

  return score;
}

/** Context mode from U2/routing: law / memory / mixed (memory recall = memory-only). */
export type ContextModeForFocus = 'law' | 'memory' | 'mixed';

export function resolveFocusContextMode(params: {
  rawContextMode?: ContextModeForFocus;
  docCount?: number | null;
  memoryCount?: number | null;
}): ContextModeForFocus | undefined {
  if (
    params.rawContextMode === 'memory' &&
    (params.docCount ?? 0) > 0 &&
    (params.memoryCount ?? 0) === 0
  ) {
    return undefined;
  }
  return params.rawContextMode;
}

/**
 * Build FocusSpec from user question, assembled meta, and gate decision.
 * Deterministic: prefers snippet whose heading/article match query keywords.
 * When contextMode === 'memory': taskType = memory_recall, maxLawSnippets = 0.
 */
export function buildFocusSpec(
  userQuestion: string,
  assembledMeta: AssembledPrompt['meta'],
  gateExpand: boolean,
  contextMode?: ContextModeForFocus,
  options?: FocusSpecBuildOptions
): FocusSpec {
  const docCount = assembledMeta?.sources?.docCount ?? 0;
  const preferDocEvidence =
    (options?.mmDocsOnlyPlan === true ||
      (docCount > 0 && isExplicitUserDocumentQuery(userQuestion))) &&
    !hasExplicitLegalReferenceRequest(userQuestion);
  const memoryRecall = contextMode === 'memory' && !preferDocEvidence;
  const taskType: FocusSpec['taskType'] = memoryRecall ? 'memory_recall' : detectTaskType(userQuestion);
  const queryLower = userQuestion.toLowerCase();

  const lawRefs = assembledMeta?.lawSourceRefs ?? [];
  const lawIndex = assembledMeta?.lawIndex ?? {};

  let primaryNormSourceId: string | null = null;
  let primaryNormConfidence: 'high' | 'low' = 'low';

  const PRIMARY_CONFIDENCE_THRESHOLD = 2;
  if (lawRefs.length > 0) {
    const scored = lawRefs.map((ref) => {
      const sid = `${ref.r2_key}::${ref.json_path}`;
      return { sid, ref, score: scoreSnippetForQuery(sid, ref, queryLower) };
    });
    scored.sort((a, b) => b.score - a.score);
    const topScore = scored[0].score;
    primaryNormConfidence = topScore >= PRIMARY_CONFIDENCE_THRESHOLD ? 'high' : 'low';
    primaryNormSourceId = primaryNormConfidence === 'high' ? scored[0].sid : null;
  }

  const requiredSections: string[] = [];
  if (taskType === 'crime_composition') {
    requiredSections.push('NormQuote', 'Composition', 'Sanction');
  } else if (taskType === 'citation_only') {
    requiredSections.push('NormQuote', 'Quote');
  }

  // Dynamic maxLawSnippets: memory_recall -> 0; mixed -> config.mixedModeLawMaxSnippets (cap); comparison/gateExpand -> 6; crime_composition -> 4; general -> 4
  let maxLawSnippets = 4;
  if (taskType === 'memory_recall') {
    maxLawSnippets = 0;
  } else if (preferDocEvidence) {
    maxLawSnippets = 0;
  } else if (contextMode === 'mixed') {
    const baseMixed = gateExpand || isComparisonLikeQuery(userQuestion) || isMultiPartQuery(userQuestion) ? 6 : 4;
    maxLawSnippets = Math.min(config.mixedModeLawMaxSnippets, baseMixed);
  } else if (taskType === 'crime_composition') {
    maxLawSnippets = 4;
  } else if (gateExpand || isComparisonLikeQuery(userQuestion) || isMultiPartQuery(userQuestion)) {
    maxLawSnippets = 6;
  }

  return {
    taskType,
    primaryNormSourceId,
    primaryNormConfidence,
    requiredSections,
    maxLawSnippets,
    citationStyle: CITATION_STYLE,
    bannedPhrases: BANNED_PHRASES_DEFAULT,
    tone: TONE,
  };
}

/**
 * Enforce focus on law parts: ensure primary norm is included, slice to maxLawSnippets.
 * Call after triage (or when triage skipped). Non-law parts unchanged.
 */
export function enforceFocusOnContextParts(
  contextParts: Array<{ type: string; text: string; sourceIds: string[]; sourceRef?: unknown }>,
  focusSpec: FocusSpec
): typeof contextParts {
  const lawParts = contextParts.filter((p) => p.type === 'law');
  const otherParts = contextParts.filter((p) => p.type !== 'law');
  if (lawParts.length === 0) return contextParts;

  const maxN = focusSpec.maxLawSnippets;
  let selected = lawParts;
  if (focusSpec.primaryNormSourceId && focusSpec.primaryNormConfidence === 'high') {
    const primaryId = focusSpec.primaryNormSourceId;
    const primaryPart = lawParts.find(
      (p) => p.sourceIds?.length >= 2 && `${p.sourceIds[0]}::${p.sourceIds[1]}` === primaryId
    );
    if (primaryPart) {
      const rest = lawParts.filter((p) => p !== primaryPart);
      selected = [primaryPart, ...rest].slice(0, maxN);
    } else {
      selected = lawParts.slice(0, maxN);
    }
  } else {
    selected = lawParts.slice(0, maxN);
  }
  return [...selected, ...otherParts];
}
