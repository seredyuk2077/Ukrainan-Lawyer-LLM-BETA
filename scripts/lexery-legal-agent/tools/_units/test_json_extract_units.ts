/**
 * Unit tests for bracket-balanced JSON extraction (no apostrophe as delimiter).
 * Run: pnpm -s exec tsx scripts/lexery-legal-agent/tools/_units/test_json_extract_units.ts
 */
import { extractFirstJsonObject, extractFirstJsonArray } from '../../lib/jsonExtract.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

/** Ukrainian apostrophe in preamble must not break extraction (only " is string delimiter). */
function testApostropheInPreamble(): void {
  const text = "Питання про п'яти роках. {\"indices\": [0, 1, 2]}";
  const obj = extractFirstJsonObject(text);
  assert(obj !== '', 'extract object after apostrophe preamble');
  const parsed = JSON.parse(obj) as { indices?: number[] };
  assert(Array.isArray(parsed.indices) && parsed.indices.length === 3, 'indices [0,1,2]');
  console.log('[OK] jsonExtract: preamble with Ukrainian apostrophe (п\'яти) + JSON object');
}

/** JSON array/object with nested brackets and quoted braces. */
function testNestedBracketsAndQuotedBraces(): void {
  const withNested = 'Prefix [ [1, 2], {"x": "value with } brace"} ] suffix';
  const arr = extractFirstJsonArray(withNested);
  assert(arr !== '', 'extract array with nested structures');
  const parsed = JSON.parse(arr) as unknown[];
  assert(Array.isArray(parsed) && parsed.length === 2, 'two elements');
  assert(JSON.stringify(parsed[0]) === '[1,2]', 'first element [1,2]');
  assert(
    typeof parsed[1] === 'object' && parsed[1] !== null && (parsed[1] as { x?: string }).x === 'value with } brace',
    'object with quoted brace in string'
  );
  console.log('[OK] jsonExtract: nested brackets and quoted braces');
}

/** Incomplete JSON (unclosed bracket) returns slice from start or parse-fail path, no false-positive. */
function testIncompleteJson(): void {
  const incomplete = '{"indices": [0, 1, 2';
  const obj = extractFirstJsonObject(incomplete);
  assert(obj !== '' && obj.startsWith('{'), 'returns partial from start');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(obj);
  } catch {
    // expected
  }
  assert(parsed === null || typeof parsed !== 'object', 'incomplete does not parse as valid JSON');
  const incompleteArr = ' [ 1, 2, ';
  const arr = extractFirstJsonArray(incompleteArr);
  assert(arr === '' || arr.startsWith('['), 'array: empty or partial');
  console.log('[OK] jsonExtract: incomplete JSON returns partial or empty, no false-positive');
}

/** Double-quoted string with escaped quote. */
function testEscapedQuote(): void {
  const text = '{"key": "value with \\" quote"}';
  const obj = extractFirstJsonObject(text);
  assert(obj !== '', 'extract with escaped quote');
  const parsed = JSON.parse(obj) as { key?: string };
  assert(parsed.key === 'value with " quote', 'escaped quote preserved');
  console.log('[OK] jsonExtract: escaped double-quote in string');
}

function main(): void {
  testApostropheInPreamble();
  testNestedBracketsAndQuotedBraces();
  testIncompleteJson();
  testEscapedQuote();
  console.log('All jsonExtract unit tests passed.');
}

main();
