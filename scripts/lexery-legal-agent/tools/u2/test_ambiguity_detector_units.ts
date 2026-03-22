import { detectAmbiguity } from '../../classify/ambiguity-detector.js';
import { extractEntities } from '../../classify/entity-extractor.js';
import type { ExtractedEntity } from '../../classify/types.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function testShortQueryRemainsHard(): void {
  const result = detectAmbiguity('Права?', 'general', []);
  assert(result.is_ambiguous === true, 'short underspecified query must stay ambiguous');
  assert(result.strength === 'hard', 'short underspecified query must stay hard');
  assert(result.reason_codes?.includes('TOO_SHORT_QUERY') === true, 'hard ambiguity must come from TOO_SHORT_QUERY');
  console.log('[OK] short query remains hard ambiguity');
}

function testTopicWordsDoNotCreateHardAmbiguity(): void {
  const result = detectAmbiguity('Які права поліцейського під час затримання?', 'general', []);
  assert(result.is_ambiguous === true, 'general legal-looking query without structural refs may still be soft ambiguous');
  assert(result.strength === 'soft', 'topic words must not create hard ambiguity');
  assert(result.reason_codes?.includes('AMBIG_TERM_MATCH') !== true, 'AMBIG_TERM_MATCH must not be emitted');
  console.log('[OK] topic words do not create hard ambiguity');
}

function testConcreteDomainQueryDoesNotBecomeHardJustBecauseItIsShort(): void {
  const result = detectAmbiguity('трудовий договір строковий', 'labor', []);
  assert(result.strength !== 'hard', 'short but concrete domain-specific query must not become hard ambiguous');
  assert(result.reason_codes?.includes('TOO_SHORT_QUERY') !== true, 'TOO_SHORT_QUERY must not be emitted for concrete domain query');
  console.log('[OK] concrete domain-specific short query does not become hard ambiguity');
}

function testVeryShortConcreteLegalDomainQueryDoesNotBecomeHard(): void {
  const result = detectAmbiguity('оренда землі', 'civil', []);
  assert(result.strength !== 'hard', 'very short but concrete legal-domain query must not become hard ambiguous');
  assert(result.reason_codes?.includes('TOO_SHORT_QUERY') !== true, 'TOO_SHORT_QUERY must not be emitted for short concrete legal-domain query');
  console.log('[OK] very short concrete legal-domain query does not become hard ambiguity');
}

function testLawTitleStructuralCueDoesNotTriggerGeneralDomainAmbiguity(): void {
  const entities: ExtractedEntity[] = [
    {
      type: 'law_title',
      value: 'Правил перетинання державного кордону',
    },
  ];
  const result = detectAmbiguity(
    'Які обмеження на виїзд за кордон під час воєнного стану за пунктом 21 Правил перетинання державного кордону?',
    'general',
    entities
  );
  assert(result.is_ambiguous === false, 'explicit law_title structural cue must clear soft general-domain ambiguity');
  assert(result.reason_codes?.includes('GENERAL_DOMAIN_NO_DIRECT_REF') !== true, 'law_title cue must suppress GENERAL_DOMAIN_NO_DIRECT_REF');
  console.log('[OK] law_title structural cue suppresses general-domain ambiguity');
}

function testShortExplicitActReferenceDoesNotBecomeHardAmbiguous(): void {
  const queries = ['ПКМ №100', 'постанова КМУ №1178', 'наказ МОЗ №385'];
  for (const query of queries) {
    const { entities } = extractEntities(query);
    const result = detectAmbiguity(query, 'general', entities);
    assert(result.strength !== 'hard', `${query} must not become hard ambiguity`);
    assert(result.reason_codes?.includes('TOO_SHORT_QUERY') !== true, `${query} must not emit TOO_SHORT_QUERY`);
  }
  console.log('[OK] short explicit act references stay out of hard ambiguity');
}

function main(): void {
  console.log('ambiguity detector unit tests\n');
  testShortQueryRemainsHard();
  testTopicWordsDoNotCreateHardAmbiguity();
  testConcreteDomainQueryDoesNotBecomeHardJustBecauseItIsShort();
  testVeryShortConcreteLegalDomainQueryDoesNotBecomeHard();
  testLawTitleStructuralCueDoesNotTriggerGeneralDomainAmbiguity();
  testShortExplicitActReferenceDoesNotBecomeHardAmbiguous();
  console.log('\nAll ambiguity detector unit tests passed.');
}

main();
