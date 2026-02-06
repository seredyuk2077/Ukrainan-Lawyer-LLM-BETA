/**
 * [U2a] IntentClassifier — rule-based baseline (LEX-83)
 * Order: drafting first (складіть заяву, позов), then procedure (оскаржити, рішення податкової).
 * Note: \b is ASCII-only in JS; use explicit substring patterns for Ukrainian.
 */
import type { Intent } from './types.js';

const DRAFTING_PATTERNS = [
  /(складіть|напишіть|підготуйте|оформте|скласти|написати|підготувати|оформити)/i,
  /(заяву|заява|позов|клопотання|скарга|апеляційну|касаційну)/i,
  /\b(draft|compose|prepare|write)\b/i,
];
const PROCEDURE_PATTERNS = [
  /(як\s+оскаржити|оскаржити\s+рішення|оскарження|відмова)/i,
  /(рішення\s+податкової|податкової\s+інспекції)/i,
  /(процедура|порядок\s+оскарження|як\s+подати|строки\s+звернення|апеляція|касація)/i,
  /\b(procedure|appeal|complaint|how to challenge)\b/i,
];
const RESEARCH_PATTERNS = [
  /(дослідження|аналіз|перевірка норм|пошук)/i,
  /\b(research|analysis|find|search)\b/i,
];

export function classifyIntent(query: string): Intent {
  const q = query.trim();
  if (!q) return 'question';

  for (const re of DRAFTING_PATTERNS) {
    if (re.test(q)) return 'drafting';
  }
  for (const re of PROCEDURE_PATTERNS) {
    if (re.test(q)) return 'procedure';
  }
  for (const re of RESEARCH_PATTERNS) {
    if (re.test(q)) return 'research';
  }

  return 'question';
}
