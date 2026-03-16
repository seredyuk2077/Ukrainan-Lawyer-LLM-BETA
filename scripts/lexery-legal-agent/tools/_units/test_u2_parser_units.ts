/**
 * U2 parser unit tests: extractFirstJsonObject behaviour via parseLLMClassifyOutput / tryParseLLMOutput.
 * Preamble + JSON, braces inside string literals, invalid JSON => null.
 * Run: tsx scripts/lexery-legal-agent/tools/_units/test_u2_parser_units.ts
 */
import { parseLLMClassifyOutput, tryParseLLMOutput } from '../../classify/schema.js';

const MINIMAL_VALID = {
  intent: 'question',
  domain: 'general',
  entities: [] as unknown[],
  ambiguity: { is_ambiguous: false, reasons: [] as string[] },
};

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function testPreambleAndJson(): void {
  const raw = `Here is the classification result:\n${JSON.stringify(MINIMAL_VALID)}`;
  const out = parseLLMClassifyOutput(raw);
  assert(out.intent === 'question', 'preamble: intent');
  assert(out.domain === 'general', 'preamble: domain');
  console.log('[OK] preamble + JSON parsed');
}

function testBracesInString(): void {
  const payload = {
    ...MINIMAL_VALID,
    ambiguity: { is_ambiguous: false, reasons: ['need { and } in reason'] },
  };
  const raw = `Preamble\n${JSON.stringify(payload)}`;
  const out = parseLLMClassifyOutput(raw);
  assert(out.ambiguity.reasons[0] === 'need { and } in reason', 'braces in string preserved');
  console.log('[OK] braces in string literal');
}

function testInvalidJsonReturnsNull(): void {
  const out = tryParseLLMOutput('not json at all');
  assert(out === null, 'invalid text => null');
  const out2 = tryParseLLMOutput('{"intent": "question"}'); // missing required domain, entities, ambiguity
  assert(out2 === null, 'incomplete JSON => null (validation fails)');
  console.log('[OK] invalid json => null');
}

function main(): void {
  console.log('U2 parser unit tests\n');
  testPreambleAndJson();
  testBracesInString();
  testInvalidJsonReturnsNull();
  console.log('\nAll U2 parser unit tests passed.');
}

main();
