/**
 * U4 Heuristic goal splitter — no LLM by default.
 * Detects: multi_question, multi_topic, contract/table-like from routing_flags.
 * V2: taxonomy-induced category-cluster split (substance vs procedure) when taxonomy data provided.
 */
import type { EvidenceGoal, EvidenceGoalType, GoalSplitResult } from './goals.js';
import type { RoutingFlags } from '../classify/types.js';
import { config } from '../lib/config.js';
import { extractQueryCitationSelectors } from './structural-citation.js';
import { extractQuotedActTitleFragments, extractStructuredActIdentifiers } from './act-taxonomy-store.js';
import {
  hasInterrogativeActLocatorCue,
  looksLikeCompactActTitleFragmentQuery,
} from './descriptive-act-title.js';
export { hasInterrogativeActLocatorCue, looksLikeCompactActTitleFragmentQuery } from './descriptive-act-title.js';

const GOALS_MAX = config.u4GoalsMax;

export function normalizeCategoryKey(category: string | null | undefined): string {
  return (category ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();
}

/** Categories that denote "substance" (material law) from taxonomy schema. */
export const SUBSTANCE_CATEGORIES = new Set([
  'tax_customs',
  'labor_social',
  'labor',
  'civil',
  'criminal',
  'admin',
  'administrative',
  'administrative_offenses',
  'finance_banking',
  'corporate',
]);
/** Categories that denote procedure/judiciary from taxonomy schema. */
export const PROCEDURE_CATEGORIES = new Set([
  'judiciary_justice',
  'criminal_procedure',
  'civil_procedure',
  'civil_procedure_administrative',
]);

export function isProcedureCategory(category: string | null | undefined): boolean {
  return PROCEDURE_CATEGORIES.has(normalizeCategoryKey(category));
}

export function getProcedureCategoryEnvelope(categoryHints: Array<string | null | undefined>): string[] {
  const normalized = [
    ...new Set(categoryHints.map((hint) => normalizeCategoryKey(hint)).filter(Boolean)),
  ];
  const existingProcedureHints = normalized.filter((hint) => PROCEDURE_CATEGORIES.has(hint));
  if (existingProcedureHints.length > 0) return existingProcedureHints;
  return [...PROCEDURE_CATEGORIES];
}

/** Min support (unique acts per category in taxonomy) to consider for cluster split. */
const CATEGORY_SPLIT_MIN_SUPPORT = 2;
/** Min ratio of second to first category support to trigger split (avoid tiny second cluster). */
const CATEGORY_SPLIT_MIN_RATIO = 0.3;

/** Taxonomy input for category-cluster split (from getTaxonomyCandidates). */
export type TaxonomyInputForSplit = {
  rada_nreg_candidates?: string[];
  alias_hits: Array<{ rada_nreg: string; category?: string | null }>;
  category_hints: string[];
  exact_act_hit_count?: number;
  grounded_act_hit_count?: number;
};

/** Structure-only: multiple "?" or conjunction "і"/"та" before second question. No topic/domain inference. */
function detectMultiQuestion(query: string): boolean {
  const q = query.normalize('NFC').trim();
  const questionMarks = (q.match(/\?/g) || []).length;
  if (questionMarks >= 2) return true;
  if (/\s+і\s+[^?]*\?\s*$/i.test(q) && questionMarks >= 1) return true;
  return false;
}

/**
 * No topic/domain regexes. Domain comes from U2 (domainHint) only. Multi-goal semantics from planner/taxonomy.
 */
function getDomainsFromHint(domainHint?: string): { multi: boolean; domains: string[] } {
  const domains = domainHint ? [domainHint] : [];
  return { multi: false, domains };
}

const PROCEDURE_GOAL_PATTERNS = [
  /поряд(?:ок|ку)/iu,
  /процедур/iu,
  /реєстрац/iu,
  /зареєстр/iu,
  /строк(?:у|и|ів)?/iu,
  /термін(?:у|и|ів)?/iu,
  /оскарж/iu,
  /оскаржу/iu,
  /апеляц/iu,
  /касац/iu,
  /підслід/iu,
  /підсуд/iu,
  /розсліду/iu,
  /розгляд(?:ає|у|ом)?/iu,
  /(?:^|[\s,])пода(?:ти|ння|вати|ється|ються|є|ють|ючи)(?=$|[^\p{L}\p{N}])/iu,
  /документ\p{L}*\s+пода(?:ти|ння|вати|ється|ються|є|ють|ючи)(?=$|[^\p{L}\p{N}])/iu,
  /внес\p{L}*\s+відомост/iu,
  /єрдр/iu,
  /куди/iu,
  /до\s+якого\s+суд/iu,
  /хто/iu,
  /коли/iu,
];

const LIABILITY_GOAL_PATTERNS = [
  /відповідальн/iu,
  /покаран/iu,
  /санкц/iu,
  /штраф/iu,
];

const ACT_METADATA_FOLLOW_UP_PATTERNS = [
  /(?:^|[\s,])хто\s+(?:(?:це|цей|ця|ці|його|її|їх|воно|вона|вони)\s+)?(?:прийняв|ухвалив|затвердив|видав|підписав)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])ким\s+(?:(?:це|цей|ця|ці|його|її|їх|воно|вона|вони)\s+)?(?:прийнято|прийняте|ухвалено|затверджено|видано|підписано)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])яким\s+органом(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])з\s+якого\s+моменту(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])з\s+якої\s+дати(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])коли\s+(?:(?:це|цей|ця|ці|його|її|їх|воно|вона|вони)\s+)?(?:прийнято|ухвалено|затверджено|видано|підписано|набрало\s+чинності|втратило\s+чинність|припинилося)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])хто\s+прийняв\s+це\s+рішення(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])коли\s+це\s+(?:рішення|розпорядження|постанова|наказ|указ)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])ї(?:ї|х)\s+застосуван/iu,
];

const STRONG_SELECTOR_PROCEDURAL_SPLIT_PATTERNS = [
  /підслід/iu,
  /підсуд/iu,
  /розсліду/iu,
  /оскарж/iu,
  /апеляц/iu,
  /касац/iu,
  /скарг/iu,
  /єрдр/iu,
  /внес\p{L}*\s+відомост/iu,
  /документ\p{L}*\s+пода(?:ти|ння|вати|ється|ються|є|ють|ючи)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[\s,])куди\s+пода(?:ти|вати|ється|ються|є|ють|ючи)(?=$|[^\p{L}\p{N}])/iu,
];

function normalizeSubqueryForSemantics(subquery: string): string {
  return subquery
    .normalize('NFC')
    .replace(/\?+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasStrongSelectorProceduralSplitCue(query: string): boolean {
  const normalized = query.normalize('NFC');
  return STRONG_SELECTOR_PROCEDURAL_SPLIT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function splitDistinctBundleClauses(query: string): [string, string] | null {
  const normalized = query.normalize('NFC').trim();
  if (!normalized) return null;

  const questionParts = normalized.split(/\s*\?\s*/u).map((part) => part.trim()).filter(Boolean);
  if (questionParts.length >= 2) {
    return [questionParts[0] ?? '', questionParts.slice(1).join(' ').trim()];
  }

  const andMatch =
    normalized.match(/^(.+?)\s+і\s+(.+)$/iu) || normalized.match(/^(.+?)\s+та\s+(.+)$/iu);
  if (andMatch) {
    return [andMatch[1]?.trim() ?? '', andMatch[2]?.trim() ?? ''];
  }

  const commaAMatch = normalized.match(/^(.+?),\s*а\s+(.+)$/iu);
  if (commaAMatch) {
    return [commaAMatch[1]?.trim() ?? '', commaAMatch[2]?.trim() ?? ''];
  }

  const semicolonMatch = normalized.match(/^(.+?);\s*(.+)$/u);
  if (semicolonMatch) {
    return [semicolonMatch[1]?.trim() ?? '', semicolonMatch[2]?.trim() ?? ''];
  }

  return null;
}

function clausesSupportStrongProceduralMixedBundle(left: string, right: string): boolean {
  const leftGoalType = inferGoalType(left, false);
  const rightGoalType = inferGoalType(right, false);
  const hasProcedure = leftGoalType === 'procedure' || rightGoalType === 'procedure';
  const hasNonProcedure = leftGoalType !== 'procedure' || rightGoalType !== 'procedure';
  if (!hasProcedure || !hasNonProcedure) return false;
  if (leftGoalType === 'procedure' && hasStrongSelectorProceduralSplitCue(left)) return true;
  if (rightGoalType === 'procedure' && hasStrongSelectorProceduralSplitCue(right)) return true;
  return false;
}

export function hasDistinctProceduralSupportBundleCue(query: string): boolean {
  const clauses = splitDistinctBundleClauses(query);
  if (!clauses) return false;
  const [left, right] = clauses;
  if (!left || !right) return false;
  return clausesSupportStrongProceduralMixedBundle(left, right);
}

function hasDominantSoftSingleActConvergence(taxonomy: TaxonomyInputForSplit): boolean {
  const topCandidate = taxonomy.rada_nreg_candidates?.[0]?.trim();
  if (!topCandidate) return false;

  const supportByNreg = new Map<string, number>();
  for (const hit of taxonomy.alias_hits ?? []) {
    const radaNreg = hit.rada_nreg?.trim();
    if (!radaNreg) continue;
    supportByNreg.set(radaNreg, (supportByNreg.get(radaNreg) ?? 0) + 1);
  }

  const topSupport = supportByNreg.get(topCandidate) ?? 0;
  if (topSupport < 2) return false;
  const secondSupport = [...supportByNreg.entries()]
    .filter(([radaNreg]) => radaNreg !== topCandidate)
    .map(([, support]) => support)
    .sort((left, right) => right - left)[0] ?? 0;
  return topSupport > secondSupport;
}

function uniqueSignals(signals: string[]): string[] {
  return [...new Set(signals.map((signal) => signal.trim()).filter(Boolean))];
}

function rankGoalSignal(signal: string): number {
  const normalized = signal.normalize('NFC').trim().toLowerCase();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const genericPenalty =
    ['оскарження', 'строк', 'порядок', 'подання', 'підслідність', 'підсудність'].includes(normalized)
      ? 6
      : 0;
  return wordCount * 12 + normalized.length - genericPenalty;
}

/** Cheap semantic goal typing from generic legal-question form; no act/domain hardcoding. */
function inferGoalType(subquery: string, isComplianceContext: boolean): EvidenceGoalType {
  if (isComplianceContext) return 'compliance_check';
  const normalized = normalizeSubqueryForSemantics(subquery);
  if (LIABILITY_GOAL_PATTERNS.some((pattern) => pattern.test(normalized))) return 'liability';
  if (PROCEDURE_GOAL_PATTERNS.some((pattern) => pattern.test(normalized))) return 'procedure';
  return 'definition';
}

function buildGoalMustHaveSignals(subquery: string, goalType: EvidenceGoalType): string[] | undefined {
  if (goalType !== 'procedure') return undefined;
  const normalized = normalizeSubqueryForSemantics(subquery);
  const signals: string[] = [];
  const explicitTaxAppealAnchor =
    /оскаржен\p{L}*\s+(?:податков\p{L}*\s+)?повідомлення-?рішення/iu.test(normalized) ||
    /оскаржен\p{L}*\s+ппр/iu.test(normalized);

  if (/розсліду/iu.test(normalized)) {
    signals.push('підслідність', 'орган досудового розслідування');
  }
  if (/розгляд(?:ає|у|ом)?/iu.test(normalized) || /суд/iu.test(normalized)) {
    signals.push('підсудність');
  }
  if (/оскарж/iu.test(normalized) || /апеляц/iu.test(normalized) || /касац/iu.test(normalized)) {
    signals.push('оскарження');
  }
  if (/строк(?:у|и|ів)?/iu.test(normalized) || /термін(?:у|и|ів)?/iu.test(normalized) || /коли/iu.test(normalized)) {
    signals.push('строк');
  }
  if (/реєстрац/iu.test(normalized) || /зареєстр/iu.test(normalized)) {
    signals.push('реєстрація');
  }
  if (
    /поряд(?:ок|ку)/iu.test(normalized) ||
    /процедур/iu.test(normalized) ||
    /(?:^|[\s,])як(?:[\s?]|$)/iu.test(normalized)
  ) {
    signals.push('порядок');
  }
  if (
    /(?:^|[\s,])пода(?:ти|ння|вати|ється|ються|є|ють|ючи)(?=$|[^\p{L}\p{N}])/iu.test(normalized) ||
    /куди/iu.test(normalized) ||
    /документ\p{L}*/iu.test(normalized)
  ) {
    signals.push('подання');
  }
  if (/єрдр/iu.test(normalized) || /внес\p{L}*\s+відомост/iu.test(normalized)) {
    signals.push('початок досудового розслідування');
  }
  if (
    (/оскарж/iu.test(normalized) || /скарг/iu.test(normalized)) &&
    (/єрдр/iu.test(normalized) || /внес\p{L}*\s+відомост/iu.test(normalized) || /реєстр/iu.test(normalized))
  ) {
    signals.push('скарга на бездіяльність', 'оскарження бездіяльності', 'бездіяльність слідчого');
  }
  if (/сплат/iu.test(normalized) && /(податков|повідомлення-?рішення|грошов)/iu.test(normalized)) {
    signals.push("грошове зобов'язання");
  }
  if (
    /(податков|повідомлення-?рішення|ппр)/iu.test(normalized) &&
    (/оскарж/iu.test(normalized) || /скарг/iu.test(normalized))
  ) {
    signals.push('оскарження податкового повідомлення-рішення');
    if (!explicitTaxAppealAnchor) {
      signals.push('адміністративне оскарження');
    }
  }

  const deduped = uniqueSignals(signals)
    .filter((signal) => !normalized.includes(signal.toLowerCase()))
    .sort((left, right) => rankGoalSignal(right) - rankGoalSignal(left));
  return deduped.length > 0 ? deduped.slice(0, 3) : undefined;
}

/** Structure-only: query has two segments separated by " і " or " та " (min length each). Used to trigger planner for multi-clause. */
export function hasMultiClauseStructure(query: string, minSegmentLength = 5): boolean {
  const q = query.normalize('NFC').trim();
  if (looksLikeCompactActTitleFragmentQuery(q)) return false;
  const split = findTopLevelConjunctionSplit(q);
  if (!split) return false;
  const [left, right] = split;
  if (left.length < minSegmentLength || right.length < minSegmentLength) return false;
  if (shouldSkipStructuralSplitForSingleActScopeQuery(q, left, right)) return false;
  const selectors = extractQueryCitationSelectors(q);
  if (selectors.explicitSelectorCount > 0 || selectors.noteMentioned) {
    return clausesSupportStrongProceduralMixedBundle(left, right);
  }
  return true;
}

function injectSharedTailIntoSplit(left: string, right: string): [string, string] {
  const rightMatch = right.match(
    /^(.+?)\s+((?:при|після|під\s+час|у\s+разі|в\s+разі|щодо|для|через)\s+.+)$/iu
  );
  if (!rightMatch) return [left.trim(), right.trim()];

  const rightHead = rightMatch[1]?.trim() ?? '';
  const sharedTail = rightMatch[2]?.trim() ?? '';
  if (!rightHead || !sharedTail) return [left.trim(), right.trim()];

  const normalizedLeft = left.normalize('NFC').toLowerCase();
  const normalizedTail = sharedTail.normalize('NFC').toLowerCase();
  const leftWithTail = normalizedLeft.includes(normalizedTail) ? left.trim() : `${left.trim()} ${sharedTail}`.trim();
  return [leftWithTail, `${rightHead} ${sharedTail}`.trim()];
}

function maskQuotedFragmentsForClauseSplit(value: string): string {
  return value.replace(/[«"]([^»"\n]{1,220})[»"]/gu, (fragment) =>
    fragment.replace(/[^\s«»"]/gu, 'x')
  );
}

function findTopLevelConjunctionSplit(query: string): [string, string] | null {
  const normalized = query.normalize('NFC').trim();
  if (!normalized) return null;
  const masked = maskQuotedFragmentsForClauseSplit(normalized);
  const match = /^(.*?)\s+(і|та)\s+(.+)$/iu.exec(masked);
  if (!match) return null;
  const left = normalized.slice(0, match[1]?.length ?? 0).trim();
  const separatorMatch = /^\s+(?:і|та)\s+/iu.exec(masked.slice(match[1]?.length ?? 0));
  const rightStart = (match[1]?.length ?? 0) + (separatorMatch?.[0].length ?? 0);
  const right = normalized.slice(rightStart).trim();
  if (!left || !right) return null;
  return [left, right];
}

function shouldSkipStructuralSplitForSingleActScopeQuery(
  query: string,
  left: string,
  right: string
): boolean {
  if (clausesSupportStrongProceduralMixedBundle(left, right)) return false;
  const leftLocator = looksLikeActMetadataLocatorGoal(left);
  const rightLocator = looksLikeActMetadataLocatorGoal(right);
  if ((leftLocator && hasStrongSelectorProceduralSplitCue(right)) || (rightLocator && hasStrongSelectorProceduralSplitCue(left))) {
    return false;
  }
  const explicitSingleActScopeCue =
    extractStructuredActIdentifiers(query).length === 1 ||
    extractQuotedActTitleFragments(query).length === 1 ||
    countStrongActScopeCues(query) === 1;
  if (!explicitSingleActScopeCue) return false;
  const selectors = extractQueryCitationSelectors(query);
  if (selectors.explicitSelectorCount > 0 || selectors.noteMentioned) {
    return !clausesSupportStrongProceduralMixedBundle(left, right);
  }
  return true;
}

/** Split query into subqueries by "?" or by conjunctions "і" / "та" before second question. */
function splitIntoSubqueries(query: string): string[] {
  const q = query.normalize('NFC').trim();
  if (!q) return [q];
  if (looksLikeCompactActTitleFragmentQuery(q)) return [q];

  const parts: string[] = [];
  const byQuestion = q.split(/\s*\?\s*/).map((s) => s.trim()).filter(Boolean);
  if (byQuestion.length >= 2) {
    for (let i = 0; i < byQuestion.length; i++) {
      let sub = byQuestion[i];
      if (i < byQuestion.length - 1) sub = sub + '?';
      if (sub.length >= 3) parts.push(sub);
    }
    if (parts.length > 0) return injectSharedSubjectIntoQuestionParts(parts).slice(0, GOALS_MAX);
  }

  const selectors = extractQueryCitationSelectors(q);
  const conjunctionSplit = findTopLevelConjunctionSplit(q);
  if (
    conjunctionSplit &&
    shouldSkipStructuralSplitForSingleActScopeQuery(q, conjunctionSplit[0], conjunctionSplit[1])
  ) {
    return [q];
  }
  if (selectors.explicitSelectorCount > 0 || selectors.noteMentioned) {
    if (conjunctionSplit && conjunctionSplit[0].length >= 5 && conjunctionSplit[1].length >= 5) {
      const [left, right] = conjunctionSplit;
      if (clausesSupportStrongProceduralMixedBundle(left, right)) {
        const [splitLeft, splitRight] = injectSharedTailIntoSplit(left, right);
        return injectSharedSubjectIntoQuestionParts([splitLeft, splitRight]).slice(0, GOALS_MAX);
      }
    }
    return [q];
  }
  if (conjunctionSplit && conjunctionSplit[0].length >= 5 && conjunctionSplit[1].length >= 5) {
    const [left, right] = injectSharedTailIntoSplit(conjunctionSplit[0], conjunctionSplit[1]);
    return injectSharedSubjectIntoQuestionParts([left, right]).slice(0, GOALS_MAX);
  }

  return [q];
}

function injectSharedSubjectIntoQuestionParts(parts: string[]): string[] {
  if (parts.length < 2) return parts;
  const sharedSubject = extractSubjectFocus(extractSharedSubject(parts[0] ?? ''));
  if (!sharedSubject) return parts;

  return parts.map((part, index) => {
    if (index === 0) return part;
    let updated = part.trim();
    const replacements: Array<[RegExp, string]> = [
      [/цю\s+статтю/iu, sharedSubject],
      [/цей\s+злочин/iu, sharedSubject],
      [/це\s+правопорушення/iu, sharedSubject],
      [/цей\s+договір/iu, sharedSubject],
      [/це\s+питання/iu, sharedSubject],
      [/так(?:е|ого|ому)\s+оскаржен(?:ня|ні|ню|ням)/iu, sharedSubject],
      [/так(?:у|ої|ою)\s+скарг(?:у|и|ою|і)/iu, sharedSubject],
      [/так(?:у|ої|ою)\s+заяв(?:у|и|ою|і)/iu, sharedSubject],
      [/так(?:ий|ого|ому)\s+позов(?:у|ом)?/iu, sharedSubject],
      [/так(?:е|ого|ому)\s+рішенн(?:я|і|ю|ям)/iu, sharedSubject],
      [/так(?:ій|ої|ою)\s+справ(?:і|и|ою)/iu, sharedSubject],
    ];
    for (const [pattern, replacement] of replacements) {
      updated = updated.replace(pattern, replacement);
    }

    const normalizedUpdated = normalizeSubqueryForSemantics(updated).toLowerCase();
    const normalizedSubject = sharedSubject.toLowerCase();
    const isYesNoFollowUp = /^(?:і\s+|та\s+)?чи(?:[\s?]|$)/iu.test(updated);
    const isGenericProceduralQuestion =
      /^(?:і\s+|та\s+)?(?:хто|як|коли|куди|чи|в\s+який\s+строк|який\s+строк|який\s+порядок|які\s+документ\p{L}*|який\s+перелік\s+документ\p{L}*)(?:[\s?]|$)/iu.test(updated);
    if ((isGenericProceduralQuestion || isYesNoFollowUp) && !normalizedUpdated.includes(normalizedSubject)) {
      updated = `${updated.replace(/\?+$/g, '').trim()} ${sharedSubject}`.trim();
      if (/\?$/.test(part)) updated = `${updated}?`;
    }
    return updated;
  });
}

function extractSharedSubject(prefix: string): string {
  const normalizedPrefix = prefix.normalize('NFC').replace(/\?+$/g, '').trim();
  const liabilityMatch = normalizedPrefix.match(
    /(?:яка|який|яке|які)?\s*відповідаль(?:ність|ності)\s+за\s+(.+)$/i
  );
  if (liabilityMatch?.[1]?.trim()) return liabilityMatch[1].trim();
  return normalizedPrefix;
}

function extractSubjectFocus(subject: string): string {
  const normalized = subject.normalize('NFC').replace(/\?+$/g, '').trim();
  const prepositionMatch = normalized.match(
    /(?:^|[\s,])(?:від|про|щодо|для|при|після|під\s+час|за|у|в)\s+(.+)$/iu
  );
  if (prepositionMatch?.[1]?.trim()) return prepositionMatch[1].trim();
  const tokens = normalized
    .split(/[^\p{L}\p{N}'’ʼ-]+/u)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 &&
        !['що', 'таке', 'яка', 'який', 'яке', 'які', 'це', 'ця', 'цей', 'цю'].includes(token.toLowerCase())
    );
  return tokens.slice(-2).join(' ').trim() || normalized;
}

function buildContrastiveLiabilitySubqueries(query: string): string[] | null {
  const q = query.normalize('NFC').trim();
  const match = q.match(
    /^(.+?)\s+(?:і|та)\s+коли\s+(?:це\s+)?([^,?]+?)\s*,\s*а\s+коли\s+(?:це\s+)?([^?]+?)\??$/i
  );
  if (!match) return null;
  const prefix = match[1]?.trim() ?? '';
  const leftAspect = match[2]?.trim() ?? '';
  const rightAspect = match[3]?.trim() ?? '';
  if (prefix.length < 8 || leftAspect.length < 3 || rightAspect.length < 3) return null;

  const sharedSubject = extractSharedSubject(prefix);
  const subjectFocus = extractSubjectFocus(sharedSubject);
  const carriesLiabilityTerm = /відповідаль(?:ність|ності)/i.test(prefix);
  const aspectQueries = [leftAspect, rightAspect].map((aspect) => {
    const needsLiabilityTail =
      carriesLiabilityTerm && !/відповідаль(?:ність|ності)/i.test(aspect);
    const compactSubjectPrefix =
      subjectFocus && subjectFocus !== sharedSubject ? `${subjectFocus} ` : `${sharedSubject} `;
    return `${compactSubjectPrefix}${aspect}${needsLiabilityTail ? ' відповідальність' : ''}`.trim();
  });
  const dedupedAspects = [...new Set(aspectQueries.map((part) => part.trim()).filter(Boolean))];
  if (dedupedAspects.length >= 2) {
    return dedupedAspects.slice(0, GOALS_MAX);
  }

  const fallback = [...new Set([prefix, ...dedupedAspects].map((part) => part.trim()).filter(Boolean))];
  return fallback.length >= 2 ? fallback.slice(0, GOALS_MAX) : null;
}

function hasProceduralBundleReference(query: string): boolean {
  const normalized = query.normalize('NFC');
  return [
    /так(?:е|ого|ому)\s+оскаржен/iu,
    /(?:це|таке)\s+оскаржу/iu,
    /так(?:у|ої|ою)\s+скарг/iu,
    /так(?:у|ої|ою)\s+заяв/iu,
    /так(?:ий|ого|ому)\s+позов/iu,
    /так(?:е|ого|ому)\s+рішенн/iu,
    /так(?:ій|ої|ою)\s+справ/iu,
    /цю\s+заяв/iu,
    /цю\s+скарг/iu,
    /це\s+рішенн/iu,
    /(?:під|на)\s+час\s+(?:оскаржен|розгляд\p{L}*|подан\p{L}*|розслідуван\p{L}*|виконан\p{L}*)/iu,
    /(?:при|після|у\s+ході)\s+(?:оскаржен|розгляд\p{L}*|подан\p{L}*|розслідуван\p{L}*|виконан\p{L}*)/iu,
    /які\s+документ\p{L}*\s+пода(?:ти|ння|вати|ється|ються|є|ють|ючи)(?=$|[^\p{L}\p{N}])/iu,
    /який\s+перелік\s+документ\p{L}*/iu,
    /в\s+який\s+строк/iu,
  ].some((pattern) => pattern.test(normalized));
}

function looksLikeActMetadataFollowUp(subquery: string): boolean {
  const normalized = normalizeSubqueryForSemantics(subquery);
  return ACT_METADATA_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeActMetadataLocatorGoal(subquery: string): boolean {
  return hasInterrogativeActLocatorCue(subquery.normalize('NFC'));
}

function looksLikeActMetadataBundleQuery(query: string): boolean {
  const normalized = query.normalize('NFC');
  return hasInterrogativeActLocatorCue(normalized) && ACT_METADATA_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function tryCompactActMetadataBundleGoals(
  query: string,
  goals: EvidenceGoal[],
  domainHint: string | undefined,
  isComplianceContext: boolean
): EvidenceGoal[] | null {
  if (goals.length < 2) return null;
  if (!looksLikeActMetadataBundleQuery(query)) return null;
  if (countStrongActScopeCues(query) > 1) return null;
  if (goals.some((goal) => goal.goal_type === 'liability')) return null;
  if (goals.some((goal) => (goal.required_categories?.length ?? 0) > 0)) return null;
  const locatorGoals = goals.filter((goal) => looksLikeActMetadataLocatorGoal(goal.subquery));
  if (locatorGoals.length !== 1) return null;
  const metadataFollowUpGoals = goals.filter((goal) => !looksLikeActMetadataLocatorGoal(goal.subquery));
  if (metadataFollowUpGoals.length === 0) return null;
  if (!metadataFollowUpGoals.every((goal) => looksLikeActMetadataFollowUp(goal.subquery))) return null;

  return [
    {
      id: 'goal_0',
      goal_type: isComplianceContext ? 'compliance_check' : 'definition',
      subquery: query.slice(0, 4000),
      domain_hint: domainHint,
    },
  ];
}

function mergeGoalSignals(goals: EvidenceGoal[]): string[] | undefined {
  const merged = [
    ...new Set(
      goals
        .flatMap((goal) => goal.must_have_signals ?? [])
        .map((signal) => signal.trim())
        .filter(Boolean)
    ),
  ];
  return merged.length > 0 ? merged : undefined;
}

function hasActLocatorProceduralRemedyBundle(goals: EvidenceGoal[]): boolean {
  const locatorGoals = goals.filter((goal) => looksLikeActMetadataLocatorGoal(goal.subquery));
  if (locatorGoals.length !== 1) return false;
  return goals.some(
    (goal) =>
      !looksLikeActMetadataLocatorGoal(goal.subquery) &&
      goal.goal_type === 'procedure' &&
      hasStrongSelectorProceduralSplitCue(goal.subquery)
  );
}

function tryCompactProceduralBundleGoals(
  query: string,
  goals: EvidenceGoal[],
  domainHint: string | undefined,
  isComplianceContext: boolean
): EvidenceGoal[] | null {
  if (goals.length < 2) return null;
  if (!goals.every((goal) => goal.goal_type === 'procedure')) return null;
  if (!hasProceduralBundleReference(query)) return null;
  const explicitActScopeCue = hasExplicitActScopeCue(query);
  const strongActScopeCueCount = countStrongActScopeCues(query);
  if (strongActScopeCueCount > 1) return null;
  if (explicitActScopeCue && strongActScopeCueCount !== 1) return null;
  if (strongActScopeCueCount === 1 && hasActLocatorProceduralRemedyBundle(goals)) return null;
  return [
    {
      id: 'goal_0',
      goal_type: isComplianceContext ? 'compliance_check' : 'procedure',
      subquery: query.slice(0, 4000),
      domain_hint: domainHint,
      must_have_signals: mergeGoalSignals(goals),
    },
  ];
}

function looksLikeNormLocatorBundle(query: string, goals: EvidenceGoal[]): boolean {
  if (goals.length < 2) return false;
  const normalized = query.normalize('NFC');
  const hasLocatorCue = [
    /де\s+шукати\s+(?:норм|статт|положенн|вимог)/iu,
    /на\s+що\s+посилат/iu,
    /з\s+яких\s+норм/iu,
    /яка\s+(?:норм|статт|підстава)/iu,
    /які\s+(?:норм|статт|положенн|вимог)/iu,
    /де\s+це\s+написано/iu,
  ].some((pattern) => pattern.test(normalized));
  if (!hasLocatorCue) return false;
  const goalText = goals.map((goal) => goal.subquery).join(' ');
  return /(?:норм|статт|положенн|вимог|наслідк|підстав|строк)/iu.test(goalText);
}

export function hasExplicitActScopeCue(query: string): boolean {
  const normalized = query.normalize('NFC');
  if (extractStructuredActIdentifiers(query).length > 0) return true;
  if (hasInterrogativeActLocatorCue(normalized)) return true;
  return [
    /(?:^|[\s,])за\s+законом(?:\s+україни)?\s+[«"“”„]?\s*про\s+/iu,
    /(?:^|[\s,])законом?(?:\s+україни)?\s+[«"“”„]?\s*про\s+/iu,
    /(?:^|[\s,])за\s+(?:конвенцією|міжнародним\s+договором|угодою|статутом)\s+/iu,
    /(?:^|[\s,])(?:конвенція|міжнародний\s+договір|угода|статут)\s+[«"“”„]?[^\n,.?!;:]{4,160}/iu,
    /(?:^|[\s,])(?:постанова|наказ|розпорядження|указ|рішення)\s+про\s+[^\n,.?!;:]{6,160}/iu,
    /(?:^|[\s,])відповідно\s+до\s+(?:закону|кодексу|порядку|правил|положення|постанови|наказу|розпорядження|указу|рішення|інструкції)/iu,
    /(?:^|[\s,])згідно\s+із?\s+(?:законом|кодексом|порядком|правилами|положенням|постановою|наказом|розпорядженням|указом|рішенням|інструкцією)/iu,
    /(?:^|[\s,])(?:відповідно\s+до|згідно\s+із?)\s+(?:конвенції|міжнародного\s+договору|угоди|статуту)/iu,
    /(?:^|[\s,])передбачен\p{L}*\s+(?:законом|кодексом|порядком|правилами|положенням|постановою|наказом|розпорядженням|указом|рішенням|інструкцією)/iu,
    /(?:^|[\s,])кодекс(?:ом|у|і)?\s+україни/iu,
    /(?:^|[\s,])(?:постанова|наказ|розпорядження|указ|рішення|положення|правила|порядок|інструкція)\s+№\s*[\p{L}\d./-]{2,}/iu,
    /(?:^|[\s,])(?:постанова|наказ|розпорядження|указ|рішення)\s+[^\n,.?!;:]{0,40}№\s*[\p{L}\d./-]{2,}/iu,
    /(?:^|[\s,])за\s+(?:постановою|наказом|розпорядженням|указом|рішенням|положенням|правилами|порядком|інструкцією)\s+№\s*[\p{L}\d./-]{2,}/iu,
  ].some((pattern) => pattern.test(normalized));
}

export function countStrongActScopeCues(query: string): number {
  const structuredIdentifiers = extractStructuredActIdentifiers(query);
  if (structuredIdentifiers.length > 0) return structuredIdentifiers.length;
  const normalized = query.normalize('NFC');
  const patterns = [
    /(?:^|[\s,?!.])я(?:ким|кою|ке|кий|ка|кі|кого|кої|кому|кими|ких)(?:\s+саме)?\s+(?:(?:(?:спеціальн|профільн|урядов|підзаконн|нормативн|нормативно-правов|відомч|галузев|банківськ|регуляторн)\p{L}*\s+){0,2})(?:акт\p{L}*|закон\p{L}*|кодекс\p{L}*|постанов\p{L}*|наказ\p{L}*|розпоряджен\p{L}*|указ\p{L}*|рішен\p{L}*)\s+[^\n,.?!;:]{3,200}/giu,
    /(?:^|[\s,])(?:постанов\p{L}*|наказ\p{L}*|розпоряджен\p{L}*|указ\p{L}*|рішен\p{L}*|положенн\p{L}*|правил\p{L}*|поряд\p{L}*|інструкц\p{L}*)(?:\s+[^\n,.?!;:]{0,40})?\s+№\s*[\p{L}\d./-]{2,}/giu,
    /(?:^|[\s,])(?:постанов\p{L}*|наказ\p{L}*|розпоряджен\p{L}*|указ\p{L}*|рішен\p{L}*)\s+про\s+[^\n,.?!;:]{6,160}/giu,
    /(?:^|[\s,])(?:за\s+)?закон\p{L}*(?:\s+україни)?\s+[«"“”„]?\s*про\s+[^\n,.?!;:]{4,80}/giu,
    /(?:^|[\s,])кодекс\p{L}*\s+україни/giu,
    /(?:^|[\s,])(?:за\s+)?(?:конвенц\p{L}*|міжнародн\p{L}*\s+договор\p{L}*|угод\p{L}*|статут\p{L}*)\s+[«"“”„]?[^\n,.?!;:]{4,120}/giu,
  ];
  return patterns.reduce((count, pattern) => count + [...normalized.matchAll(pattern)].length, 0);
}

export function hasSingleStrongActScopeCue(query: string): boolean {
  return countStrongActScopeCues(query) === 1;
}

function tryCompactSameActBundleGoals(
  query: string,
  goals: EvidenceGoal[],
  domainHint: string | undefined,
  isComplianceContext: boolean,
  reasonCodes: string[]
): EvidenceGoal[] | null {
  if (goals.length < 2) return null;
  if (!reasonCodes.includes('multi_clause_structure')) return null;
  const strongActScopeCueCount = countStrongActScopeCues(query);
  const strongSingleActScopeCue = strongActScopeCueCount === 1;
  if (strongActScopeCueCount > 1) return null;
  const questionMarks = (query.match(/\?/g) || []).length;
  if (reasonCodes.includes('multi_question') && questionMarks >= 2 && !strongSingleActScopeCue) return null;
  if (reasonCodes.includes('contrastive_liability_split')) return null;
  if (!looksLikeNormLocatorBundle(query, goals) && !strongSingleActScopeCue) return null;
  if (strongSingleActScopeCue && hasActLocatorProceduralRemedyBundle(goals)) return null;
  if (goals.some((goal) => (goal.required_categories?.length ?? 0) > 0)) return null;
  const distinctGoalDomains = new Set(
    goals
      .map((goal) => (goal.domain_hint ?? '').normalize('NFC').toLowerCase().trim())
      .filter(Boolean)
  );
  if (distinctGoalDomains.size > 1) return null;

  const mergedSignals = mergeGoalSignals(goals);
  const hasProcedure = goals.some((goal) => goal.goal_type === 'procedure');
  const hasLiability = goals.some((goal) => goal.goal_type === 'liability');
  const distinctGoalTypes = new Set(
    goals.map((goal) => goal.goal_type).filter((goalType): goalType is EvidenceGoalType => Boolean(goalType))
  );
  if (
    hasProcedure &&
    [...distinctGoalTypes].some((goalType) => goalType !== 'procedure') &&
    extractQueryCitationSelectors(query).explicitSelectorCount > 0 &&
    hasStrongSelectorProceduralSplitCue(query)
  ) {
    return null;
  }
  if (hasProcedure && hasLiability) return null;
  const compactedGoalType = hasProcedure && !hasLiability
    ? 'procedure'
    : hasLiability && !hasProcedure
      ? 'liability'
      : inferGoalType(query, isComplianceContext);

  return [
    {
      id: 'goal_0',
      goal_type: isComplianceContext ? 'compliance_check' : compactedGoalType,
      subquery: query.slice(0, 4000),
      domain_hint: domainHint,
      must_have_signals: mergedSignals,
    },
  ];
}

/**
 * Heuristic goal splitter. No LLM. Uses multi_question, multi_topic, routing_flags.
 */
export function heuristicGoalSplit(
  query: string,
  domainHint?: string,
  routingFlags?: RoutingFlags | null
): GoalSplitResult {
  const reasonCodes: string[] = [];
  const goals: EvidenceGoal[] = [];
  const inputLikeContract = !!routingFlags?.input_looks_like_contract;
  const inputLikeTable = !!routingFlags?.input_looks_like_table;
  const inputIsLarge = !!routingFlags?.input_is_large;

  const topLevelConjunctionSplit = findTopLevelConjunctionSplit(query);
  const singleActScopeCompacted =
    !!topLevelConjunctionSplit &&
    shouldSkipStructuralSplitForSingleActScopeQuery(query, topLevelConjunctionSplit[0], topLevelConjunctionSplit[1]);
  const multiQ = detectMultiQuestion(query);
  const multiClause = hasMultiClauseStructure(query);
  const { domains } = getDomainsFromHint(domainHint);

  if (multiQ) reasonCodes.push('multi_question');
  if (multiClause) reasonCodes.push('multi_clause_structure');
  if (inputLikeContract) reasonCodes.push('input_looks_like_contract');
  if (inputLikeTable) reasonCodes.push('input_looks_like_table');

  const contrastiveLiabilitySubqueries = buildContrastiveLiabilitySubqueries(query);
  if (contrastiveLiabilitySubqueries) reasonCodes.push('contrastive_liability_split');
  const subqueries = contrastiveLiabilitySubqueries ?? splitIntoSubqueries(query);
  // Structure-only: multi-goal only from multiple "?" or contract-like input. Semantic multi-goal from planner/taxonomy.
  const useMultiGoal =
    (contrastiveLiabilitySubqueries != null && subqueries.length >= 2) ||
    (multiQ && subqueries.length >= 2) ||
    (multiClause && subqueries.length >= 2) ||
    (inputLikeContract && query.length > 100);

  if (!useMultiGoal || subqueries.length === 0) {
    const compactedActMetadataBundle =
      singleActScopeCompacted && looksLikeActMetadataBundleQuery(query);
    const singleGoalType = compactedActMetadataBundle
      ? 'definition'
      : inputLikeContract
        ? 'compliance_check'
        : inferGoalType(query, false);
    const singleReasonCodes: string[] = [];
    if (singleActScopeCompacted) singleReasonCodes.push('same_act_bundle_compaction');
    if (compactedActMetadataBundle) singleReasonCodes.push('act_metadata_bundle_compaction');
    const single: EvidenceGoal = {
      id: 'goal_0',
      goal_type: singleGoalType,
      subquery: query.slice(0, 4000),
      domain_hint: domainHint,
      must_have_signals: compactedActMetadataBundle ? undefined : buildGoalMustHaveSignals(query, singleGoalType),
    };
    return { goals: [single], used_heuristic: true, used_llm_planner: false, reason_codes: singleReasonCodes };
  }

  const capped = subqueries.slice(0, GOALS_MAX);
  for (let i = 0; i < capped.length; i++) {
    const sub = capped[i].slice(0, 4000);
    const goalType = inferGoalType(sub, inputLikeContract);
    const domainForGoal = domains[i] ?? domainHint;
    goals.push({
      id: `goal_${i}`,
      goal_type: goalType,
      subquery: sub,
      domain_hint: domainForGoal,
      must_have_signals: buildGoalMustHaveSignals(sub, goalType),
    });
  }

  const compactedProceduralGoals = tryCompactProceduralBundleGoals(
    query,
    goals,
    domainHint,
    inputLikeContract
  );
  if (compactedProceduralGoals) {
    return {
      goals: compactedProceduralGoals,
      used_heuristic: true,
      used_llm_planner: false,
      reason_codes: [...reasonCodes, 'procedural_bundle_compaction'],
    };
  }

  const compactedActMetadataGoals = tryCompactActMetadataBundleGoals(
    query,
    goals,
    domainHint,
    inputLikeContract
  );
  if (compactedActMetadataGoals) {
    return {
      goals: compactedActMetadataGoals,
      used_heuristic: true,
      used_llm_planner: false,
      reason_codes: [...reasonCodes, 'same_act_bundle_compaction', 'act_metadata_bundle_compaction'],
    };
  }

  const compactedSameActGoals = tryCompactSameActBundleGoals(
    query,
    goals,
    domainHint,
    inputLikeContract,
    reasonCodes
  );
  if (compactedSameActGoals) {
    return {
      goals: compactedSameActGoals,
      used_heuristic: true,
      used_llm_planner: false,
      reason_codes: [...reasonCodes, 'same_act_bundle_compaction'],
    };
  }

  return {
    goals,
    used_heuristic: true,
    used_llm_planner: false,
    reason_codes: reasonCodes,
  };
}

/** Direct citation: query mentions article number / act reference — avoid splitting. */
function isDirectCitation(query: string): boolean {
  const q = query.normalize('NFC');
  return /ст\.\s*\d+|стаття\s*\d+|статті\s*\d+|згідно\s+з\s+статтею|ст\s*\d+\s+кку|ст\s*\d+\s+кзпп/i.test(q);
}

/**
 * Try taxonomy-induced category-cluster split (substance vs procedure).
 * Uses only taxonomy data (category from alias_hits); no word lists.
 * Returns 2 goals when two strong category clusters exist; otherwise returns null (no split).
 */
export function tryCategoryClusterSplitV2(
  taxonomy: TaxonomyInputForSplit,
  query: string,
  domainHint?: string,
  _routingFlags?: RoutingFlags | null
): GoalSplitResult | null {
  if (isDirectCitation(query)) return null;
  if (countStrongActScopeCues(query) === 1) {
    return null;
  }
  if ((taxonomy.exact_act_hit_count ?? 0) === 1 || (taxonomy.grounded_act_hit_count ?? 0) === 1) {
    return null;
  }
  if (
    looksLikeCompactActTitleFragmentQuery(query) &&
    hasDominantSoftSingleActConvergence(taxonomy)
  ) {
    return null;
  }
  const hits = taxonomy.alias_hits ?? [];
  if (hits.length === 0) return null;

  const categorySupport: Record<string, number> = {};
  const nregsByCategory = new Map<string, Set<string>>();
  for (const h of hits) {
    const cat = h.category ?? '_';
    if (!nregsByCategory.has(cat)) nregsByCategory.set(cat, new Set());
    nregsByCategory.get(cat)!.add(h.rada_nreg);
  }
  for (const [cat, set] of nregsByCategory) {
    if (cat !== '_') categorySupport[cat] = set.size;
  }

  const sorted = Object.entries(categorySupport)
    .filter(([, count]) => count >= CATEGORY_SPLIT_MIN_SUPPORT)
    .sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return null;

  const [top1Cat, top1Support] = sorted[0];
  const [top2Cat, top2Support] = sorted[1];
  if (top2Support < top1Support * CATEGORY_SPLIT_MIN_RATIO) return null;
  if (top1Cat === '_' || top2Cat === '_') return null;

  const top1IsSubstance = SUBSTANCE_CATEGORIES.has(normalizeCategoryKey(top1Cat));
  const top2IsProcedure = PROCEDURE_CATEGORIES.has(normalizeCategoryKey(top2Cat));
  const top2IsSubstance = SUBSTANCE_CATEGORIES.has(normalizeCategoryKey(top2Cat));
  const top1IsProcedure = PROCEDURE_CATEGORIES.has(normalizeCategoryKey(top1Cat));
  const substanceCat = top1IsSubstance ? top1Cat : top2IsSubstance ? top2Cat : top1Cat;
  const procedureCat = top2IsProcedure ? top2Cat : top1IsProcedure ? top1Cat : top2Cat;
  if (substanceCat === procedureCat) return null;

  const goalSubstance: EvidenceGoal = {
    id: 'goal_0',
    goal_type: 'definition',
    subquery: query.slice(0, 4000),
    domain_hint: domainHint,
    required_categories: [substanceCat],
  };
  const goalProcedure: EvidenceGoal = {
    id: 'goal_1',
    goal_type: 'procedure',
    subquery: query.slice(0, 4000),
    domain_hint: domainHint,
    required_categories: [procedureCat],
  };

  return {
    goals: [goalSubstance, goalProcedure],
    used_heuristic: true,
    used_llm_planner: false,
    reason_codes: ['TAXONOMY_CLUSTER_SPLIT_V2'],
  };
}
