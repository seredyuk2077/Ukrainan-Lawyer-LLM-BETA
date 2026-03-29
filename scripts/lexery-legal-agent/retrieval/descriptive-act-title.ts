import { extractQueryCitationSelectors } from './structural-citation.js';

const INTERROGATIVE_ACT_REFERENCE_CUE_PATTERN =
  '(?:акт\\p{L}*|закон\\p{L}*|кодекс\\p{L}*|постанов\\p{L}*|наказ\\p{L}*|розпоряджен\\p{L}*|указ\\p{L}*|рішен\\p{L}*)';
const INTERROGATIVE_ACT_REFERENCE_MODIFIER_PATTERN =
  '(?:(?:(?:спеціальн|профільн|урядов|підзаконн|нормативн|нормативно-правов|відомч|галузев|банківськ|регуляторн)\\p{L}*\\s+){0,2})';

const INTERROGATIVE_ACT_REFERENCE_REGEX = new RegExp(
  `(?:^|[?!.]\\s*)((?:я(?:ким|кою|ке|кий|ка|кі|кого|кої|кому|кими|ких))(?:\\s+саме)?\\s+${INTERROGATIVE_ACT_REFERENCE_MODIFIER_PATTERN}${INTERROGATIVE_ACT_REFERENCE_CUE_PATTERN}\\s+[^?]{4,220})(?=$|[?!.])`,
  'giu'
);

const INTERROGATIVE_ACT_REFERENCE_TEST_REGEX = new RegExp(
  `(?:^|[?!.]\\s*)((?:я(?:ким|кою|ке|кий|ка|кі|кого|кої|кому|кими|ких))(?:\\s+саме)?\\s+${INTERROGATIVE_ACT_REFERENCE_MODIFIER_PATTERN}${INTERROGATIVE_ACT_REFERENCE_CUE_PATTERN}\\s+[^?]{4,220})(?=$|[?!.])`,
  'iu'
);

const ACT_METADATA_TAIL_REGEX =
  /\s+(?:і|та)\s+(?:(?:хто|ким|коли)(?=$|[\s,])|з\s+якого\s+моменту|з\s+якої\s+дати|яким\s+органом).+$/iu;
const INTERROGATIVE_QUESTION_PREFIX_REGEX =
  /^(?:я(?:ким|кою|ке|кий|ка|кі|кого|кої|кому|кими|ких))(?:\s+саме)?\s+/iu;
const INTERROGATIVE_ACT_LOCATOR_PREFIX_REGEX =
  new RegExp(
    `^(?:я(?:ким|кою|ке|кий|ка|кі|кого|кої|кому|кими|ких))(?:\\s+саме)?\\s+${INTERROGATIVE_ACT_REFERENCE_MODIFIER_PATTERN}${INTERROGATIVE_ACT_REFERENCE_CUE_PATTERN}\\s+`,
    'iu'
  );
const TITLE_LIKE_DOCUMENT_PATTERN =
  /^(?:закон|кодекс|постанова|наказ|розпорядження|указ|рішення)(?:\s+[\p{L}."«»()-]{2,24}){0,2}\s+про\s+/iu;
const TITLE_LIKE_RULES_PATTERN = /^(?:правила|порядок|інструкція|положення)\s+/iu;

export function hasInterrogativeActLocatorCue(query: string): boolean {
  return INTERROGATIVE_ACT_REFERENCE_TEST_REGEX.test(query.normalize('NFC'));
}

export function stripActMetadataFollowUpTail(signal: string): string {
  return signal
    .replace(ACT_METADATA_TAIL_REGEX, '')
    .trim()
    .replace(/[,:;]+$/u, '')
    .trim();
}

export function stripInterrogativeActLocatorPrefix(signal: string): string {
  return signal.replace(INTERROGATIVE_ACT_LOCATOR_PREFIX_REGEX, '').trim();
}

export function stripInterrogativeQuestionPrefix(signal: string): string {
  return signal.replace(INTERROGATIVE_QUESTION_PREFIX_REGEX, '').trim();
}

export function extractInterrogativeActLocatorSignals(query: string): string[] {
  const out = new Set<string>();
  for (const match of query.normalize('NFC').matchAll(INTERROGATIVE_ACT_REFERENCE_REGEX)) {
    const rawSignal = match[1]?.trim();
    if (!rawSignal) continue;
    out.add(rawSignal);
    const trimmedSignal = stripActMetadataFollowUpTail(rawSignal);
    if (trimmedSignal && trimmedSignal !== rawSignal) out.add(trimmedSignal);
    const cuePrefixedSignal = stripInterrogativeQuestionPrefix(trimmedSignal || rawSignal);
    if (cuePrefixedSignal.length >= 8) out.add(cuePrefixedSignal);
    const descriptiveFragment = stripInterrogativeActLocatorPrefix(trimmedSignal || rawSignal);
    if (descriptiveFragment.length >= 8) out.add(descriptiveFragment);
  }
  return [...out];
}

export function looksLikeCompactActTitleFragmentQuery(
  query: string,
  options?: { includeRulesLikeTitles?: boolean }
): boolean {
  const normalized = query.normalize('NFC').trim();
  if (!normalized) return false;
  if (/[?]/u.test(normalized)) return false;
  const selectors = extractQueryCitationSelectors(normalized);
  if (selectors.explicitSelectorCount > 0 || selectors.noteMentioned) return false;
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const specialLongTitlePrefix = /^деякі\s+питання\s+/iu.test(normalized);
  const titleLike =
    /^про\s+/iu.test(normalized) ||
    TITLE_LIKE_DOCUMENT_PATTERN.test(normalized) ||
    (options?.includeRulesLikeTitles === true && TITLE_LIKE_RULES_PATTERN.test(normalized)) ||
    specialLongTitlePrefix;
  if (!titleLike) return false;
  const maxTokens = specialLongTitlePrefix ? 28 : 18;
  return tokens.length >= 4 && tokens.length <= maxTokens;
}
