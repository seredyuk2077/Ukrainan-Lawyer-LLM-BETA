/**
 * U2 LLM Classifier — OpenRouter call, JSON parse, zod validation.
 * On invalid JSON: 1 retry, then throw (caller does degraded fallback).
 */
import { openRouterChat, OpenRouterError } from '../lib/openrouter.js';
import { parseLLMClassifyOutput, tryParseLLMOutput, type LLMClassifyOutput } from './schema.js';
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
  let retries = 0;

  const tryParse = async (model: string): Promise<LLMClassifyResult> => {
    let lastResult = await openRouterChat(
      config.apiKey,
      { model, messages, temperature: 0.1, max_tokens: 1024, caller: 'u2-classify' },
      config.timeoutSec
    );
    latencyMs = lastResult.latency_ms;
    modelId = lastResult.model_id;
    let parsed: LLMClassifyOutput | null = tryParseLLMOutput(lastResult.content);
    if (!parsed && retries === 0) {
      retries = 1;
      warnings.push('llm_invalid_json_retry');
      lastResult = await openRouterChat(
        config.apiKey,
        { model, messages, temperature: 0.1, max_tokens: 1024, caller: 'u2-classify' },
        config.timeoutSec
      );
      latencyMs = lastResult.latency_ms;
      modelId = lastResult.model_id;
      parsed = tryParseLLMOutput(lastResult.content);
    }
    if (!parsed) throw new Error('Invalid JSON from LLM after retry');
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
        retries,
        warnings,
      },
    };
  };

  try {
    const out = await tryParse(config.modelId);
    return out;
  } catch (err) {
    lastError = err as Error;
    if (config.fallbackModelId && config.modelId !== config.fallbackModelId) {
      retries = 1;
      warnings.push('llm_primary_fail_fallback');
      try {
        return await tryParse(config.fallbackModelId);
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

