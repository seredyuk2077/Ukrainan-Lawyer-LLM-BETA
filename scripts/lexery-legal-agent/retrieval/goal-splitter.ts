/**
 * U4 Heuristic goal splitter — no LLM by default.
 * Detects: multi_question, multi_topic, contract/table-like from routing_flags.
 * V2: taxonomy-induced category-cluster split (substance vs procedure) when taxonomy data provided.
 */
import type { EvidenceGoal, EvidenceGoalType, GoalSplitResult } from './goals.js';
import type { RoutingFlags } from '../classify/types.js';
import { config } from '../lib/config.js';

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
  alias_hits: Array<{ rada_nreg: string; category?: string | null }>;
  category_hints: string[];
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

/** Structure-only: direct citation (article/act ref) — avoid splitting. No topic inference for goal_type. */
function inferGoalType(_subquery: string, isComplianceContext: boolean): EvidenceGoalType {
  if (isComplianceContext) return 'compliance_check';
  return 'definition';
}

/** Structure-only: query has two segments separated by " і " or " та " (min length each). Used to trigger planner for multi-clause. */
export function hasMultiClauseStructure(query: string, minSegmentLength = 5): boolean {
  const q = query.normalize('NFC').trim();
  const andMatch = q.match(/^(.+?)\s+і\s+(.+)$/i) || q.match(/^(.+?)\s+та\s+(.+)$/i);
  if (!andMatch) return false;
  return andMatch[1].trim().length >= minSegmentLength && andMatch[2].trim().length >= minSegmentLength;
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

/** Split query into subqueries by "?" or by conjunctions "і" / "та" before second question. */
function splitIntoSubqueries(query: string): string[] {
  const q = query.normalize('NFC').trim();
  if (!q) return [q];

  const parts: string[] = [];
  const byQuestion = q.split(/\s*\?\s*/).map((s) => s.trim()).filter(Boolean);
  if (byQuestion.length >= 2) {
    for (let i = 0; i < byQuestion.length; i++) {
      let sub = byQuestion[i];
      if (i < byQuestion.length - 1) sub = sub + '?';
      if (sub.length >= 3) parts.push(sub);
    }
    if (parts.length > 0) return parts.slice(0, GOALS_MAX);
  }

  const andMatch = q.match(/^(.+?)\s+і\s+(.+)$/i) || q.match(/^(.+?)\s+та\s+(.+)$/i);
  if (andMatch && andMatch[1].length >= 5 && andMatch[2].length >= 5) {
    const [left, right] = injectSharedTailIntoSplit(andMatch[1], andMatch[2]);
    return [left, right].slice(0, GOALS_MAX);
  }

  return [q];
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
    /(?:^|[\s,])(?:від|про|щодо|для|при|після|під\s+час|у|в)\s+(.+)$/iu
  );
  if (prepositionMatch?.[1]?.trim()) return prepositionMatch[1].trim();
  const tokens = normalized
    .split(/[^\p{L}\p{N}-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
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
    const focusPrefix =
      subjectFocus && subjectFocus !== sharedSubject ? `${subjectFocus} ` : '';
    const sharedSuffix =
      subjectFocus && subjectFocus !== sharedSubject ? ` ${sharedSubject}` : '';
    return `${focusPrefix}${aspect}${needsLiabilityTail ? ' відповідальність' : ''}${sharedSuffix}`.trim();
  });
  const deduped = [...new Set([prefix, ...aspectQueries].map((part) => part.trim()).filter(Boolean))];
  return deduped.length >= 2 ? deduped.slice(0, GOALS_MAX) : null;
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
    const single: EvidenceGoal = {
      id: 'goal_0',
      goal_type: inputLikeContract ? 'compliance_check' : inferGoalType(query, false),
      subquery: query.slice(0, 4000),
      domain_hint: domainHint,
    };
    return { goals: [single], used_heuristic: true, used_llm_planner: false, reason_codes: [] };
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
    });
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
