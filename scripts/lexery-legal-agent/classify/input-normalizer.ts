/**
 * [U2-preprocessor] InputNormalizer — long/noise handling before U2a/b/c/d.
 * Does not replace U2a/b/c/d; runs before them. Builds effective_query for LLM when input is very long.
 * Heuristics for contract/table/legal_text feed routing_flags and smart gating (complex input → use LLM).
 */
import type { ExtractedEntity, RoutingFlags } from './types.js';

const DEFAULT_MAX_QUERY_LENGTH = 12 * 1024;
const HEAD_CHARS = 4096;
const TAIL_CHARS = 2048;
const NOISE_MIN_LENGTH = 20;
const NOISE_GIBBERISH_RATIO = 0.6;

/** Threshold (chars) above which we consider input "large" for gating */
export const LARGE_INPUT_CHARS = 8 * 1024;

export interface NormalizerResult {
  effectiveQuery: string;
  originalLength: number;
  effectiveLength: number;
  inputTruncated: boolean;
  routingOverrides: RoutingFlags;
  isNoise: boolean;
  /** Heuristics: set routing_flags and used for gating (complex input → LLM) */
  looksLikeContract: boolean;
  looksLikeTable: boolean;
  looksLikeLegalText: boolean;
  /** True if any reason to prefer LLM (large, contract-like, table-like, legal excerpt, noise needing clarification) */
  isComplexInput: boolean;
}

function isLikelyNoise(query: string): boolean {
  const q = query.trim();
  if (q.length < NOISE_MIN_LENGTH) return false;
  const letters = (q.match(/[\p{L}]/gu) || []).length;
  const ratio = letters / q.length;
  return ratio < NOISE_GIBBERISH_RATIO;
}

/** Contract-like: договір, сторона, пункт 1, стаття, предмет договору */
function looksLikeContract(query: string): boolean {
  const q = query.trim();
  if (q.length < 100) return false;
  const lower = q.toLowerCase();
  const hasContract = /(договір|договору|сторона|сторони|пункт\s+\d|предмет\s+договору|умови\s+договору)/i.test(lower);
  const hasStructure = /(стаття\s+\d|розділ\s+\d|підпункт)/i.test(lower) && (lower.split(/\n/).length >= 3);
  return hasContract || (hasStructure && q.length > 500);
}

/** Table-like: many commas/tabs in lines, or markdown table (|...|) */
function looksLikeTable(query: string): boolean {
  const lines = query.trim().split(/\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  const withPipes = lines.filter((l) => /\|.+\.*\|/.test(l)).length;
  if (withPipes >= 2) return true;
  const withManyCommas = lines.filter((l) => (l.match(/,/g) || []).length >= 3).length;
  if (withManyCommas >= 2) return true;
  const withTabs = lines.filter((l) => /\t/.test(l)).length;
  return withTabs >= 2;
}

/** Legal text excerpt: стаття, пункт, закон, ККУ, ЦКУ, абзац */
function looksLikeLegalText(query: string): boolean {
  const q = query.trim();
  if (q.length < 200) return false;
  const lower = q.toLowerCase();
  const legalMarkers = (lower.match(/(стаття|пункт|абзац|частина|статті|закону|закон\s|кку|цку|кзпп|кас|пку)/gi) || []).length;
  const hasNumbered = /(стаття\s+\d|пункт\s+\d|частина\s+\d)/i.test(lower);
  return legalMarkers >= 2 || (hasNumbered && q.length > 500);
}

export function normalizeInput(
  query: string,
  preEntities: ExtractedEntity[],
  maxLength: number = DEFAULT_MAX_QUERY_LENGTH
): NormalizerResult {
  const originalLength = query.length;
  const isNoise = isLikelyNoise(query);
  const routingOverrides: RoutingFlags = {};
  if (isNoise) {
    routingOverrides.need_clarification = true;
  }

  const looksLikeContractFlag = looksLikeContract(query);
  const looksLikeTableFlag = looksLikeTable(query);
  const looksLikeLegalTextFlag = looksLikeLegalText(query);
  if (looksLikeContractFlag) routingOverrides.input_looks_like_contract = true;
  if (looksLikeTableFlag) routingOverrides.input_looks_like_table = true;
  if (looksLikeLegalTextFlag) routingOverrides.input_looks_like_legal_text = true;

  const isLarge = originalLength > LARGE_INPUT_CHARS;
  if (isLarge) routingOverrides.input_is_large = true;

  const isComplexInput =
    isLarge ||
    looksLikeContractFlag ||
    looksLikeTableFlag ||
    looksLikeLegalTextFlag ||
    (isNoise && !!routingOverrides.need_clarification);

  if (originalLength <= maxLength) {
    return {
      effectiveQuery: query,
      originalLength,
      effectiveLength: originalLength,
      inputTruncated: false,
      routingOverrides,
      isNoise,
      looksLikeContract: looksLikeContractFlag,
      looksLikeTable: looksLikeTableFlag,
      looksLikeLegalText: looksLikeLegalTextFlag,
      isComplexInput,
    };
  }

  routingOverrides.input_is_large = true;
  const head = query.slice(0, HEAD_CHARS);
  const tail = query.slice(-TAIL_CHARS);
  const entitySnippet =
    preEntities.length > 0
      ? '\n[Посилання: ' +
        preEntities
          .slice(0, 15)
          .map((e) => e.value)
          .join('; ') +
        ']'
      : '';
  const effectiveQuery = head + '\n...[скорочено]...\n' + tail + entitySnippet;
  const effectiveLength = effectiveQuery.length;

  return {
    effectiveQuery,
    originalLength,
    effectiveLength,
    inputTruncated: true,
    routingOverrides,
    isNoise: false,
    looksLikeContract: looksLikeContractFlag,
    looksLikeTable: looksLikeTableFlag,
    looksLikeLegalText: looksLikeLegalTextFlag,
    isComplexInput: true,
  };
}

export { DEFAULT_MAX_QUERY_LENGTH as U2_MAX_QUERY_LENGTH };
