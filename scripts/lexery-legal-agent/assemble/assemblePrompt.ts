/**
 * U9 Assemble — build AssembledPrompt from RunContext + U4Result + GateDecision (LEX-132)
 *
 * Four channels: law (canonical R2 snippets), docs (MM Docs), memory (RunContext.memory_*), history.
 * Features: dedup, stable ordering, concurrent R2 loading, token budget, rich provenance.
 * See docs/architecture/MEGA_DIAGRAM_FULL.md § U9 Assemble.
 */
import type {
  RunContext,
  U4Result,
  GateDecision,
  AssembledPrompt,
  ContextPart,
  LawSourceRef,
  AssembledPromptBudget,
} from '../lib/pipeline/contracts.js';
import { loadCanonicalSnippet, truncateSnippetText } from '../retrieval/r2-fragment.js';
import { Semaphore } from '../lib/semaphore.js';
import { config } from '../lib/config.js';
import type { RawHit } from '../retrieval/types.js';
import { extractNormRef, normRefSummary } from './normRef.js';
import { metaTriageHits } from './metaTriage.js';
import { getStrongArticleRefsNormalized } from '../lib/articleRefs.js';
import { hasExplicitLegalReferenceRequest, isExplicitUserDocumentQuery } from '../lib/queryScopeHints.js';
import { logger } from '../lib/logger.js';
import { embedQuery, embedMany } from '../retrieval/embedding.js';

const SYSTEM_PROMPT_EVIDENCE_ONLY =
  'You are a legal assistant. Answer only using the provided evidence (laws, memory, dialogue). ' +
  'Do not invent sources. Cite the law article when available. ' +
  'If there is no sufficient data in the context, say so clearly.';

/** Heuristic token estimate: 1 token ≈ 4 chars (Ukrainian/English mix). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LEXICAL_STOPWORDS = new Set([
  // Ukrainian / Russian common function words (domain-agnostic)
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
  'я',
  'ми',
  'ви',
  'вони',
  'він',
  'вона',
  'воно',
  // English
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

/** Unicode-safe tokenize (Cyrillic/Latin/digits) for lexical relevance. No domain wordlists. */
function tokenizeForLexical(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !LEXICAL_STOPWORDS.has(t));
}

function normalizeForNgrams(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cosine similarity normalized to [0, 1] for semantic meta signal. */
function cosineNorm(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  if (norm === 0) return 0;
  const cos = dot / norm;
  return (cos + 1) / 2;
}

function charNgrams(s: string, n: number): Set<string> {
  const compact = normalizeForNgrams(s).replace(/\s+/g, '');
  const out = new Set<string>();
  if (compact.length === 0) return out;
  if (compact.length <= n) {
    out.add(compact);
    return out;
  }
  for (let i = 0; i <= compact.length - n; i++) {
    out.add(compact.slice(i, i + n));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Dedup rawHits by (r2_key, json_path).
 * When duplicates exist: keep max score, merge goal_ids if different.
 * Returns deterministically ordered array (score desc, tie-break by r2_key+json_path).
 */
function dedupAndSortHits(rawHits: RawHit[]): RawHit[] {
  const map = new Map<string, RawHit>();
  for (const h of rawHits) {
    const key = `${h.r2_key}::${h.json_path}`;
    const existing = map.get(key);
    if (!existing || h.score > existing.score) {
      map.set(key, h);
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ka = `${a.r2_key}::${a.json_path}`;
    const kb = `${b.r2_key}::${b.json_path}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Build LawSourceRef from a RawHit and its rank after dedup+sort.
 */
function hitToSourceRef(h: RawHit, retrievalRank: number, selectedOrder?: number): LawSourceRef {
  return {
    r2_key: h.r2_key,
    json_path: h.json_path,
    score: h.score,
    rank: retrievalRank,
    selected_order: selectedOrder,
    rada_nreg: h.rada_nreg,
    article_number: h.article_number ?? null,
    act_title: h.title,
    goal_id: h.goal_id,
    loaded: false,
  };
}

/**
 * Assemble full prompt for U10 Legal Agent.
 *
 * Channels (priority order for budgeting):
 *   1. LAW: canonical snippets from R2 (real text, loaded concurrently)
 *   2. DOCS: retrieved snippets from user-uploaded documents
 *   3. MEMORY: memory_summaries (high signal, short)
 *   4. HISTORY: last K messages
 *   5. MEMORY ITEMS: content_preview (lower signal)
 */
export async function assemblePrompt(input: {
  runContext: RunContext;
  u4: U4Result;
  gate: GateDecision;
}): Promise<AssembledPrompt> {
  const { runContext, u4 } = input;

  const contextMode = runContext.query_profile?.routing_flags?.context_mode;
  const useMemory = runContext.search_plan?.sources?.use_memory === true;
  const hasDocEvidence = (runContext.doc_snippets?.length ?? 0) > 0;
  const hasMemoryEvidence =
    (runContext.memory_items?.length ?? 0) > 0 ||
    (runContext.memory_summaries?.length ?? 0) > 0;
  const explicitDocOnlyQuery =
    hasDocEvidence &&
    isExplicitUserDocumentQuery(runContext.user_input ?? '') &&
    !hasExplicitLegalReferenceRequest(runContext.user_input ?? '');
  const rawMemoryRecallMode =
    contextMode === 'memory' ||
    (useMemory && !runContext.search_plan?.sources?.use_lldbi);
  const docsMemoryMode =
    rawMemoryRecallMode &&
    explicitDocOnlyQuery &&
    hasDocEvidence;
  // If U3 routed to memory but U9 has real doc evidence and no memory artifacts,
  // treat this as doc-backed recall rather than suppressing the docs channel.
  const memoryRecallMode =
    rawMemoryRecallMode &&
    !docsMemoryMode &&
    !(hasDocEvidence && !hasMemoryEvidence);
  const mixedMode = contextMode === 'mixed';
  const lawMode = !memoryRecallMode && !mixedMode && !docsMemoryMode;

  const maxLawSnippets = memoryRecallMode || docsMemoryMode
    ? 0
    : explicitDocOnlyQuery
      ? 0
    : mixedMode
      ? config.mixedModeLawMaxSnippets
      : Math.min(config.u9MaxLawSnippets, config.mixedModeLawMaxSnippets);
  const maxSnippetChars = memoryRecallMode
    ? 0
    : mixedMode
      ? config.u9MixedModeMaxLawSnippetChars
      : config.u9LawModeMaxLawSnippetChars;
  const maxTotalLawChars = memoryRecallMode
    ? 0
    : mixedMode
      ? config.u9MixedModeMaxTotalLawChars
      : config.u9LawModeMaxTotalLawChars;
  const maxTotalMemoryChars = memoryRecallMode || docsMemoryMode
    ? config.u9MaxTotalMemoryChars
    : mixedMode
      ? config.u9MixedModeMemoryChars
      : config.u9LawModeMemoryChars;
  const maxTotalDocChars = docsMemoryMode
    ? config.u9MixedModeDocChars
    : memoryRecallMode
    ? 0
    : mixedMode
      ? config.u9MixedModeDocChars
      : config.u9LawModeDocChars;
  const maxHistoryMessages = memoryRecallMode || docsMemoryMode
    ? config.u9MaxHistoryMessages
    : mixedMode
      ? config.u9MixedModeHistoryMessages
      : config.u9LawModeHistoryMessages;
  const allowMemory = memoryRecallMode || mixedMode || docsMemoryMode;
  const r2Concurrency = config.u9R2Concurrency;

  // --- Channel 1: LAW ---
  const rawHits = u4.rawHits ?? [];
  const dedupedAll = dedupAndSortHits(rawHits); // full sorted list, no slice yet

  // DEV RUN v16: metadata pre-triage — select relevant hits from ALL retrieved before R2 loading.
  // Without this, specific articles (e.g. ст.130 КУпАП at rank 88/100, score 0.629) are
  // cut off by the top-N-by-score limit and never seen by the main LLM.
  const metaTriage = maxLawSnippets > 0
    ? await metaTriageHits(
        dedupedAll,
        runContext.user_input ?? '',
        runContext.run_id
      )
    : {
        selectedIndices: [] as number[],
        rawSelectedIndices: [] as number[],
        fallbackApplied: false,
        selectedTopScore: null,
        fallbackReason: 'skipped_doc_only',
        model: 'skipped',
        latencyMs: 0,
      };

  // Multi-signal selection: strong article refs only; match hits in normalized space (332-2 vs 3322).
  const userQuery = runContext.user_input ?? '';
  const queryRefsNormalized = getStrongArticleRefsNormalized(userQuery);
  function hitArticleMatchesQueryRefs(articleNumber: string | number | null | undefined): boolean {
    if (articleNumber == null || queryRefsNormalized.size === 0) return false;
    const s = String(articleNumber).trim();
    if (queryRefsNormalized.has(s)) return true;
    const dash = s.match(/^(\d{1,5})-(\d{1,3})$/);
    if (dash) return queryRefsNormalized.has(dash[1]! + dash[2]!);
    return false;
  }
  const queryTokens = new Set(tokenizeForLexical(userQuery));
  const queryNgrams4 = charNgrams(userQuery, 4);
  const modelSet = new Set(metaTriage.selectedIndices);
  const anchorK = Math.min(config.u9AnchorTopK, dedupedAll.length);
  const candidateIndices = new Set<number>();
  for (let i = 0; i < anchorK; i++) candidateIndices.add(i);
  for (const i of metaTriage.selectedIndices) candidateIndices.add(i);
  if (queryRefsNormalized.size > 0) {
    for (let i = 0; i < dedupedAll.length; i++) {
      const art = dedupedAll[i]?.article_number;
      if (art != null && hitArticleMatchesQueryRefs(art)) candidateIndices.add(i);
    }
  }
  // Stratified deep-rank: one index per decile (10..19, 20..29, …) for recall
  const decileSize = 10;
  for (let d = 1; d <= Math.min(9, Math.floor(dedupedAll.length / decileSize)); d++) {
    const start = d * decileSize;
    const end = Math.min(start + decileSize, dedupedAll.length);
    if (end > start) candidateIndices.add(Math.floor((start + end - 1) / 2));
  }
  if (candidateIndices.size < maxLawSnippets) {
    const byRank = [...Array(dedupedAll.length).keys()].sort((a, b) => (dedupedAll[b]?.score ?? 0) - (dedupedAll[a]?.score ?? 0));
    for (const i of byRank) {
      if (candidateIndices.size >= Math.max(maxLawSnippets, 50)) break;
      candidateIndices.add(i);
    }
  }
  const wSem = config.u9WeightSemanticMeta;
  const scale = 1 - wSem;
  const semanticMetaByIndex = await (async (): Promise<Map<number, number>> => {
    const out = new Map<number, number>();
    try {
      const queryEmb = (await embedQuery(userQuery.slice(0, 2000))).embedding;
      const indices = [...candidateIndices];
      const metaTexts: string[] = [];
      const indexByPos: number[] = [];
      for (const i of indices) {
        const h = dedupedAll[i];
        if (!h) continue;
        const metaText = [h.title ?? (h as { act_title?: string }).act_title ?? '', h.article_number ?? '', (h.r2_key ?? '').split('/').pop() ?? ''].join(' ').slice(0, 300).trim();
        if (!metaText) {
          out.set(i, 0);
          continue;
        }
        metaTexts.push(metaText);
        indexByPos.push(i);
      }
      if (metaTexts.length === 0) return out;
      const batch = await embedMany(metaTexts);
      for (let p = 0; p < indexByPos.length; p++) {
        out.set(indexByPos[p]!, cosineNorm(queryEmb, batch[p]!.embedding));
      }
    } catch {
      // non-fatal: leave map empty, semantic_meta will be 0
    }
    return out;
  })();
  const maxScore = Math.max(...dedupedAll.map((h) => h.score), 1e-6);
  const w1 = config.u9WeightRetrieval * scale;
  const w2 = config.u9WeightModel * scale;
  const w3 = config.u9WeightQueryNumber * scale;
  const w4 = config.u9WeightLexical * scale;
  const w5 = config.u9WeightNovelty * scale;
  const relevanceFloorHard = config.u9RelevanceFloorHard;
  const relevanceFloorSoft = config.u9RelevanceFloorSoft;
  const lexicalSignal = (i: number): number => {
    const h = dedupedAll[i];
    if (!h || queryTokens.size === 0) return 0;
    const metaText = [h.title ?? '', h.article_number ?? '', (h.r2_key ?? '').split('/').pop() ?? ''].join(' ');
    const metaTokens = new Set(tokenizeForLexical(metaText));
    const word = jaccard(queryTokens, metaTokens);
    const grams = jaccard(queryNgrams4, charNgrams(metaText, 4));
    const lexical = 0.6 * word + 0.4 * grams;
    return Math.min(1, Math.max(0, lexical));
  };
  const signals = (i: number) => {
    const h = dedupedAll[i];
    const retrieval = h ? h.score / maxScore : 0;
    const model = modelSet.has(i) ? 1 : 0;
    const queryNum = queryRefsNormalized.size > 0 && hitArticleMatchesQueryRefs(h?.article_number) ? 1 : 0;
    const lexical = lexicalSignal(i);
    const semantic_meta = semanticMetaByIndex.get(i) ?? 0;
    return { retrieval, model, queryNum, lexical, semantic_meta };
  };
  const hasExplicitSignal = (i: number): boolean => {
    const h = dedupedAll[i];
    if (!h) return false;
    const model = modelSet.has(i);
    const queryNum = queryRefsNormalized.size > 0 && hitArticleMatchesQueryRefs(h.article_number);
    return model || queryNum;
  };
  const noveltyPenalty = (i: number, selected: number[]): number => {
    if (selected.length === 0 || queryTokens.size === 0) return 0;
    const h = dedupedAll[i];
    if (!h) return 0;
    const metaText = [h.title ?? '', h.article_number ?? '', (h.r2_key ?? '').split('/').pop() ?? ''].join(' ');
    const metaTokens = new Set(tokenizeForLexical(metaText));
    let maxSim = 0;
    for (const j of selected) {
      const other = dedupedAll[j];
      if (!other) continue;
      const otherText = [other.title ?? '', other.article_number ?? '', (other.r2_key ?? '').split('/').pop() ?? ''].join(' ');
      const otherTokens = new Set(tokenizeForLexical(otherText));
      const inter = [...metaTokens].filter((t) => otherTokens.has(t)).length;
      const sim = inter / Math.max(1, metaTokens.size + otherTokens.size - inter);
      if (sim > maxSim) maxSim = sim;
    }
    return maxSim;
  };

  /** Source family: same r2_key path prefix or title prefix for redundancy penalty (data-driven, no domain lists). */
  const sourceFamilyKey = (h: RawHit | undefined): string => {
    if (!h) return '';
    const titlePrefix = (h.title ?? (h as { act_title?: string }).act_title ?? '').trim().slice(0, 40);
    if (titlePrefix) return titlePrefix;
    const parts = (h.r2_key ?? '').split('/');
    if (parts.length > 1) return parts.slice(0, -1).join('/');
    return h.r2_key ?? '';
  };
  const sourceRedundancyPenalty = (i: number, selected: number[]): number => {
    if (selected.length === 0 || config.u9SourceRedundancyPenalty <= 0) return 0;
    const h = dedupedAll[i];
    if (!h) return 0;
    const family = sourceFamilyKey(h);
    if (!family) return 0;
    let count = 0;
    for (const j of selected) {
      if (sourceFamilyKey(dedupedAll[j]) === family) count++;
    }
    return count * config.u9SourceRedundancyPenalty;
  };
  /** Structural legalness: 0–1 feature from article_number presence + heading/token richness (no domain wordlists). */
  const structuralLegalness = (i: number): number => {
    const h = dedupedAll[i];
    if (!h) return 0;
    const title = (h.title ?? (h as { act_title?: string }).act_title ?? '').trim();
    const hasArticle = h.article_number != null && String(h.article_number).trim().length > 0;
    const titleTokens = tokenizeForLexical(title).length;
    const richness = Math.min(1, titleTokens / 8);
    return (hasArticle ? 0.5 : 0) + 0.5 * richness;
  };
  const wStructural = config.u9WeightStructuralLegalness;

  const softFloorPenalty = 0.03;
  const scoreWithNovelty = (i: number, selected: number[]) => {
    const s = signals(i);
    const nov = noveltyPenalty(i, selected);
    const red = sourceRedundancyPenalty(i, selected);
    const structural = structuralLegalness(i);
    const raw =
      w1 * s.retrieval +
      w2 * s.model +
      w3 * s.queryNum +
      w4 * s.lexical +
      wSem * s.semantic_meta -
      w5 * nov -
      red +
      wStructural * structural;
    const penalty = raw < relevanceFloorSoft && !hasExplicitSignal(i) ? softFloorPenalty : 0;
    return raw - penalty;
  };
  const maxPerSource = config.u9MaxChunksPerSource;
  const perSource = new Map<string, number>();
  const selectedIndices: number[] = [];
  const scoreBreakdown: Array<{
    index: number;
    retrieval: number;
    model: number;
    queryNum: number;
    lexical: number;
    semantic_meta?: number;
    novelty: number;
    redundancy_penalty?: number;
    structural_bonus?: number;
    final_score?: number;
  }> = [];
  const remaining = [...candidateIndices].sort((a, b) => scoreWithNovelty(b, []) - scoreWithNovelty(a, []));
  const rejected: Array<{ index: number; reason: string }> = [];
  while (selectedIndices.length < maxLawSnippets && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -1e9;
    let bestPos = -1;
    for (let pos = 0; pos < remaining.length; pos++) {
      const i = remaining[pos]!;
      const key = dedupedAll[i]?.r2_key ?? '';
      if ((perSource.get(key) ?? 0) >= maxPerSource) continue;
      const sc = scoreWithNovelty(i, selectedIndices);
      if (relevanceFloorHard > 0 && sc < relevanceFloorHard && !hasExplicitSignal(i)) continue;
      if (sc > bestScore || (sc === bestScore && (bestIdx === -1 || i < bestIdx))) {
        bestScore = sc;
        bestIdx = i;
        bestPos = pos;
      }
    }
    if (bestIdx === -1) break;
    const key = dedupedAll[bestIdx]?.r2_key ?? '';
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
    selectedIndices.push(bestIdx);
    const s = signals(bestIdx);
    const nov = noveltyPenalty(bestIdx, selectedIndices.slice(0, -1));
    const red = sourceRedundancyPenalty(bestIdx, selectedIndices.slice(0, -1));
    const structural = structuralLegalness(bestIdx);
    const finalRaw =
      w1 * s.retrieval +
      w2 * s.model +
      w3 * s.queryNum +
      w4 * s.lexical +
      wSem * s.semantic_meta -
      w5 * nov -
      red +
      wStructural * structural;
    const softPen = finalRaw < relevanceFloorSoft && !hasExplicitSignal(bestIdx) ? softFloorPenalty : 0;
    const finalScore = finalRaw - softPen;
    scoreBreakdown.push({
      index: bestIdx,
      retrieval: Math.round(s.retrieval * 100) / 100,
      model: s.model,
      queryNum: s.queryNum,
      lexical: Math.round(s.lexical * 100) / 100,
      semantic_meta: Math.round((s.semantic_meta ?? 0) * 100) / 100,
      novelty: Math.round(nov * 100) / 100,
      redundancy_penalty: Math.round(red * 100) / 100,
      structural_bonus: Math.round(wStructural * structural * 100) / 100,
      final_score: Math.round(finalScore * 100) / 100,
    });
    remaining.splice(bestPos, 1);
  }
  for (let r = 0; r < remaining.length && rejected.length < 5; r++) {
    const i = remaining[r]!;
    const key = dedupedAll[i]?.r2_key ?? '';
    rejected.push({
      index: i,
      reason: (perSource.get(key) ?? 0) >= maxPerSource ? 'diversity_cap' : 'low_score',
    });
  }
  const selected = selectedIndices.map((i, selected_order) => ({
    retrieval_rank: i,
    selected_order,
    hit: dedupedAll[i]!,
  }));
  const selectedHits = selected.map((s) => s.hit);
  logger.info('u9_law_selection: multi_signal', {
    run_id: runContext.run_id,
    module: 'assemble/assemblePrompt',
    explicit_doc_only_query: explicitDocOnlyQuery,
    total_deduped: dedupedAll.length,
    meta_triage_selected: metaTriage.selectedIndices.length,
    final_for_r2: selectedHits.length,
    meta_triage_model: metaTriage.model,
    meta_triage_latency_ms: metaTriage.latencyMs,
    sources_count: perSource.size,
  });

  const sourceRefs: LawSourceRef[] = selected.map((s) =>
    hitToSourceRef(s.hit, s.retrieval_rank, s.selected_order)
  );

  const semaphore = new Semaphore(r2Concurrency);
  const loadResults = maxLawSnippets > 0
    ? await Promise.all(
        sourceRefs.map((ref) => semaphore.run(() => loadCanonicalSnippet(ref, maxSnippetChars)))
      )
    : [];

  const lawParts: ContextPart[] = [];
  let lawCharsUsed = 0;
  let loadErrorsCount = 0;
  let lawBudgetExhausted = false;
  const finalSourceRefs: LawSourceRef[] = [];

  for (const result of loadResults) {
    if (!result.ok) {
      loadErrorsCount++;
      finalSourceRefs.push(result.sourceRef);
      // Add a missing marker so the agent knows the source exists but text is unavailable
      const ref = result.sourceRef;
      lawParts.push({
        type: 'law',
        text: `[Норма недоступна: ${ref.rada_nreg ?? ref.r2_key} ${ref.json_path} — ${result.error}]`,
        sourceIds: [ref.r2_key, ref.json_path],
        sourceRef: { ...ref, loaded: false },
      });
      continue;
    }

    if (lawCharsUsed + result.text.length > maxTotalLawChars) {
      // Budget exhausted — skip remaining law snippets (DEV RUN v18: mark truncated)
      lawBudgetExhausted = true;
      finalSourceRefs.push(result.sourceRef);
      break;
    }

    lawCharsUsed += result.text.length;
    const normRef = extractNormRef(result.text, {
      act_title: result.sourceRef.act_title,
      article_number: result.sourceRef.article_number,
    }) ?? null;
    const ref: LawSourceRef = { ...result.sourceRef, loaded: true, normRef };
    finalSourceRefs.push(ref);
    lawParts.push({
      type: 'law',
      text: result.text,
      sourceIds: [ref.r2_key, ref.json_path],
      sourceRef: ref,
    });
  }

  // --- Channel 2: DOCS (user/project/chat uploads; disabled in pure memory recall) ---
  const docParts: ContextPart[] = [];
  let docCharsUsed = 0;
  let docSnippetsUsed = 0;
  const maxDocSnippets = explicitDocOnlyQuery ? 3 : Number.POSITIVE_INFINITY;
  if (maxTotalDocChars > 0) {
    const docSnippets = runContext.doc_snippets ?? [];
    const seenDocKeys = new Set<string>();
    for (const snippet of docSnippets) {
      if (docSnippetsUsed >= maxDocSnippets) break;
      const text = snippet.text?.trim() ?? '';
      if (!text) continue;
      const dedupeKey = `${snippet.doc_id}::${snippet.json_path}`;
      if (seenDocKeys.has(dedupeKey)) continue;
      seenDocKeys.add(dedupeKey);
      const boundedText =
        text.length > config.u9DocMaxSnippetChars
          ? truncateSnippetText(text, config.u9DocMaxSnippetChars)
          : text;
      if (docCharsUsed + boundedText.length > maxTotalDocChars) break;
      docCharsUsed += boundedText.length;
      docParts.push({
        type: 'doc',
        text: boundedText,
        sourceIds: [snippet.doc_id, snippet.r2_key, snippet.json_path].filter(Boolean),
        sourceRef: {
          doc_id: snippet.doc_id,
          r2_key: snippet.r2_key,
          json_path: snippet.json_path,
          scope_type: snippet.scope_type,
          scope_id: snippet.scope_id ?? null,
          filename: snippet.filename,
          title: snippet.title,
          score: snippet.score,
        },
      });
      docSnippetsUsed += 1;
    }
  }

  // --- Channel 3: MEMORY (policy: law mode = allow_memory false; mixed/memory = allow_memory true) ---
  const memoryParts: ContextPart[] = [];
  let memoryCharsUsed = 0;
  if (allowMemory && maxTotalMemoryChars > 0) {
    const summaries = runContext.memory_summaries ?? [];
    for (const s of summaries) {
      const t = s.summary_text?.trim() ?? '';
      if (!t) continue;
      if (memoryCharsUsed + t.length > maxTotalMemoryChars) break;
      memoryCharsUsed += t.length;
      memoryParts.push({
        type: 'memory',
        text: t,
        sourceIds: [s.scope ?? 'summary'],
        sourceRef: { scope: s.scope },
      });
    }
    const memoryItems = runContext.memory_items ?? [];
    for (const m of memoryItems) {
      const preview = (m as { content_preview?: string }).content_preview?.trim() ?? '';
      if (!preview) continue;
      if (memoryCharsUsed + preview.length > maxTotalMemoryChars) break;
      memoryCharsUsed += preview.length;
      const id = (m as { id?: string }).id ?? 'memory';
      memoryParts.push({
        type: 'memory',
        text: preview,
        sourceIds: [id],
        sourceRef: {
          id,
          scope_type: (m as { scope_type?: string }).scope_type,
        },
      });
    }
  }

  // --- Channel 4: HISTORY ---
  const historyParts: ContextPart[] = [];
  const history = runContext.history ?? [];
  // Memory recall should rely on memory artifacts + recent user asks, not on raw assistant legal answers.
  const historyForMode = memoryRecallMode
    ? (() => {
        const recentUserHistory = history.filter((msg) => msg.role === 'user');
        return recentUserHistory.length > 0 ? recentUserHistory : history;
      })()
    : history;
  const lastHistory = historyForMode.slice(-maxHistoryMessages);
  for (let i = 0; i < lastHistory.length; i++) {
    const msg = lastHistory[i];
    historyParts.push({
      type: 'history',
      text: `${msg.role}: ${msg.content}`,
      sourceIds: [],
      sourceRef: { index: historyForMode.length - lastHistory.length + i, role: msg.role },
    });
  }

  // --- Truncation tracking (DEV RUN v18: include law budget exhausted) ---
  const droppedChannels: Array<'law' | 'doc' | 'memory' | 'history'> = [];
  const selectedLawCount = finalSourceRefs.length;
  const missingLawCount = lawParts.filter((p) => p.text.startsWith('[Норма')).length;
  if (selectedLawCount > 0 && missingLawCount === selectedLawCount) {
    droppedChannels.push('law');
  }

  const budget: AssembledPromptBudget = {
    tokenEstimateTotal: 0, // set below
    tokenEstimateByChannel: { law: 0, doc: 0, memory: 0, history: 0 },
    truncated: droppedChannels.length > 0 || lawBudgetExhausted,
    droppedChannels,
  };

  // --- Budget estimates ---
  const lawTokens = estimateTokens(lawParts.map((p) => p.text).join(' '));
  const docTokens = estimateTokens(docParts.map((p) => p.text).join(' '));
  const memoryTokens = estimateTokens(memoryParts.map((p) => p.text).join(' '));
  const historyTokens = estimateTokens(historyParts.map((p) => p.text).join(' '));
  const totalTokens = lawTokens + docTokens + memoryTokens + historyTokens;
  budget.tokenEstimateTotal = totalTokens;
  budget.tokenEstimateByChannel = {
    law: lawTokens,
    doc: docTokens,
    memory: memoryTokens,
    history: historyTokens,
  };

  const contextParts: ContextPart[] = memoryRecallMode
    ? [...memoryParts, ...historyParts, ...lawParts]
    : docsMemoryMode
      ? [...docParts, ...memoryParts, ...historyParts]
      : [...lawParts, ...docParts, ...memoryParts, ...historyParts];
  const userPrompt = runContext.user_input ?? '';

  const lawIndex: Record<string, { articleNumber?: number; heading?: string; actTitle?: string }> = {};
  for (const ref of finalSourceRefs) {
    const sid = `${ref.r2_key}::${ref.json_path}`;
    lawIndex[sid] = normRefSummary(ref.normRef ?? null);
  }

  return {
    systemPrompt: SYSTEM_PROMPT_EVIDENCE_ONLY,
    userPrompt,
    contextParts,
    meta: {
      assembledAt: new Date().toISOString(),
      tokenEstimate: totalTokens,
      sourcesSummary: `law=${lawParts.length} doc=${docParts.length} memory=${memoryParts.length} history=${historyParts.length}`,
      budget,
      loadErrorsCount,
      degraded: loadErrorsCount > 0,
      sources: {
        lawCount: lawParts.length,
        docCount: docParts.length,
        memoryCount: memoryParts.length,
        historyCount: historyParts.length,
      },
      law_chars_used: lawCharsUsed,
      doc_chars_used: docCharsUsed,
      memory_chars_used: memoryCharsUsed,
      history_messages_used: lastHistory.length,
      lawBudgetExhausted: lawBudgetExhausted || undefined,
      lawSourceRefs: finalSourceRefs,
      lawIndex,
      u9MetaTriage: {
        skipped: metaTriage.skipped,
        selected_count: metaTriage.selectedIndices.length,
        final_selected_count: selectedIndices.length,
        total_hits: dedupedAll.length,
        model: metaTriage.model,
        latency_ms: metaTriage.latencyMs,
        parse_ok: metaTriage.parse_ok,
        fallback_used: metaTriage.fallback_used,
        fallback_mode: metaTriage.fallback_mode,
        reason_code: metaTriage.reason_code,
        finish_reason: metaTriage.finish_reason,
        raw_content_type: metaTriage.raw_content_type,
        reasoning_tokens: metaTriage.reasoning_tokens,
        triage_attempts: metaTriage.triage_attempts,
        triage_model_chain: metaTriage.triage_model_chain,
        triage_attempt_trail: metaTriage.triage_attempt_trail,
        candidate_count: candidateIndices.size,
        selected_indices: selectedIndices.length <= 50 ? selectedIndices : selectedIndices.slice(0, 50),
        score_breakdown: scoreBreakdown.length <= 30 ? scoreBreakdown : scoreBreakdown.slice(0, 30),
        rejected_top_candidates: rejected.length > 0 ? rejected : undefined,
      },
    },
  };
}
