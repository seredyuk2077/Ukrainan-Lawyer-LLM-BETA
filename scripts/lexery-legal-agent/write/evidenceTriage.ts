/**
 * Evidence Triage — two-stage cost-efficient law snippet selection for U10.
 *
 * DEV RUN v10: when law snippets > EVIDENCE_TRIAGE_THRESHOLD, runs a cheap
 * Stage 1 (Haiku) pass over short excerpts to select the most relevant subset.
 * Only selected snippets are passed to the expensive thinking model (Stage 2).
 *
 * Token discipline:
 *   - Stage 1 input: only excerpt (first 200 chars) + act_title + rank per snippet
 *   - Stage 1 output: JSON array of selected ranks + 1-line reason each
 *   - Stage 2 input: only selected contextParts with full text
 *
 * Deterministic tie-breaking: stable by original rank (lower rank = higher Qdrant score).
 *
 * Usage:
 *   const { selected, triagedCount, droppedCount } = await triageEvidence(assembled, userQuery);
 *   const triaged = { ...assembled, contextParts: selected };
 */
import { config } from '../lib/config.js';
import { extractFirstJsonArray, extractFirstJsonObject } from '../lib/jsonExtract.js';
import { openRouterChat, OpenRouterError } from '../lib/openrouter.js';
import { logger } from '../lib/logger.js';
import type { AssembledPrompt, ContextPart, LawSourceRef } from '../lib/pipeline/contracts.js';
import { embedQuery, embedMany } from '../retrieval/embedding.js';

export interface EvidenceBoundsResolved {
  soft_min: number;
  hard_min: number;
  effective_min: number;
  effective_max: number;
}

export interface TriageResult {
  /** Filtered contextParts (law only; others passed through unchanged). */
  selected: ContextPart[];
  /** How many law snippets were evaluated. */
  triagedCount: number;
  /** How many were dropped. */
  droppedCount: number;
  /** Triage was skipped (below threshold or disabled). */
  skipped: boolean;
  /** Model used for Stage 1. */
  model?: string;
  latencyMs: number;
  parse_ok?: boolean;
  fallback_used?: boolean;
  fallback_mode?: string;
  reason_code?: string | null;
  finish_reason?: string | null;
  raw_content_type?: string | null;
  reasoning_tokens?: number | null;
  triage_attempts?: number;
  triage_model_chain?: string[];
  triage_attempt_trail?: Array<{
    attempt_no: number;
    model_id: string;
    finish_reason?: string | null;
    raw_content_type?: string | null;
    reasoning_tokens?: number | null;
    token_budget?: number | null;
    /** Optional OpenRouter error code when attempt failed/retired. */
    error_code?: string | null;
    outcome: 'ok' | 'retry' | 'fallback' | 'parse_fail' | 'error';
  }>;
  /** PHASE 1 explainability. */
  bounds_resolved?: EvidenceBoundsResolved;
  topup_applied?: boolean;
  topup_reason?: null | 'parse_fail' | 'below_hard_min' | 'below_effective_min';
  topup_target?: 'hard_min' | 'effective_min';
  effective_min_applied?: number;
  fallback_scoring_version?: number;
}

const CALLER = 'u10-evidence-triage';

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
 * Resolve evidence triage min/max from query and law count (no domain heuristics).
 * Config min/max is the base frame; query-shape (comparison/multipart) can raise within frame.
 */
export function resolveEvidenceBounds(
  query: string,
  lawCount: number,
  cfg: {
    evidenceTriageMinSelected: number;
    evidenceTriageMaxSelected: number;
    evidenceTriageSoftMin: number;
    evidenceTriageHardMin: number;
  }
): EvidenceBoundsResolved {
  const configMin = cfg.evidenceTriageMinSelected;
  const configMax = cfg.evidenceTriageMaxSelected;
  let queryMin = 3;
  let queryMax = 6;
  if (isComparisonLikeQuery(query) || isMultiPartQuery(query)) {
    queryMin = 5;
    queryMax = 8;
  }
  const max = Math.min(Math.max(queryMax, configMin), lawCount, configMax);
  const min = Math.min(Math.max(queryMin, configMin), lawCount, max);
  const softMin = Math.min(cfg.evidenceTriageSoftMin, 8);
  const hardMin = Math.min(cfg.evidenceTriageHardMin, 4);
  return {
    soft_min: Math.min(softMin, max),
    hard_min: Math.min(hardMin, min),
    effective_min: min,
    effective_max: max,
  };
}

/**
 * Unicode-safe tokenization for overlap (Cyrillic, Latin, digits).
 * \W+ in JS drops Cyrillic; use \p{L}\p{N} to keep letters/numbers.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Extract a query-aware excerpt: window of text that maximizes token overlap with query.
 * Falls back to first excerptChars if no overlap.
 */
export function queryAwareExcerpt(text: string, query: string, excerptChars: number): string {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return text.slice(0, excerptChars).replace(/\n+/g, ' ').trim();
  const normalized = text.replace(/\n+/g, ' ').trim();
  if (normalized.length <= excerptChars) return normalized;
  let bestStart = 0;
  let bestOverlap = 0;
  const step = Math.max(1, Math.floor(excerptChars / 4));
  for (let start = 0; start <= Math.min(normalized.length - excerptChars, 2000); start += step) {
    const window = normalized.slice(start, start + excerptChars);
    const wTokens = tokenize(window);
    const overlap = wTokens.filter((t) => qTokens.has(t)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestStart = start;
    }
  }
  const excerpt = bestOverlap > 0
    ? normalized.slice(bestStart, bestStart + excerptChars)
    : normalized.slice(0, excerptChars);
  return excerpt.trim();
}

/** Parse LLM output to array of indices (array or object with selected_indices). Bracket-balanced extraction. */
function parseTriageIndices(raw: string, lawCount: number, maxSelect: number): number[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const normalize = (arr: unknown[]): number[] => {
    const clamped: number[] = [];
    const maxIndex = Math.max(0, lawCount - 1);
    for (const x of arr) {
      if (typeof x !== 'number' || !Number.isFinite(x) || !Number.isInteger(x)) continue;
      const v = Math.max(0, Math.min(maxIndex, x));
      clamped.push(v);
    }
    const uniq = Array.from(new Set(clamped)).sort((a, b) => a - b);
    return uniq.slice(0, maxSelect);
  };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return normalize(parsed as unknown[]);
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const arr = (obj.selected_indices ?? obj.indices) as unknown;
      if (Array.isArray(arr)) {
        return normalize(arr as unknown[]);
      }
    }
  } catch {
    // fall through
  }

  const arrayStr = extractFirstJsonArray(trimmed);
  if (arrayStr) {
    try {
      const parsed = JSON.parse(arrayStr) as unknown;
      if (Array.isArray(parsed)) {
        return normalize(parsed as unknown[]);
      }
    } catch {
      // fall through
    }
  }

  const objectStr = extractFirstJsonObject(trimmed);
  if (objectStr) {
    try {
      const obj = JSON.parse(objectStr) as Record<string, unknown>;
      const arr = (obj.selected_indices ?? obj.indices) as unknown;
      if (Array.isArray(arr)) {
        return normalize(arr as unknown[]);
      }
    } catch {
      // fall through
    }
  }
  return [];
}

/** Cosine similarity normalized to [0, 1]. */
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

/**
 * Deterministic fallback selection when triage parse fails or errors.
 * Score = 0.45*semantic + 0.30*lexical + 0.20*rank_prior + 0.05*diversity_bonus (no legal wordlists).
 * If embedding fails, uses lexical+rank+diversity only.
 */
async function deterministicFallbackSelection(
  lawParts: ContextPart[],
  userQuery: string,
  effectiveMin: number,
  effectiveMax: number,
  excerptChars: number
): Promise<number[]> {
  const n = lawParts.length;
  if (n === 0) return [];
  const qTokens = new Set(tokenize(userQuery));
  const maxPerSource = 4;
  let queryEmb: number[] | null = null;
  const excerptEmbs: (number[] | null)[] = [];
  try {
    queryEmb = (await embedQuery(userQuery.slice(0, 2000))).embedding;
    const excerpts = lawParts.map((p) => queryAwareExcerpt(p?.text ?? '', userQuery, excerptChars));
    const batch = await embedMany(excerpts);
    for (let i = 0; i < lawParts.length; i++) {
      excerptEmbs.push(batch[i] ? batch[i].embedding : null);
    }
  } catch {
    queryEmb = null;
    excerptEmbs.length = 0;
  }
  const perSource = new Map<string, number>();
  const selected: number[] = [];
  const remaining = [...Array(n).keys()];
  const lexical = (idx: number): number => {
    const part = lawParts[idx];
    const tokens = tokenize(part?.text ?? '');
    const overlap = tokens.filter((t) => qTokens.has(t)).length / Math.max(1, qTokens.size);
    return Math.min(1, overlap * 2);
  };
  const noveltyPenalty = (idx: number): number => {
    if (selected.length === 0) return 0;
    const part = lawParts[idx];
    const tokens = new Set(tokenize(part?.text ?? ''));
    let maxSim = 0;
    for (const j of selected) {
      const other = lawParts[j];
      const otherTokens = new Set(tokenize(other?.text ?? ''));
      const inter = [...tokens].filter((t) => otherTokens.has(t)).length;
      const sim = inter / Math.max(1, tokens.size + otherTokens.size - inter);
      if (sim > maxSim) maxSim = sim;
    }
    return maxSim;
  };
  const semantic = (idx: number): number => {
    if (!queryEmb || !excerptEmbs[idx]) return 0;
    const emb = excerptEmbs[idx];
    return emb ? cosineNorm(queryEmb, emb) : 0;
  };
  while (selected.length < effectiveMax && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -1e9;
    let bestPos = -1;
    for (let pos = 0; pos < remaining.length; pos++) {
      const idx = remaining[pos]!;
      const ref = lawParts[idx]?.sourceRef as LawSourceRef | undefined;
      const key = ref?.r2_key ?? ref?.act_title ?? '';
      if ((perSource.get(key) ?? 0) >= maxPerSource) continue;
      const rankPrior = 1 - idx / Math.max(1, n);
      const lex = lexical(idx);
      const sem = semantic(idx);
      const nov = noveltyPenalty(idx);
      const diversityBonus = (perSource.get(key) ?? 0) === 0 ? 1 : 0;
      const score =
        (queryEmb ? 0.45 * sem + 0.3 * lex + 0.05 * diversityBonus : 0.5 * lex + 0.35 * rankPrior + 0.15 * diversityBonus) +
        (queryEmb ? 0.2 * rankPrior : 0) -
        0.2 * nov;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
        bestPos = pos;
      }
    }
    if (bestIdx === -1) break;
    const ref = lawParts[bestIdx]?.sourceRef as LawSourceRef | undefined;
    const key = ref?.r2_key ?? ref?.act_title ?? '';
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
    selected.push(bestIdx);
    remaining.splice(bestPos, 1);
  }
  const needTopUp = Math.max(0, effectiveMin - selected.length);
  if (needTopUp > 0 && remaining.length > 0) {
    const byRel = remaining.sort((a, b) => lexical(b) - lexical(a));
    for (let i = 0; i < Math.min(needTopUp, byRel.length); i++) {
      const idx = byRel[i]!;
      const ref = lawParts[idx]?.sourceRef as LawSourceRef | undefined;
      const key = ref?.r2_key ?? ref?.act_title ?? '';
      if ((perSource.get(key) ?? 0) < maxPerSource) {
        selected.push(idx);
        perSource.set(key, (perSource.get(key) ?? 0) + 1);
      }
    }
  }
  return selected.sort((a, b) => a - b).slice(0, effectiveMax);
}

/**
 * Run two-stage evidence triage on an assembled prompt.
 * Returns a TriageResult with filtered contextParts.
 * Non-fatal: on any error returns original assembled unchanged (skipped=true).
 */
export async function triageEvidence(
  assembled: AssembledPrompt,
  userQuery: string,
  apiKey: string,
  runId?: string
): Promise<TriageResult> {
  const ctx = { run_id: runId, module: 'write/evidenceTriage' };
  const t0 = Date.now();

  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  const otherParts = assembled.contextParts.filter((p) => p.type !== 'law');

  // Skip if below threshold or disabled
  if (!config.evidenceTriageEnabled || lawParts.length <= config.evidenceTriageThreshold) {
    logger.debug('evidence_triage: skipped', {
      ...ctx,
      reason: !config.evidenceTriageEnabled ? 'disabled' : 'below_threshold',
      law_count: lawParts.length,
      threshold: config.evidenceTriageThreshold,
    });
    return {
      selected: assembled.contextParts,
      triagedCount: lawParts.length,
      droppedCount: 0,
      skipped: true,
      latencyMs: 0,
    };
  }

  // Resolve bounds from query + law count (no domain heuristics)
  const bounds_resolved = resolveEvidenceBounds(userQuery, lawParts.length, {
    evidenceTriageMinSelected: config.evidenceTriageMinSelected,
    evidenceTriageMaxSelected: config.evidenceTriageMaxSelected,
    evidenceTriageSoftMin: config.evidenceTriageSoftMin,
    evidenceTriageHardMin: config.evidenceTriageHardMin,
  });
  const effectiveMin = bounds_resolved.effective_min;
  const effectiveMax = bounds_resolved.effective_max;
  const maxSelect = effectiveMax;

  // Stage 1: build triage prompt with heading/article/source + query-aware excerpt
  const excerptChars = config.evidenceTriageExcerptChars;
  const snippetLines = lawParts.map((part, idx) => {
    const lawRef = part.sourceRef as LawSourceRef | undefined;
    const source = lawRef?.act_title ?? lawRef?.r2_key ?? '';
    const title = source ? `[${source}]` : '';
    const article = lawRef?.article_number ? ` ст.${lawRef.article_number}` : '';
    const excerpt = queryAwareExcerpt(part.text, userQuery, excerptChars);
    return `${idx}: ${title}${article} "${excerpt}"`;
  });

  const triageSystemPrompt =
    'You are a legal evidence relevance selector. ' +
    'Given a user question and a numbered list of law snippet excerpts (heading/source, article, excerpt), ' +
    'select the ones needed to answer (admin vs criminal, specific articles, etc.). ' +
    'Output ONLY a JSON object with an "indices" array of 0-based integers. No markdown, no comments. ' +
    `Select at least ${effectiveMin} and at most ${effectiveMax} snippets so the answer can cite and compare norms. Example: {"indices":[0,2,5,7]}`;

  const triageUserContent =
    `User question: ${userQuery.slice(0, 300)}\n\nLaw snippets:\n${snippetLines.join('\n')}`;

  const EVIDENCE_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
      name: 'evidence_indices',
      strict: true,
      schema: {
        type: 'object',
        properties: { indices: { type: 'array', items: { type: 'integer' }, description: '0-based indices of selected snippets' } },
        required: ['indices'],
        additionalProperties: false,
      },
    },
  } as const;

  type TriageCallResult = {
    content: string;
    model_id: string;
    latency_ms: number;
    finish_reason?: string;
    raw_content_type?: string;
    reasoning_tokens?: number;
    request_effective_token_budget?: number;
  };
  const callTriage = async (opts: {
    modelId: string;
    maxCompletionTokens: number;
    retryHint?: string;
    useStructured?: boolean;
  }): Promise<TriageCallResult> => {
    const systemContent = triageSystemPrompt + (opts.retryHint ? ` ${opts.retryHint}` : '');
    const result = await openRouterChat(
      apiKey,
      {
        model: opts.modelId,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: triageUserContent },
        ],
        temperature: 0.0,
        max_completion_tokens: opts.maxCompletionTokens,
        caller: CALLER,
        reasoning: { effort: 'low' },
        ...(opts.useStructured !== false && { response_format: EVIDENCE_RESPONSE_FORMAT }),
      },
      15
    );
    return {
      content: result.content,
      model_id: result.model_id,
      latency_ms: result.latency_ms,
      finish_reason: result.finish_reason,
      raw_content_type: result.raw_content_type,
      reasoning_tokens: result.reasoning_tokens,
      request_effective_token_budget: result.request_effective_token_budget,
    };
  };

  const logAttempt = (attempt: number, r: TriageCallResult, outcome: string) => {
    logger.info('evidence_triage: attempt', {
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

  const isLengthOrEmpty = (code: string) => code === 'EMPTY_OUTPUT_LENGTH' || code === 'EMPTY_ASSISTANT_CONTENT';
  const isRetryableCode = (code: string) =>
    isLengthOrEmpty(code) || code === 'INVALID_RESPONSE' || code === 'TIMEOUT' || code === 'HTTP_ERROR';

  type TrailEntry = NonNullable<TriageResult['triage_attempt_trail']>[number];
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

  let attempt = 1;
  let lastAttemptModelId = config.evidenceTriageModelId;
  const modelChain: string[] = [];
  try {
    let result: TriageCallResult;

    try {
      lastAttemptModelId = config.evidenceTriageModelId;
      result = await callTriage({
        modelId: config.evidenceTriageModelId,
        maxCompletionTokens: config.evidenceTriageMaxCompletionTokens,
        useStructured: true,
      });
      modelChain.push(result.model_id);
      pushTrail(1, result, 'ok');
      logAttempt(1, result, 'ok');
    } catch (firstErr) {
      pushTrailFailed(
        1,
        config.evidenceTriageModelId,
        'retry',
        firstErr,
        config.evidenceTriageMaxCompletionTokens
      );
      // Do not push config id as "actual" model — modelChain only actual result.model_id
      const code = firstErr instanceof OpenRouterError ? firstErr.code : '';
      if (isLengthOrEmpty(code)) {
        logger.info('evidence_triage: retry primary with higher token budget', { ...ctx, reason: code });
        try {
          lastAttemptModelId = config.evidenceTriageModelId;
          result = await callTriage({
            modelId: config.evidenceTriageModelId,
            maxCompletionTokens: config.evidenceTriageRetryMaxCompletionTokens,
            retryHint: 'Return JSON only.',
            useStructured: true,
          });
          modelChain.push(result.model_id);
          attempt = 2;
          pushTrail(2, result, 'ok');
          logAttempt(2, result, 'ok');
        } catch (retryErr) {
          pushTrailFailed(
            2,
            config.evidenceTriageModelId,
            'retry',
            retryErr,
            config.evidenceTriageRetryMaxCompletionTokens
          );
          logger.info('evidence_triage: primary retry failed, trying fallback model', { ...ctx });
          try {
            lastAttemptModelId = config.evidenceTriageFallbackModelId;
            result = await callTriage({
              modelId: config.evidenceTriageFallbackModelId,
              maxCompletionTokens: config.evidenceTriageRetryMaxCompletionTokens,
              retryHint: 'Return JSON only.',
              useStructured: true,
            });
            modelChain.push(result.model_id);
            attempt = 3;
            pushTrail(3, result, 'fallback');
            logAttempt(3, result, 'ok');
          } catch (fallbackErr) {
            pushTrailFailed(
              3,
              config.evidenceTriageFallbackModelId,
              'error',
              fallbackErr,
              config.evidenceTriageRetryMaxCompletionTokens
            );
            throw fallbackErr;
          }
        }
      } else if (isRetryableCode(code)) {
        logger.info('evidence_triage: retry with fallback model', { ...ctx, reason: code });
        try {
          lastAttemptModelId = config.evidenceTriageFallbackModelId;
          result = await callTriage({
            modelId: config.evidenceTriageFallbackModelId,
            maxCompletionTokens: config.evidenceTriageRetryMaxCompletionTokens,
            retryHint: 'Return JSON only.',
            useStructured: true,
          });
          modelChain.push(result.model_id);
          attempt = 2;
          pushTrail(2, result, 'fallback');
          logAttempt(2, result, 'ok');
        } catch (fallbackErr) {
          pushTrailFailed(
            2,
            config.evidenceTriageFallbackModelId,
            'error',
            fallbackErr,
            config.evidenceTriageRetryMaxCompletionTokens
          );
          throw fallbackErr;
        }
      } else {
        throw firstErr;
      }
    }

    let raw = result.content.trim();
    let selectedIndices = parseTriageIndices(raw, lawParts.length, maxSelect);

    if (selectedIndices.length === 0) {
      const parseRetryAttempt1 = attempt + 1;
      try {
        lastAttemptModelId = config.evidenceTriageModelId;
        result = await callTriage({
          modelId: config.evidenceTriageModelId,
          maxCompletionTokens: config.evidenceTriageRetryMaxCompletionTokens,
          retryHint: 'Return JSON only. No other text.',
          useStructured: true,
        });
        modelChain.push(result.model_id);
        attempt = parseRetryAttempt1;
        pushTrail(attempt, result, 'ok');
        logAttempt(attempt, result, 'parse_retry');
        raw = result.content.trim();
        selectedIndices = parseTriageIndices(raw, lawParts.length, maxSelect);
      } catch (parseRetryErr) {
        attempt = parseRetryAttempt1;
        pushTrailFailed(
          parseRetryAttempt1,
          config.evidenceTriageModelId,
          'error',
          parseRetryErr,
          config.evidenceTriageRetryMaxCompletionTokens
        );
        throw parseRetryErr;
      }
      if (selectedIndices.length === 0 && config.evidenceTriageModelId !== config.evidenceTriageFallbackModelId) {
        const parseRetryAttempt2 = attempt + 1;
        try {
          lastAttemptModelId = config.evidenceTriageFallbackModelId;
          result = await callTriage({
            modelId: config.evidenceTriageFallbackModelId,
            maxCompletionTokens: config.evidenceTriageRetryMaxCompletionTokens,
            retryHint: 'Return JSON only.',
            useStructured: true,
          });
          modelChain.push(result.model_id);
          attempt = parseRetryAttempt2;
          pushTrail(attempt, result, 'fallback');
          logAttempt(attempt, result, 'parse_retry');
          raw = result.content.trim();
          selectedIndices = parseTriageIndices(raw, lawParts.length, maxSelect);
        } catch (fallbackParseErr) {
          attempt = parseRetryAttempt2;
          pushTrailFailed(
            parseRetryAttempt2,
            config.evidenceTriageFallbackModelId,
            'error',
            fallbackParseErr,
            config.evidenceTriageRetryMaxCompletionTokens
          );
          throw fallbackParseErr;
        }
      }
    }

    if (selectedIndices.length === 0) {
      attemptTrail.push({
        attempt_no: attempt,
        model_id: result.model_id,
        finish_reason: result.finish_reason ?? null,
        raw_content_type: result.raw_content_type ?? null,
        reasoning_tokens: result.reasoning_tokens ?? null,
        token_budget: result.request_effective_token_budget ?? null,
        outcome: 'parse_fail',
      });
      attemptTrail.push({
        attempt_no: attempt,
        model_id: 'deterministic_fallback',
        finish_reason: null,
        raw_content_type: null,
        reasoning_tokens: null,
        token_budget: null,
        outcome: 'fallback',
      });
      const fallbackIndices = await deterministicFallbackSelection(
        lawParts,
        userQuery,
        effectiveMin,
        effectiveMax,
        excerptChars
      );
      const fallbackSelected = fallbackIndices.map((i) => lawParts[i]).filter(Boolean);
      const finalParts = [...fallbackSelected, ...otherParts];
      logger.warn('evidence_triage: no valid indices after retry — deterministic fallback', {
        ...ctx,
        raw: raw.slice(0, 100),
        fallback_count: fallbackIndices.length,
        triage_attempts: attemptTrail.length ? Math.max(...attemptTrail.map((e) => e.attempt_no)) : attempt,
      });
      return {
        selected: finalParts,
        triagedCount: lawParts.length,
        droppedCount: lawParts.length - fallbackSelected.length,
        skipped: false,
        latencyMs: Date.now() - t0,
        parse_ok: false,
        fallback_used: true,
        fallback_mode: 'deterministic',
        reason_code: 'parse_fail_deterministic_fallback',
        triage_attempts: attemptTrail.length ? Math.max(...attemptTrail.map((e) => e.attempt_no)) : attempt,
        triage_model_chain: modelChain,
        triage_attempt_trail: attemptTrail.length ? attemptTrail : undefined,
        bounds_resolved,
        topup_applied: false,
        topup_reason: null,
        fallback_scoring_version: 1,
      };
    }

    // Bounds enforcement: top-up to effective_min when selected < effective_min (hard_min only for fallback)
    let topup_applied = false;
    let topup_reason: null | 'parse_fail' | 'below_hard_min' | 'below_effective_min' = null;
    let topup_target: 'hard_min' | 'effective_min' | undefined;
    const effective_min_applied = bounds_resolved.effective_min;
    if (
      selectedIndices.length < effective_min_applied &&
      lawParts.length >= effective_min_applied
    ) {
      const beforeCount = selectedIndices.length;
      const selectedSet = new Set(selectedIndices);
      const droppedIndices = [...Array(lawParts.length).keys()].filter((i) => !selectedSet.has(i));
      const need = Math.min(
        effective_min_applied - beforeCount,
        droppedIndices.length,
        maxSelect - beforeCount
      );
      const qTokens = new Set(tokenize(userQuery));
      const sourceCount = new Map<string, number>();
      for (const i of selectedIndices) {
        const ref = lawParts[i]?.sourceRef as LawSourceRef | undefined;
        const key = ref?.r2_key ?? ref?.act_title ?? '';
        sourceCount.set(key, (sourceCount.get(key) ?? 0) + 1);
      }
      const combinedScore = (idx: number): number => {
        const part = lawParts[idx];
        const rankPrior = 1 - idx / Math.max(1, lawParts.length);
        const textTokens = tokenize(part?.text ?? '');
        const overlap = textTokens.filter((t) => qTokens.has(t)).length / Math.max(1, qTokens.size);
        const ref = part?.sourceRef as LawSourceRef | undefined;
        const key = ref?.r2_key ?? ref?.act_title ?? '';
        const already = sourceCount.get(key) ?? 0;
        const diversityBonus = already === 0 ? 0.2 : already >= 3 ? -0.1 : 0;
        return 0.5 * rankPrior + 0.4 * Math.min(1, overlap * 2) + diversityBonus;
      };
      const topUp = droppedIndices
        .sort((a, b) => combinedScore(b) - combinedScore(a))
        .slice(0, need);
      selectedIndices = [...selectedIndices, ...topUp].sort((a, b) => a - b).slice(0, maxSelect);
      topup_applied = topUp.length > 0;
      topup_reason = 'below_effective_min';
      topup_target = 'effective_min';
      logger.info('evidence_triage: top-up to effective_min', {
        ...ctx,
        effective_min: effective_min_applied,
        before_topup: beforeCount,
        added: topUp.length,
        final_count: selectedIndices.length,
      });
    }
    if (selectedIndices.length < effective_min_applied && lawParts.length >= effective_min_applied) {
      logger.warn('evidence_triage: selected still below effective_min after top-up (insufficient pool)', {
        ...ctx,
        effective_min: effective_min_applied,
        selected: selectedIndices.length,
        law_count: lawParts.length,
      });
    }

    const selectedLawParts = selectedIndices.map((i) => lawParts[i]);
    const droppedCount = lawParts.length - selectedLawParts.length;

    logger.info('evidence_triage: complete', {
      ...ctx,
      total_law: lawParts.length,
      selected_count: selectedLawParts.length,
      dropped_count: droppedCount,
      model: result.model_id,
      latency_ms: result.latency_ms,
      parse_ok: true,
    });

    // Reconstruct contextParts: selected law parts (in original order) + all other parts
    const finalParts = [...selectedLawParts, ...otherParts];

    return {
      selected: finalParts,
      triagedCount: lawParts.length,
      droppedCount,
      skipped: false,
      model: result.model_id,
      latencyMs: Date.now() - t0,
      parse_ok: true,
      fallback_used: false,
      reason_code: null,
      finish_reason: result.finish_reason ?? null,
      raw_content_type: result.raw_content_type ?? null,
      reasoning_tokens: result.reasoning_tokens ?? null,
      triage_attempts: attemptTrail.length ? Math.max(...attemptTrail.map((e) => e.attempt_no)) : attempt,
      triage_model_chain: modelChain,
      triage_attempt_trail: attemptTrail.length ? attemptTrail : undefined,
      bounds_resolved,
      topup_applied,
      topup_reason,
      topup_target,
      effective_min_applied,
    };
  } catch (err) {
    const lastEntry = attemptTrail[attemptTrail.length - 1];
    if (lastEntry?.outcome !== 'error') {
      pushTrailFailed(attempt, lastAttemptModelId, 'error', err);
    }
    attemptTrail.push({
      attempt_no: attempt,
      model_id: 'deterministic_fallback',
      finish_reason: null,
      raw_content_type: null,
      reasoning_tokens: null,
      token_budget: null,
      error_code: null,
      outcome: 'fallback',
    });
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
    logger.warn('evidence_triage: failed (non-fatal) — deterministic fallback', {
      ...ctx,
      error: err instanceof Error ? err.message : String(err),
      reason_code: reasonCode,
      latency_ms: Date.now() - t0,
    });
    const excerptCharsForFallback = config.evidenceTriageExcerptChars;
    const fallbackIndices = await deterministicFallbackSelection(
      lawParts,
      userQuery,
      effectiveMin,
      effectiveMax,
      excerptCharsForFallback
    );
    const fallbackSelected = fallbackIndices.map((i) => lawParts[i]).filter(Boolean);
    const finalParts = [...fallbackSelected, ...otherParts];
    return {
      selected: finalParts,
      triagedCount: lawParts.length,
      droppedCount: lawParts.length - fallbackSelected.length,
      skipped: false,
      latencyMs: Date.now() - t0,
      parse_ok: false,
      fallback_used: true,
      fallback_mode: 'deterministic',
      reason_code: 'triage_error_deterministic_fallback',
      triage_attempts: attemptTrail.length ? Math.max(...attemptTrail.map((e) => e.attempt_no)) : attempt,
      triage_model_chain: modelChain.length ? modelChain : [lastAttemptModelId],
      triage_attempt_trail: attemptTrail.length ? attemptTrail : undefined,
      bounds_resolved,
      topup_applied: false,
      topup_reason: null,
      fallback_scoring_version: 1,
    };
  }
}
