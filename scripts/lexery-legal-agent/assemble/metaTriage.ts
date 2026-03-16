/**
 * U9 Metadata Pre-Triage (DEV RUN v16 root-cause fix; v17: GPT-5 nano + JSON hardening).
 *
 * The core problem: vector search returns specific articles (e.g. ст.130 КУпАП, ст.286 ккУ)
 * at low ranks (80-95 of 100) because the query matches general principle articles better
 * semantically. U9 only loads top-N by score, so those specific articles are never seen.
 *
 * Solution: BEFORE loading from R2, run a cheap LLM over the metadata of ALL retrieved hits.
 * Selected indices are merged with top-by-score for R2 loading.
 * JSON hardening: strict output, 1 retry on invalid JSON, deterministic top-N fallback.
 */
import { config } from '../lib/config.js';
import { extractFirstJsonArray, extractFirstJsonObject } from '../lib/jsonExtract.js';
import { openRouterChat, OpenRouterError } from '../lib/openrouter.js';
import { logger } from '../lib/logger.js';
import type { RawHit } from '../retrieval/types.js';

export interface MetaTriageResult {
  /** Indices into the sorted hits array to load from R2. */
  selectedIndices: number[];
  /** Whether meta-triage ran or was skipped. */
  skipped: boolean;
  model?: string;
  latencyMs: number;
  /** LLM returned parseable indices (false when fallback used). */
  parse_ok?: boolean;
  /** True when deterministic fallback was used (no valid LLM selection). */
  fallback_used?: boolean;
  /** 'top_n_by_score' | 'coverage_preserving' (Phase C). */
  fallback_mode?: string;
  /** E.g. openrouter_missing_content, openrouter_timeout, empty_output_length, parse_fail. */
  reason_code?: string | null;
  /** From OpenRouter choice. */
  finish_reason?: string | null;
  /** From OpenRouter result. */
  raw_content_type?: string | null;
  reasoning_tokens?: number | null;
  /** Number of LLM attempts (1 or 2). */
  triage_attempts?: number;
  /** Model ids used in order, e.g. ['openai/gpt-5-nano', 'openai/gpt-4o-mini']. */
  triage_model_chain?: string[];
  /** Full attempt trail for observability (C1). */
  triage_attempt_trail?: Array<{
    attempt_no: number;
    model_id: string;
    finish_reason?: string | null;
    raw_content_type?: string | null;
    reasoning_tokens?: number | null;
    token_budget?: number | null;
    outcome: 'ok' | 'retry' | 'fallback' | 'parse_fail' | 'error';
  }>;
}

const CALLER = 'u9-meta-triage';

const SYSTEM_STRICT =
  'Return JSON only. No markdown, no code fences, no comments. ' +
  'If unsure, select up to N best candidates; prefer specific norm references (article numbers).';

/**
 * Parse LLM response into array of valid indices. Tries: strict parse, bracket-balanced array, bracket-balanced object.
 * Exported for unit tests.
 */
export function parseMetaTriageIndices(raw: string, maxIndex: number, maxSelect: number): number[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const normalize = (arr: unknown[]): number[] => {
    const clamped: number[] = [];
    for (const x of arr) {
      if (typeof x !== 'number' || !Number.isFinite(x) || !Number.isInteger(x)) continue;
      const v = Math.max(0, Math.min(maxIndex, x));
      clamped.push(v);
    }
    const uniq = Array.from(new Set(clamped)).sort((a, b) => a - b);
    return uniq.slice(0, maxSelect);
  };

  // 1) Strict parse of full trimmed
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const indices = normalize(parsed as unknown[]);
      if (indices.length > 0) return indices;
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const arr = (obj.selected_indices ?? obj.indices ?? obj.selected_source_ids) as unknown;
      if (Array.isArray(arr)) {
        const indices = normalize(arr as unknown[]);
        if (indices.length > 0) return indices;
      }
    }
  } catch {
    // fall through
  }

  // 2) Bracket-balanced first array
  const arrayStr = extractFirstJsonArray(trimmed);
  if (arrayStr) {
    try {
      const parsed = JSON.parse(arrayStr) as unknown;
      if (Array.isArray(parsed)) {
        const indices = normalize(parsed as unknown[]);
        if (indices.length > 0) return indices;
      }
    } catch {
      // fall through
    }
  }

  // 3) Bracket-balanced first object
  const objectStr = extractFirstJsonObject(trimmed);
  if (objectStr) {
    try {
      const obj = JSON.parse(objectStr) as Record<string, unknown>;
      const arr = (obj.selected_indices ?? obj.indices ?? obj.selected_source_ids) as unknown;
      if (Array.isArray(arr)) {
        const indices = normalize(arr as unknown[]);
        if (indices.length > 0) return indices;
      }
    } catch {
      // fall through
    }
  }

  return [];
}

/** Deterministic fallback: top N by score (indices 0..N-1). Exported for unit tests. */
export function fallbackTopNByScore(n: number, maxSelect: number): number[] {
  const count = Math.min(maxSelect, n);
  const indices: number[] = [];
  for (let i = 0; i < count; i++) indices.push(i);
  return indices;
}

const COVERAGE_ANCHOR_TOP_K = 10;
const COVERAGE_DECILE_SIZE = 10;

/** Small anchor for gap-free fallback (not fixed top-10). */
const GAP_FREE_ANCHOR_K = 5;
/** Max chunks per r2_key in gap-free fallback (diversity). */
const GAP_FREE_MAX_PER_SOURCE = 6;

import { extractArticleNumbersFromQuery, getStrongArticleRefsNormalized } from '../lib/articleRefs.js';
export { extractArticleNumbersFromQuery } from '../lib/articleRefs.js';

function hitArticleInQueryRefsNormalized(articleNumber: string | null | undefined, queryNormalized: Set<string>): boolean {
  if (articleNumber == null || queryNormalized.size === 0) return false;
  const s = String(articleNumber).trim();
  if (queryNormalized.has(s)) return true;
  const dash = s.match(/^(\d{1,5})-(\d{1,3})$/);
  if (dash) return queryNormalized.has(dash[1]! + dash[2]!);
  return false;
}

/**
 * Gap-free deterministic fallback: small anchor + round-robin over rank segments + query-number match + source diversity.
 * No rank gaps; no domain wordlists.
 */
export function gapFreeDeterministicFallback(
  sortedHits: RawHit[],
  userQuery: string,
  maxSelect: number
): number[] {
  const n = sortedHits.length;
  const seen = new Set<number>();

  // 1) Small anchor (top-k by score)
  const anchorK = Math.min(GAP_FREE_ANCHOR_K, n);
  for (let i = 0; i < anchorK; i++) seen.add(i);

  // 2) Round-robin over rank segments (indices anchorK..n-1 split into segments)
  const restStart = anchorK;
  const restCount = n - restStart;
  const numSegments = Math.min(10, Math.max(1, Math.floor(restCount / 5)));
  if (numSegments > 0 && restCount > 0) {
    const segmentSize = Math.ceil(restCount / numSegments);
    let round = 0;
    while (seen.size < maxSelect + numSegments) {
      let added = 0;
      for (let s = 0; s < numSegments; s++) {
        const idx = restStart + s * segmentSize + round;
        if (idx < n) {
          seen.add(idx);
          added++;
        }
      }
      if (added === 0) break;
      round++;
      if (round >= segmentSize) break;
    }
  }

  // 3) Query-number match (normalized space: 332-2 vs 3322)
  const queryRefsNormalized = getStrongArticleRefsNormalized(userQuery);
  if (queryRefsNormalized.size > 0) {
    for (let i = 0; i < n; i++) {
      if (hitArticleInQueryRefsNormalized(sortedHits[i]?.article_number, queryRefsNormalized)) seen.add(i);
    }
  }

  // 4) Apply source diversity: order by rank, cap per r2_key
  const byRank = [...seen].sort((a, b) => a - b);
  const perSource = new Map<string, number>();
  const result: number[] = [];
  for (const i of byRank) {
    if (result.length >= maxSelect) break;
    const key = sortedHits[i]?.r2_key ?? '';
    const count = perSource.get(key) ?? 0;
    if (count < GAP_FREE_MAX_PER_SOURCE) {
      result.push(i);
      perSource.set(key, count + 1);
    }
  }
  return result.slice(0, maxSelect);
}

/** Direct article refs already provide a strong structural signal; use deterministic coverage instead of LLM triage. */
export function shouldUseDirectRefDeterministicTriage(userQuery: string): boolean {
  return getStrongArticleRefsNormalized(userQuery).size > 0;
}

/** GPT-5 nano is fast but flaky with strict json_schema here; let it answer plain JSON and keep strict parsing locally. */
export function shouldUseStructuredMetaTriageOutput(modelId: string): boolean {
  return !/gpt-5-nano/i.test(modelId);
}

/** Nano empty-output retries are a bad latency trade; fallback model is consistently faster than retrying the same failure mode. */
export function shouldFallbackImmediatelyOnEmptyMetaTriageOutput(
  modelId: string,
  fallbackModelId: string
): boolean {
  return /gpt-5-nano/i.test(modelId) && modelId !== fallbackModelId;
}

/**
 * Coverage-preserving fallback: anchor top-K + stratified picks from deciles 11..100 + article-number match.
 * Domain-agnostic; ensures deep-rank relevant articles (e.g. ст.185, ст.190 at rank 75/89) can be included.
 * @deprecated Prefer gapFreeDeterministicFallback for gap-free selection.
 */
export function coveragePreservingFallback(
  sortedHits: RawHit[],
  userQuery: string,
  maxSelect: number
): number[] {
  const n = sortedHits.length;
  const seen = new Set<number>();

  // 1) Anchor top-K
  const anchorK = Math.min(COVERAGE_ANCHOR_TOP_K, n);
  for (let i = 0; i < anchorK; i++) seen.add(i);

  // 2) Stratified: 1–2 per decile for indices 10..min(99, n-1)
  const startDecile = COVERAGE_ANCHOR_TOP_K;
  for (let d = 0; d < 9; d++) {
    const decileStart = startDecile + d * COVERAGE_DECILE_SIZE;
    const decileEnd = Math.min(decileStart + COVERAGE_DECILE_SIZE, n);
    if (decileStart >= n) break;
    seen.add(decileStart);
    if (decileEnd - decileStart > 1) seen.add(decileStart + Math.floor((decileEnd - decileStart) / 2));
  }

  // 3) Article-number match (normalized space: 332-2 vs 3322)
  const queryRefsNormalized = getStrongArticleRefsNormalized(userQuery);
  if (queryRefsNormalized.size > 0) {
    for (let i = 0; i < n && seen.size < maxSelect + 20; i++) {
      if (hitArticleInQueryRefsNormalized(sortedHits[i]?.article_number, queryRefsNormalized)) seen.add(i);
    }
  }

  const indices = [...seen].sort((a, b) => a - b).slice(0, maxSelect);
  return indices;
}

/**
 * Run LLM metadata pre-triage on ALL raw hits (no R2 loading needed).
 * Returns a set of indices from the deduped hits array that should be loaded.
 * Robust: 1 retry on invalid JSON; then deterministic top-N-by-score fallback.
 */
export async function metaTriageHits(
  sortedHits: RawHit[],
  userQuery: string,
  runId?: string
): Promise<MetaTriageResult> {
  const ctx = { run_id: runId, module: 'assemble/metaTriage' };
  const t0 = Date.now();

  if (!config.u9MetaTriageEnabled || sortedHits.length <= config.u9MetaTriageThreshold) {
    return { selectedIndices: [], skipped: true, latencyMs: 0 };
  }

  const maxSelect = config.u9MetaTriageMaxSelect;
  const maxIndex = sortedHits.length - 1;

  if (shouldUseDirectRefDeterministicTriage(userQuery)) {
    const selectedIndices = gapFreeDeterministicFallback(sortedHits, userQuery, maxSelect);
    logger.info('u9_meta_triage: direct-ref shortcut -> deterministic fallback', {
      ...ctx,
      total_hits: sortedHits.length,
      selected_count: selectedIndices.length,
    });
    return {
      selectedIndices,
      skipped: false,
      latencyMs: Date.now() - t0,
      parse_ok: false,
      fallback_used: true,
      fallback_mode: 'gap_free_deterministic',
      reason_code: 'direct_ref_query',
      finish_reason: null,
      raw_content_type: null,
      reasoning_tokens: null,
      triage_attempts: 0,
      triage_model_chain: [],
      triage_attempt_trail: [],
    };
  }

  const metaLines = sortedHits.map((h, i) => {
    const art = h.article_number ? ` ст.${h.article_number}` : '';
    const title = h.title ? ` [${h.title.slice(0, 80).replace(/[\n\r]/g, ' ')}]` : '';
    return `${i}:${art}${title} score=${h.score.toFixed(3)}`;
  });

  const systemPrompt =
    'You are a legal article relevance selector. ' +
    'Given a user question and a numbered list of legal article metadata (index, article number, act title, score), ' +
    'select the indices of articles most likely to contain the specific legal norms needed to answer the question. ' +
    'Prefer: articles covering both sides of a comparison, specific article numbers for the topic, ' +
    'and lower-scored articles that are specifically about the topic. ' +
    `Select at most ${maxSelect} indices. Output ONLY a JSON array of integers, e.g. [0, 5, 12, 87]. ${SYSTEM_STRICT}`;

  const userContent =
    `Question: ${userQuery.slice(0, 400)}\n\nArticles (index: article [act_title] score):\n${metaLines.join('\n')}`;

  const apiKey = config.openRouterApiKeyRag || config.openRouterApiKey;
  const retries = config.u9MetaTriageRetries;

  const TRIAGE_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
      name: 'triage_indices',
      strict: true,
      schema: {
        type: 'object',
        properties: { indices: { type: 'array', items: { type: 'integer' }, description: '0-based indices of selected articles' } },
        required: ['indices'],
        additionalProperties: false,
      },
    },
  } as const;

  type TriageCallResult = {
    content: string;
    model_id: string;
    finish_reason?: string;
    raw_content_type?: string;
    reasoning_tokens?: number;
    request_effective_token_budget?: number;
  };
  const callLlm = async (opts: {
    modelId: string;
    maxCompletionTokens: number;
    retryHint?: string;
    useStructured?: boolean;
  }): Promise<TriageCallResult> => {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: systemPrompt + (opts.retryHint ? ` ${opts.retryHint}` : '') },
      { role: 'user', content: userContent },
    ];
    const result = await openRouterChat(
      apiKey,
      {
        model: opts.modelId,
        messages,
        temperature: 0.0,
        max_completion_tokens: opts.maxCompletionTokens,
        caller: CALLER,
        reasoning: { effort: 'low' },
        ...(opts.useStructured !== false && { response_format: TRIAGE_RESPONSE_FORMAT }),
      },
      config.u9MetaTriageTimeoutSec
    );
    return {
      content: result.content.trim(),
      model_id: result.model_id,
      finish_reason: result.finish_reason,
      raw_content_type: result.raw_content_type,
      reasoning_tokens: result.reasoning_tokens,
      request_effective_token_budget: result.request_effective_token_budget,
    };
  };

  const logAttempt = (attempt: number, r: TriageCallResult, outcome: string) => {
    logger.info('u9_meta_triage: attempt', {
      ...ctx,
      attempt,
      model_id: r.model_id,
      finish_reason: r.finish_reason ?? null,
      reasoning_tokens: r.reasoning_tokens ?? null,
      raw_content_type: r.raw_content_type ?? null,
      token_budget: r.request_effective_token_budget ?? null,
      outcome,
    });
  };

  const modelChain: string[] = [];
  type TrailEntry = {
    attempt_no: number;
    model_id: string;
    finish_reason?: string | null;
    raw_content_type?: string | null;
    reasoning_tokens?: number | null;
    token_budget?: number | null;
    error_code?: string | null;
    outcome: 'ok' | 'retry' | 'fallback' | 'parse_fail' | 'error';
  };
  const attemptTrail: TrailEntry[] = [];
  const pushTrail = (attemptNo: number, r: TriageCallResult, outcome: TrailEntry['outcome']) => {
    attemptTrail.push({
      attempt_no: attemptNo,
      model_id: r.model_id,
      finish_reason: r.finish_reason ?? null,
      raw_content_type: r.raw_content_type ?? null,
      reasoning_tokens: r.reasoning_tokens ?? null,
      token_budget: r.request_effective_token_budget ?? null,
      error_code: null,
      outcome,
    });
  };
  const pushTrailFailed = (
    attemptNo: number,
    modelId: string,
    outcome: TrailEntry['outcome'],
    err?: unknown,
    tokenBudget?: number | null
  ) => {
    const orErr = err instanceof OpenRouterError ? err : null;
    const error_code =
      orErr?.error_code ?? (orErr?.code ? String(orErr.code) : null) ?? (err ? 'UNKNOWN_ERROR' : null);
    attemptTrail.push({
      attempt_no: attemptNo,
      model_id: modelId,
      finish_reason: orErr?.finish_reason ?? null,
      raw_content_type: orErr?.raw_content_type ?? null,
      reasoning_tokens: null,
      token_budget: orErr?.request_effective_token_budget ?? tokenBudget ?? null,
      error_code,
      outcome,
    });
  };
  const isLengthOrEmpty = (code: string) => code === 'EMPTY_OUTPUT_LENGTH' || code === 'EMPTY_ASSISTANT_CONTENT';
  const isRetryableCode = (code: string) =>
    isLengthOrEmpty(code) ||
    code === 'INVALID_RESPONSE' ||
    code === 'TIMEOUT' ||
    code === 'HTTP_ERROR';

  let attempt = 1;
  let lastAttemptModelId = config.u9MetaTriageModelId;
  try {
    let raw = '';
    let lastResult: TriageCallResult = { content: '', model_id: config.u9MetaTriageModelId };

    try {
      lastAttemptModelId = config.u9MetaTriageModelId;
      lastResult = await callLlm({
        modelId: config.u9MetaTriageModelId,
        maxCompletionTokens: config.u9MetaTriageMaxCompletionTokens,
        useStructured: shouldUseStructuredMetaTriageOutput(config.u9MetaTriageModelId),
      });
      modelChain.push(lastResult.model_id);
      pushTrail(1, lastResult, 'ok');
      logAttempt(1, lastResult, 'ok');
      raw = lastResult.content;
    } catch (firstErr) {
      pushTrailFailed(
        1,
        config.u9MetaTriageModelId,
        'retry',
        firstErr,
        config.u9MetaTriageMaxCompletionTokens
      );
      const code = firstErr instanceof OpenRouterError ? firstErr.code : '';
      if (retries > 0 && isLengthOrEmpty(code) && shouldFallbackImmediatelyOnEmptyMetaTriageOutput(config.u9MetaTriageModelId, config.u9MetaTriageFallbackModelId)) {
        logger.info('u9_meta_triage: nano empty output, trying fallback model immediately', { ...ctx, reason: code });
        try {
          lastAttemptModelId = config.u9MetaTriageFallbackModelId;
          lastResult = await callLlm({
            modelId: config.u9MetaTriageFallbackModelId,
            maxCompletionTokens: config.u9MetaTriageRetryMaxCompletionTokens,
            retryHint: 'Return JSON only.',
            useStructured: shouldUseStructuredMetaTriageOutput(config.u9MetaTriageFallbackModelId),
          });
          modelChain.push(lastResult.model_id);
          attempt = 2;
          pushTrail(2, lastResult, 'fallback');
          logAttempt(2, lastResult, 'ok');
          raw = lastResult.content;
        } catch (fallbackErr) {
          pushTrailFailed(
            2,
            config.u9MetaTriageFallbackModelId,
            'error',
            fallbackErr,
            config.u9MetaTriageRetryMaxCompletionTokens
          );
          throw fallbackErr;
        }
      } else if (retries > 0 && isLengthOrEmpty(code)) {
        logger.info('u9_meta_triage: retry primary with higher token budget', { ...ctx, reason: code });
        try {
          lastAttemptModelId = config.u9MetaTriageModelId;
          lastResult = await callLlm({
            modelId: config.u9MetaTriageModelId,
            maxCompletionTokens: config.u9MetaTriageRetryMaxCompletionTokens,
            retryHint: 'Return JSON only.',
            useStructured: shouldUseStructuredMetaTriageOutput(config.u9MetaTriageModelId),
          });
          modelChain.push(lastResult.model_id);
          attempt = 2;
          pushTrail(2, lastResult, 'ok');
          logAttempt(2, lastResult, 'ok');
          raw = lastResult.content;
        } catch (retryErr) {
          pushTrailFailed(
            2,
            config.u9MetaTriageModelId,
            'retry',
            retryErr,
            config.u9MetaTriageRetryMaxCompletionTokens
          );
          logger.info('u9_meta_triage: primary retry failed, trying fallback model', { ...ctx });
          try {
            lastAttemptModelId = config.u9MetaTriageFallbackModelId;
            lastResult = await callLlm({
              modelId: config.u9MetaTriageFallbackModelId,
              maxCompletionTokens: config.u9MetaTriageRetryMaxCompletionTokens,
              retryHint: 'Return JSON only.',
              useStructured: shouldUseStructuredMetaTriageOutput(config.u9MetaTriageFallbackModelId),
            });
            modelChain.push(lastResult.model_id);
            attempt = 3;
            pushTrail(3, lastResult, 'fallback');
            logAttempt(3, lastResult, 'ok');
            raw = lastResult.content;
          } catch (fallbackErr) {
          pushTrailFailed(
            3,
            config.u9MetaTriageFallbackModelId,
            'error',
            fallbackErr,
            config.u9MetaTriageRetryMaxCompletionTokens
          );
            throw fallbackErr;
          }
        }
      } else if (retries > 0 && isRetryableCode(code)) {
        logger.info('u9_meta_triage: retry with fallback model', { ...ctx, reason: code });
        try {
          lastAttemptModelId = config.u9MetaTriageFallbackModelId;
          lastResult = await callLlm({
            modelId: config.u9MetaTriageFallbackModelId,
            maxCompletionTokens: config.u9MetaTriageRetryMaxCompletionTokens,
            retryHint: 'Return JSON only.',
            useStructured: shouldUseStructuredMetaTriageOutput(config.u9MetaTriageFallbackModelId),
          });
          modelChain.push(lastResult.model_id);
          attempt = 2;
          pushTrail(2, lastResult, 'fallback');
          logAttempt(2, lastResult, 'ok');
          raw = lastResult.content;
        } catch (fallbackErr) {
          pushTrailFailed(
            2,
            config.u9MetaTriageFallbackModelId,
            'error',
            fallbackErr,
            config.u9MetaTriageRetryMaxCompletionTokens
          );
          throw fallbackErr;
        }
      } else {
        throw firstErr;
      }
    }

    let selectedIndices = parseMetaTriageIndices(raw, maxIndex, maxSelect);

    if (selectedIndices.length === 0 && retries > 0 && attempt === 1) {
      const parseRetryAttempt1 = 2;
      try {
        lastAttemptModelId = config.u9MetaTriageModelId;
        lastResult = await callLlm({
          modelId: config.u9MetaTriageModelId,
          maxCompletionTokens: config.u9MetaTriageRetryMaxCompletionTokens,
          retryHint: 'Return JSON only. No other text.',
          useStructured: shouldUseStructuredMetaTriageOutput(config.u9MetaTriageModelId),
        });
        modelChain.push(lastResult.model_id);
        attempt = parseRetryAttempt1;
        pushTrail(parseRetryAttempt1, lastResult, 'ok');
        logAttempt(parseRetryAttempt1, lastResult, 'parse_retry');
        raw = lastResult.content;
        selectedIndices = parseMetaTriageIndices(raw, maxIndex, maxSelect);
      } catch (parseRetryErr) {
        attempt = parseRetryAttempt1;
        pushTrailFailed(
          parseRetryAttempt1,
          config.u9MetaTriageModelId,
          'error',
          parseRetryErr,
          config.u9MetaTriageRetryMaxCompletionTokens
        );
        throw parseRetryErr;
      }
      if (selectedIndices.length === 0 && config.u9MetaTriageModelId !== config.u9MetaTriageFallbackModelId) {
        const parseRetryAttempt2 = 3;
        try {
          lastAttemptModelId = config.u9MetaTriageFallbackModelId;
          lastResult = await callLlm({
            modelId: config.u9MetaTriageFallbackModelId,
            maxCompletionTokens: config.u9MetaTriageRetryMaxCompletionTokens,
            retryHint: 'Return JSON only.',
            useStructured: shouldUseStructuredMetaTriageOutput(config.u9MetaTriageFallbackModelId),
          });
          modelChain.push(lastResult.model_id);
          attempt = parseRetryAttempt2;
          pushTrail(parseRetryAttempt2, lastResult, 'fallback');
          logAttempt(parseRetryAttempt2, lastResult, 'parse_retry');
          raw = lastResult.content;
          selectedIndices = parseMetaTriageIndices(raw, maxIndex, maxSelect);
        } catch (fallbackParseErr) {
          attempt = parseRetryAttempt2;
          pushTrailFailed(
            parseRetryAttempt2,
            config.u9MetaTriageFallbackModelId,
            'error',
            fallbackParseErr,
            config.u9MetaTriageRetryMaxCompletionTokens
          );
          throw fallbackParseErr;
        }
      }
    }

    if (selectedIndices.length === 0) {
      pushTrail(attempt, lastResult, 'parse_fail');
      selectedIndices = gapFreeDeterministicFallback(sortedHits, userQuery, maxSelect);
      logger.warn('u9_meta_triage: no valid JSON after retry — gap-free deterministic fallback', {
        ...ctx,
        raw: raw.slice(0, 120),
        fallback_count: selectedIndices.length,
        triage_attempts: attempt,
        triage_model_chain: modelChain,
      });
      return {
        selectedIndices,
        skipped: false,
        model: modelChain[modelChain.length - 1] ?? config.u9MetaTriageModelId,
        latencyMs: Date.now() - t0,
        parse_ok: false,
        fallback_used: true,
        fallback_mode: 'gap_free_deterministic',
        reason_code: 'parse_fail',
        finish_reason: lastResult.finish_reason ?? null,
        raw_content_type: lastResult.raw_content_type ?? null,
        reasoning_tokens: lastResult.reasoning_tokens ?? null,
        triage_attempts: attemptTrail.length ? Math.max(...attemptTrail.map((e) => e.attempt_no)) : attempt,
        triage_model_chain: modelChain.length ? modelChain : undefined,
        triage_attempt_trail: attemptTrail.length ? attemptTrail : undefined,
      };
    }

    const trailMaxAttempt = attemptTrail.length ? Math.max(...attemptTrail.map((e) => e.attempt_no)) : attempt;
    logger.info('u9_meta_triage: complete', {
      ...ctx,
      total_hits: sortedHits.length,
      selected_count: selectedIndices.length,
      latency_ms: Date.now() - t0,
      parse_ok: true,
      triage_attempts: trailMaxAttempt,
      selected_score_range:
        selectedIndices.length > 0
          ? `${sortedHits[Math.min(...selectedIndices)]?.score?.toFixed(3)}–${sortedHits[Math.max(...selectedIndices)]?.score?.toFixed(3)}`
          : '—',
    });

    return {
      selectedIndices,
      skipped: false,
      model: lastResult.model_id,
      latencyMs: Date.now() - t0,
      parse_ok: true,
      fallback_used: false,
      fallback_mode: undefined,
      reason_code: null,
      finish_reason: lastResult.finish_reason ?? null,
      raw_content_type: lastResult.raw_content_type ?? null,
      reasoning_tokens: lastResult.reasoning_tokens ?? null,
      triage_attempts: trailMaxAttempt,
      triage_model_chain: modelChain.length ? modelChain : undefined,
      triage_attempt_trail: attemptTrail.length ? attemptTrail : undefined,
    };
  } catch (err) {
    const lastEntry = attemptTrail[attemptTrail.length - 1];
    if (lastEntry?.outcome !== 'error') {
      pushTrailFailed(attempt, lastAttemptModelId, 'error', err);
    }
    const reasonCode =
      err instanceof OpenRouterError && err.code === 'EMPTY_OUTPUT_LENGTH'
        ? 'empty_output_length'
        : err instanceof OpenRouterError && err.code === 'EMPTY_ASSISTANT_CONTENT'
          ? 'empty_assistant_content'
          : err instanceof OpenRouterError && err.code === 'INVALID_RESPONSE'
            ? 'openrouter_missing_content'
            : err instanceof OpenRouterError && err.code === 'TIMEOUT'
              ? 'openrouter_timeout'
              : 'triage_error';
    logger.warn('u9_meta_triage: failed (non-fatal)', {
      ...ctx,
      error: err instanceof Error ? err.message : String(err),
      reason_code: reasonCode,
      latency_ms: Date.now() - t0,
    });
    const fallback = gapFreeDeterministicFallback(sortedHits, userQuery, maxSelect);
    return {
      selectedIndices: fallback,
      skipped: false,
      latencyMs: Date.now() - t0,
      parse_ok: false,
      fallback_used: true,
      fallback_mode: 'gap_free_deterministic',
      reason_code: reasonCode,
      finish_reason: null,
      raw_content_type: null,
      reasoning_tokens: null,
      triage_attempts: attemptTrail.length ? Math.max(...attemptTrail.map((e) => e.attempt_no)) : attempt,
      triage_model_chain: modelChain.length ? modelChain : [lastAttemptModelId],
      triage_attempt_trail: attemptTrail.length ? attemptTrail : undefined,
    };
  }
}
