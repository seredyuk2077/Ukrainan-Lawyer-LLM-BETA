/**
 * Unit tests for OpenRouter response extraction (content string / array / reasoning fallback).
 * Run: tsx scripts/lexery-legal-agent/tools/_units/test_openrouter_units.ts
 */
import { extractAssistantText, getEmptyContentErrorCode, OpenRouterError } from '../../lib/openrouter.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function testStringContent(): void {
  const { text, raw_content_type, had_reasoning_only } = extractAssistantText(' [0, 5, 12] ');
  assert(text === '[0, 5, 12]', `string content preserved (got ${JSON.stringify(text)})`);
  assert(raw_content_type === 'string', `raw_content_type=string (got ${raw_content_type})`);
  assert(!had_reasoning_only, 'had_reasoning_only=false');
  console.log('[OK] extractAssistantText: string content');
}

function testArrayTextPart(): void {
  const raw = [{ type: 'text', text: '[1, 2, 3]' }];
  const { text, raw_content_type, had_reasoning_only } = extractAssistantText(raw);
  assert(text === '[1, 2, 3]', `array text part extracted (got ${JSON.stringify(text)})`);
  assert(raw_content_type === 'array', `raw_content_type=array (got ${raw_content_type})`);
  assert(!had_reasoning_only, 'had_reasoning_only=false');
  console.log('[OK] extractAssistantText: array with type=text');
}

function testArrayReasoningThenText(): void {
  const raw = [
    { type: 'reasoning', text: 'Thinking...' },
    { type: 'text', text: '[0, 7]' },
  ];
  const { text, had_reasoning_only } = extractAssistantText(raw);
  assert(text === '[0, 7]', `text part preferred over reasoning (got ${JSON.stringify(text)})`);
  assert(!had_reasoning_only, 'had_reasoning_only=false when text part present');
  console.log('[OK] extractAssistantText: reasoning + text, text used');
}

function testArrayReasoningOnly(): void {
  const raw = [{ type: 'reasoning', text: '[5, 10, 15]' }];
  const { text, had_reasoning_only } = extractAssistantText(raw);
  assert(text === '[5, 10, 15]', `reasoning fallback when no text part (got ${JSON.stringify(text)})`);
  assert(had_reasoning_only, 'had_reasoning_only=true');
  console.log('[OK] extractAssistantText: reasoning-only fallback');
}

function testNullReturnsEmpty(): void {
  const { text, raw_content_type } = extractAssistantText(null);
  assert(text === '', `null => empty string (got ${JSON.stringify(text)})`);
  assert(raw_content_type === 'null', `raw_content_type=null (got ${raw_content_type})`);
  console.log('[OK] extractAssistantText: null => empty');
}

/** content=null + reasoning_details + finish_reason=length => EMPTY_OUTPUT_LENGTH (triage production case). */
function testEmptyContentErrorCodes(): void {
  assert(
    getEmptyContentErrorCode('length') === 'EMPTY_OUTPUT_LENGTH',
    'finish_reason=length => EMPTY_OUTPUT_LENGTH'
  );
  assert(
    getEmptyContentErrorCode(undefined) === 'EMPTY_ASSISTANT_CONTENT',
    'no finish_reason => EMPTY_ASSISTANT_CONTENT'
  );
  assert(
    getEmptyContentErrorCode('stop') === 'EMPTY_ASSISTANT_CONTENT',
    'finish_reason=stop => EMPTY_ASSISTANT_CONTENT'
  );
  console.log('[OK] getEmptyContentErrorCode: length => EMPTY_OUTPUT_LENGTH, else EMPTY_ASSISTANT_CONTENT');
}

function testOpenRouterErrorCode(): void {
  const err = new OpenRouterError('test', 'EMPTY_OUTPUT_LENGTH');
  assert(err.code === 'EMPTY_OUTPUT_LENGTH', `error code (got ${err.code})`);
  assert(err.name === 'OpenRouterError', `error name (got ${err.name})`);
  console.log('[OK] OpenRouterError: EMPTY_OUTPUT_LENGTH code');
}

function main(): void {
  console.log('OpenRouter extractAssistantText unit tests\n');
  testStringContent();
  testArrayTextPart();
  testArrayReasoningThenText();
  testArrayReasoningOnly();
  testNullReturnsEmpty();
  testEmptyContentErrorCodes();
  testOpenRouterErrorCode();
  console.log('\nAll OpenRouter unit tests passed.');
}

main();
