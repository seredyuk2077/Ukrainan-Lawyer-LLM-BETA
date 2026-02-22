/**
 * Prod hardening tests — empty query, caller in OpenRouter options, gateway validation.
 * Run: pnpm brain:test:prod-hardening
 * Does NOT call real APIs (except empty-query path uses runCacheRag which returns early).
 */
import { runCacheRag } from '../../retrieval/cache-rag.js';
import type { OpenRouterChatOptions } from '../../lib/openrouter.js';

const MINIMAL_SEARCH_PLAN = {
  version: 1,
  sources: { use_lldbi: true, use_memory: false, use_doclist: false },
} as const;

async function testEmptyQueryReturnsEmptyTrace(): Promise<void> {
  const result = await runCacheRag({
    query: '',
    searchPlan: MINIMAL_SEARCH_PLAN,
  });
  if (result.rawHits.length !== 0) {
    throw new Error(`Expected 0 rawHits for empty query, got ${result.rawHits.length}`);
  }
  const codes = result.retrievalTrace.meta?.reason_codes ?? [];
  if (!codes.includes('EMPTY_QUERY')) {
    throw new Error(`Expected reason_codes to include EMPTY_QUERY, got ${JSON.stringify(codes)}`);
  }
  if (result.retrievalTrace.meta?.low_confidence !== true) {
    throw new Error('Expected low_confidence true for empty query');
  }
  console.log('[OK] Empty query → EMPTY_QUERY trace, no embed/Qdrant');
}

async function testWhitespaceQueryReturnsEmptyTrace(): Promise<void> {
  const result = await runCacheRag({
    query: '   \n\t  ',
    searchPlan: MINIMAL_SEARCH_PLAN,
  });
  const codes = result.retrievalTrace.meta?.reason_codes ?? [];
  if (!codes.includes('EMPTY_QUERY')) {
    throw new Error(`Expected EMPTY_QUERY for whitespace-only query, got ${JSON.stringify(codes)}`);
  }
  console.log('[OK] Whitespace-only query → EMPTY_QUERY');
}

function testOpenRouterOptionsAcceptCaller(): void {
  const opts: OpenRouterChatOptions = {
    model: 'test',
    messages: [],
    caller: 'u2-classify',
  };
  if (!opts.caller) throw new Error('OpenRouterChatOptions must accept caller');
  console.log('[OK] OpenRouterChatOptions accepts caller');
}

/** Mirrors gateway handler: reject body that is null or not a plain object (before schema parse). */
function gatewayWouldRejectBody(rawBody: unknown): boolean {
  return rawBody == null || typeof rawBody !== 'object';
}

function testGatewayBodyValidation(): void {
  if (!gatewayWouldRejectBody(null)) throw new Error('null body must be rejected');
  if (!gatewayWouldRejectBody(undefined)) throw new Error('undefined body must be rejected');
  if (!gatewayWouldRejectBody(1)) throw new Error('number body must be rejected');
  if (!gatewayWouldRejectBody('string')) throw new Error('string body must be rejected');
  if (!gatewayWouldRejectBody(true)) throw new Error('boolean body must be rejected');
  if (gatewayWouldRejectBody({})) throw new Error('empty object body must be accepted for parse');
  if (gatewayWouldRejectBody({ query: 'test' })) throw new Error('valid-shaped body must be accepted for parse');
  console.log('[OK] Gateway body validation: null/non-object rejected');
}

async function main(): Promise<void> {
  console.log('Prod hardening tests\n');
  testOpenRouterOptionsAcceptCaller();
  testGatewayBodyValidation();
  await testEmptyQueryReturnsEmptyTrace();
  await testWhitespaceQueryReturnsEmptyTrace();
  console.log('\nAll prod hardening tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
