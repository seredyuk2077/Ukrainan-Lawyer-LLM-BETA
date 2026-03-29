/**
 * [U2a] IntentClassifier — rule-based baseline (LEX-83)
 * Drafting requires an actual drafting ask, not a mere mention of a claim/complaint.
 * This keeps soft procedural questions like "куди нести позов" out of the drafting path.
 * Note: \b is ASCII-only in JS; use explicit substring patterns for Ukrainian.
 */
import type { Intent } from './types.js';

const DRAFTING_VERB_PATTERNS = [
  /(складіть|напишіть|підготуйте|оформте|скласти|написати|підготувати|оформити)/i,
  /\b(draft|compose|prepare|write)\b/i,
];
const DRAFTING_DOCUMENT_PATTERNS = [
  /(заяв[ауы]|позов(?:ну)?\s+заяв[ауы]?|позов|клопотанн[яа]|скарг[ауы]|апеляційн\p{L}*|касаційн\p{L}*|відзив|запереченн\p{L}*)/iu,
  /\b(statement|claim|complaint|motion|appeal|petition|response)\b/i,
];
const PROCEDURE_PATTERNS = [
  /(як\s+оскаржити|оскаржити\s+рішення|оскарження|відмова)/i,
  /(рішення\s+податкової|податкової\s+інспекції)/i,
  /(процедура|порядок\s+оскарження|як\s+подати|строк(?:и)?\s+звернення|апеляція|касація|адмінсуд|до\s+якого\s+суду)/i,
  /(куди(?:\s+\p{L}+){0,3}\s+(?:нести|подавати)\s+(?:позов|скарг[ауы]|заяв[ауы]))/iu,
  /\b(procedure|appeal|complaint|how to challenge)\b/i,
];
const RESEARCH_PATTERNS = [
  /(дослідження|аналіз|перевірка норм|пошук)/i,
  /\b(research|analysis|find|search)\b/i,
];

function isDraftingIntent(query: string): boolean {
  const hasDraftingVerb = DRAFTING_VERB_PATTERNS.some((re) => re.test(query));
  if (!hasDraftingVerb) return false;
  return DRAFTING_DOCUMENT_PATTERNS.some((re) => re.test(query));
}

export function classifyIntent(query: string): Intent {
  const q = query.trim();
  if (!q) return 'question';

  if (isDraftingIntent(q)) return 'drafting';
  for (const re of PROCEDURE_PATTERNS) {
    if (re.test(q)) return 'procedure';
  }
  for (const re of RESEARCH_PATTERNS) {
    if (re.test(q)) return 'research';
  }

  return 'question';
}
