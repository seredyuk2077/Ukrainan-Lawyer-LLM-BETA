/**
 * Unit tests for U2 LLDBI derived document-type hints.
 * Run: pnpm -s exec tsx scripts/lexery-legal-agent/tools/_units/test_u2_lldbi_hints_units.ts
 */
import { deriveLldbiHintsFromVocabulary } from '../../classify/lldbi-hints-from-vocabulary.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

const vocabulary = {
  documentTypes: ['Рішення КСУ', 'Рішення РНБО', 'Постанова КМУ'],
  categories: [],
  fetchedAt: new Date().toISOString(),
  source: 'unit',
} as const;

function testGenericDecisionSurfaceDoesNotInferSpecificDecisionBodies(): void {
  const result = deriveLldbiHintsFromVocabulary({
    queryText:
      'Яким рішенням Кабміну у березні 2026 року скоригували правила державної підтримки молодіжних і дитячих громадських об’єднань?',
    heuristicConfidence: 0.7,
    vocabulary,
  });
  assert(
    result.document_types_ranked_top3.length === 0,
    `expected no concrete doc-type hints for generic decision surface, got ${JSON.stringify(result.document_types_ranked_top3)}`
  );
  console.log('[OK] U2 lldbi hints: generic decision wording does not infer specific KSU/RNBO doc types');
}

function testExactConcreteDecisionPhraseStillMatches(): void {
  const result = deriveLldbiHintsFromVocabulary({
    queryText: 'Чи може рішення КСУ звужувати вже надані соціальні гарантії?',
    heuristicConfidence: 0.7,
    vocabulary,
  });
  assert(
    result.document_types_ranked_top3.includes('Рішення КСУ'),
    `expected exact concrete phrase to keep KSU doc type, got ${JSON.stringify(result.document_types_ranked_top3)}`
  );
  console.log('[OK] U2 lldbi hints: exact concrete KSU decision phrase still matches');
}

function testExactConcreteGovernmentPhraseStillMatches(): void {
  const result = deriveLldbiHintsFromVocabulary({
    queryText: 'Що змінила постанова КМУ про державну підтримку молодіжних об’єднань?',
    heuristicConfidence: 0.7,
    vocabulary,
  });
  assert(
    result.document_types_ranked_top3.includes('Постанова КМУ'),
    `expected exact CMU resolution phrase to match, got ${JSON.stringify(result.document_types_ranked_top3)}`
  );
  console.log('[OK] U2 lldbi hints: exact CMU resolution phrase still matches');
}

function main(): void {
  testGenericDecisionSurfaceDoesNotInferSpecificDecisionBodies();
  testExactConcreteDecisionPhraseStillMatches();
  testExactConcreteGovernmentPhraseStillMatches();
  console.log('All U2 LLDBI hints unit tests passed.');
}

main();
