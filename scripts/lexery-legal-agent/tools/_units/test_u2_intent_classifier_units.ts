import { classifyIntent } from '../../classify/intent-classifier.js';

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function testDraftingRequiresDraftingVerb(): void {
  assertEqual(classifyIntent('складіть позовну заяву про скасування рішення'), 'drafting', 'explicit drafting ask');
  assertEqual(
    classifyIntent("куди потім нести позов, якщо почнуть карати"),
    'procedure',
    'soft procedural question with позов mention'
  );
  console.log('[OK] U2 intent: drafting requires a drafting ask');
}

function testProcedureCapturesCourtAndFilingLexicon(): void {
  assertEqual(
    classifyIntent("Який строк звернення до адмінсуду і чи обов'язково перед цим писати скаргу в орган?"),
    'procedure',
    'administrative court timing query'
  );
  assertEqual(
    classifyIntent('до якого суду подавати позов і як оскаржити відмову'),
    'procedure',
    'court filing / challenge query'
  );
  console.log('[OK] U2 intent: procedure captures court/filling lexicon');
}

function main(): void {
  testDraftingRequiresDraftingVerb();
  testProcedureCapturesCourtAndFilingLexicon();
  console.log('All U2 intent classifier unit tests passed.');
}

main();
