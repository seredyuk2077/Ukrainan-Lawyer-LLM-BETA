/**
 * U2 LLM Classifier — OpenRouter call, JSON parse, zod validation.
 * On invalid JSON: 1 retry, then throw (caller does degraded fallback).
 */
import { openRouterChat, OpenRouterError } from '../lib/openrouter.js';
import { logger } from '../lib/logger.js';
import { tryParseLLMOutputWithReason, type LLMClassifyOutput } from './schema.js';
import { getU2ClassifyMessages } from './prompts/u2_classify_v1.js';
import { U2_CLASSIFY_PROMPT_VERSION } from './prompts/u2_classify_v1.js';
import type { ExtractedEntity } from './types.js';

export interface LLMClassifyInput {
  query: string;
  pre_entities: ExtractedEntity[];
  language?: string;
  jurisdiction?: string;
}

export interface LLMClassifyResult {
  intent: LLMClassifyOutput['intent'];
  domain: LLMClassifyOutput['domain'];
  entities: ExtractedEntity[];
  ambiguity: LLMClassifyOutput['ambiguity'];
  routing_flags?: LLMClassifyOutput['routing_flags'];
  meta: {
    classifier_mode: 'llm';
    model_id: string;
    prompt_version: number;
    latency_ms: number;
    provider?: string;
    retries: number;
    warnings: string[];
  };
}

export interface LLMClassifierConfig {
  apiKey: string;
  modelId: string;
  fallbackModelId?: string;
  timeoutSec: number;
}

// Provider-compatible strict json_schema: every nested object with properties has required listing ALL keys.
// Optionality via nullable values so provider always emits routing_flags and all keys.
export const U2_CLASSIFY_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'u2_classify_output',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['question', 'drafting', 'procedure', 'research', 'other'],
        },
        domain: {
          type: 'string',
          enum: ['criminal', 'civil', 'labor', 'admin', 'tax', 'corporate', 'general'],
        },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['act_abbrev', 'law_title', 'article_ref', 'authority', 'term'] },
              value: { type: 'string' },
              norm: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      act: { type: 'string' },
                      article: { type: 'string' },
                      part: { type: 'string' },
                    },
                    required: ['act', 'article', 'part'],
                    additionalProperties: false,
                  },
                  { type: 'null' },
                ],
              },
            },
            required: ['type', 'value', 'norm'],
            additionalProperties: false,
          },
        },
        ambiguity: {
          type: 'object',
          properties: {
            is_ambiguous: { type: 'boolean' },
            reasons: { type: 'array', items: { type: 'string' } },
            ambig_terms: { type: 'array', items: { type: 'string' } },
          },
          required: ['is_ambiguous', 'reasons', 'ambig_terms'],
          additionalProperties: false,
        },
        routing_flags: {
          type: 'object',
          properties: {
            need_deep_retrieval: { type: ['boolean', 'null'] },
            need_web: { type: ['boolean', 'null'] },
            ambiguous: { type: ['boolean', 'null'] },
            context_mode: { type: ['string', 'null'], enum: ['law', 'memory', 'mixed', null] },
          },
          required: ['need_deep_retrieval', 'need_web', 'ambiguous', 'context_mode'],
          additionalProperties: false,
        },
      },
      required: ['intent', 'domain', 'entities', 'ambiguity', 'routing_flags'],
      additionalProperties: false,
    },
  },
} as const;

/** Fallback response format when provider rejects strict json_schema (e.g. 400). */
const U2_CLASSIFY_RESPONSE_FORMAT_JSON_OBJECT = { type: 'json_object' } as const;

export async function classifyWithLLM(
  config: LLMClassifierConfig,
  input: LLMClassifyInput
): Promise<LLMClassifyResult> {
  const preEntitiesJson = JSON.stringify(
    input.pre_entities.map((e) => ({ type: e.type, value: e.value, norm: e.norm })),
    null,
    0
  );
  const messages = getU2ClassifyMessages(input.query, preEntitiesJson, input.language);
  const warnings: string[] = [];
  let lastError: Error | null = null;
  let modelId = config.modelId;
  let latencyMs = 0;
  let totalRetries = 0;

  /** One model attempt with given response_format and retry on invalid JSON (one retry). */
  const tryWithFormat = async (
    model: string,
    responseFormat: typeof U2_CLASSIFY_RESPONSE_FORMAT | typeof U2_CLASSIFY_RESPONSE_FORMAT_JSON_OBJECT
  ): Promise<LLMClassifyResult> => {
    let modelRetries = 0;
    let lastResult = await openRouterChat(
      config.apiKey,
      {
        model,
        messages,
        temperature: 0.0,
        max_completion_tokens: 1024,
        caller: 'u2-classify',
        response_format: responseFormat,
      },
      config.timeoutSec
    );
    latencyMs = lastResult.latency_ms;
    modelId = lastResult.model_id;
    let parsedRes = tryParseLLMOutputWithReason(lastResult.content);
    let parsed: LLMClassifyOutput | null = parsedRes.parsed;
    if (!parsed && modelRetries === 0) {
      modelRetries = 1;
      warnings.push('llm_invalid_json_retry');
      logger.warn('U2 classifier: invalid JSON on first attempt, retrying', {
        module: 'classify/llm-classifier',
        model_id: lastResult.model_id,
        reason: parsedRes.reason ?? 'parse_failed',
      });
      lastResult = await openRouterChat(
        config.apiKey,
        {
          model,
          messages,
          temperature: 0.0,
          max_completion_tokens: 1024,
          caller: 'u2-classify',
          response_format: responseFormat,
        },
        config.timeoutSec
      );
      latencyMs = lastResult.latency_ms;
      modelId = lastResult.model_id;
      parsedRes = tryParseLLMOutputWithReason(lastResult.content);
      parsed = parsedRes.parsed;
    }
    if (!parsed) {
      logger.warn('U2 classifier: invalid JSON after retry', {
        module: 'classify/llm-classifier',
        model_id: lastResult.model_id,
        reason: parsedRes.reason ?? 'parse_failed',
      });
      throw new Error(`Invalid JSON from LLM after retry: ${parsedRes.reason ?? 'parse_failed'}`);
    }
    totalRetries += modelRetries;
    return {
      intent: parsed.intent,
      domain: parsed.domain,
      entities: parsed.entities as ExtractedEntity[],
      ambiguity: parsed.ambiguity,
      routing_flags: parsed.routing_flags,
      meta: {
        classifier_mode: 'llm',
        model_id: modelId,
        prompt_version: U2_CLASSIFY_PROMPT_VERSION,
        latency_ms: latencyMs,
        provider: lastResult.provider,
        retries: totalRetries,
        warnings,
      },
    };
  };

  try {
    return await tryWithFormat(config.modelId, U2_CLASSIFY_RESPONSE_FORMAT);
  } catch (err) {
    lastError = err as Error;
    if (err instanceof OpenRouterError && err.statusCode === 400) {
      logger.warn('U2 classifier: provider 400, retrying with json_object', {
        module: 'classify/llm-classifier',
        model_id: config.modelId,
        response_format: 'json_schema',
        error_code: err.code,
        response_body_snippet: err.response_body_snippet?.slice(0, 300),
      });
      warnings.push('llm_400_fallback_json_object');
      try {
        return await tryWithFormat(config.modelId, U2_CLASSIFY_RESPONSE_FORMAT_JSON_OBJECT);
      } catch (fallbackErr) {
        lastError = fallbackErr as Error;
      }
    }
    if (config.fallbackModelId && config.modelId !== config.fallbackModelId) {
      warnings.push('llm_primary_fail_fallback');
      try {
        return await tryWithFormat(config.fallbackModelId, U2_CLASSIFY_RESPONSE_FORMAT);
      } catch (err2) {
        lastError = err2 as Error;
      }
    }
  }

  if (lastError) {
    if (lastError instanceof OpenRouterError) {
      if (lastError.code === 'TIMEOUT') warnings.push('llm_timeout');
      else if (lastError.code === 'HTTP_ERROR') warnings.push('llm_http_error');
      else warnings.push('llm_error');
    } else {
      warnings.push('llm_parse_or_validation');
    }
    throw lastError;
  }

  throw lastError ?? new Error('U2 LLM classifier failed');
}

const CONTEXT_MODE_REPAIR_REASON = 'CLASSIFIER_CONTEXT_MODE_REPAIR_FAILED';

export interface RepairContextModeOptions {
  pre_entities?: ExtractedEntity[];
  has_direct_citation?: boolean;
}

/** Bounded repair when primary classify returned context_mode null. One short LLM call; allowed: law | memory | mixed. */
export async function repairContextMode(
  config: LLMClassifierConfig,
  query: string,
  options?: RepairContextModeOptions
): Promise<{ context_mode: 'law' | 'memory' | 'mixed' } | { reason: typeof CONTEXT_MODE_REPAIR_REASON }> {
  const truncated = query.slice(0, 1500);
  const entitySummary =
    options?.pre_entities?.length &&
    options.pre_entities.some((e) => e.type === 'article_ref' || e.type === 'act_abbrev' || e.type === 'law_title')
      ? `\nPre-extracted legal entities: ${options.pre_entities
          .filter((e) => e.type === 'article_ref' || e.type === 'act_abbrev' || e.type === 'law_title')
          .map((e) => `${e.type}=${e.value}`)
          .join(', ')}.`
      : '';
  const citationNote = options?.has_direct_citation === true ? '\nQuery contains direct legal citation(s).' : '';
  const messages = [
    {
      role: 'user' as const,
      content: `Given the user query below, respond with ONLY a JSON object with one key: "context_mode". Allowed values: "law", "memory", "mixed". Use "law" for questions about legal norms/codes; "memory" for personal/conversation recall; "mixed" for both.${entitySummary}${citationNote}\n\nUser query: ${truncated}`,
    },
  ];
  try {
    const res = await openRouterChat(
      config.apiKey,
      {
        model: config.modelId,
        messages,
        temperature: 0.0,
        max_completion_tokens: 64,
        caller: 'u2-context-mode-repair',
        response_format: { type: 'json_object' },
      },
      Math.min(config.timeoutSec, 15)
    );
    const raw = res.content?.trim() ?? '';
    const first = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed: { context_mode?: string };
    try {
      parsed = JSON.parse(first) as { context_mode?: string };
    } catch {
      return { reason: CONTEXT_MODE_REPAIR_REASON };
    }
    const mode = parsed?.context_mode;
    if (mode === 'law' || mode === 'memory' || mode === 'mixed') {
      return { context_mode: mode };
    }
    return { reason: CONTEXT_MODE_REPAIR_REASON };
  } catch (e) {
    logger.warn('U2 context_mode repair failed', {
      module: 'classify/llm-classifier',
      error: e instanceof Error ? e.message : String(e),
    });
    return { reason: CONTEXT_MODE_REPAIR_REASON };
  }
}

