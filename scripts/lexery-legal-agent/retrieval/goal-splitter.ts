/**
 * U4 Heuristic goal splitter — no LLM by default.
 * Detects: multi_question, multi_topic, contract/table-like from routing_flags.
 * V2: taxonomy-induced category-cluster split (substance vs procedure) when taxonomy data provided.
 */
import type { EvidenceGoal, EvidenceGoalType, GoalSplitResult } from './goals.js';
import type { RoutingFlags } from '../classify/types.js';
import { config } from '../lib/config.js';

const GOALS_MAX = config.u4GoalsMax;

/** Categories that denote "substance" (material law) from taxonomy schema. */
const SUBSTANCE_CATEGORIES = new Set([
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
const PROCEDURE_CATEGORIES = new Set([
  'judiciary_justice',
  'criminal_procedure',
  'civil_procedure',
  'civil_procedure_administrative',
]);

/** Min support (unique acts per category in taxonomy) to consider for cluster split. */
const CATEGORY_SPLIT_MIN_SUPPORT = 2;
/** Min ratio of second to first category support to trigger split (avoid tiny second cluster). */
const CATEGORY_SPLIT_MIN_RATIO = 0.3;

/** Taxonomy input for category-cluster split (from getTaxonomyCandidates). */
export type TaxonomyInputForSplit = {
  alias_hits: Array<{ rada_nreg: string; category?: string | null }>;
  category_hints: string[];
};

/** Multi-question: multiple "?" or "і … ?" / "та … ?" / "і чия …" */
function detectMultiQuestion(query: string): boolean {
  const q = query.normalize('NFC').trim();
  const questionMarks = (q.match(/\?/g) || []).length;
  if (questionMarks >= 2) return true;
  if (/\s+і\s+чия\s+/i.test(q) || /\s+та\s+чия\s+/i.test(q)) return true;
  if (/\s+і\s+[^?]*\?\s*$/i.test(q) && questionMarks >= 1) return true;
  return false;
}

/** Multi-topic: markers of different subdomains (criminal + procedure, tax + admin, labor + civil). */
function detectMultiTopic(query: string, domainHint?: string): { multi: boolean; domains: string[] } {
  const q = query.normalize('NFC').toLowerCase();
  const domains: string[] = [];
  if (domainHint) domains.push(domainHint);
  const criminal = /кримін|злочин|вбивств|шахрайств|кку|кк\s*у|кримінальн/i.test(q);
  const procedure = /підслідн|досудов|слідч|кпк|кримінальн.*процес|оскаржен|позов|ципк|цпк/i.test(q);
  const tax = /податк|податков|пкку|пк\s*у/i.test(q);
  const admin = /адмін|адміністратив|купап|кодекс.*правопоруш/i.test(q);
  const labor = /труд|звільнен|трудовий\s+договір|кзпп/i.test(q);
  const civil = /цивіль|цик|цк\s*у|договір|спадщин|кзпп|споживач/i.test(q);
  const compliance = /відповідність|відповідає|перевір.*на\s+відповід|відповідно\s+до/i.test(q);

  if (criminal) domains.push('criminal');
  if (procedure) domains.push('criminal_procedure');
  if (tax) domains.push('tax_customs');
  if (admin) domains.push('admin');
  if (labor) domains.push('labor');
  if (civil) domains.push('civil');
  if (compliance) domains.push('compliance');

  const unique = [...new Set(domains)];
  const multi = unique.length >= 2;
  return { multi, domains: unique };
}

/** Infer goal_type from subquery tokens (heuristic). */
function inferGoalType(subquery: string, isComplianceContext: boolean): EvidenceGoalType {
  const q = subquery.normalize('NFC').toLowerCase();
  if (isComplianceContext || /відповідність|перевір.*відповід|відповідає/i.test(q)) return 'compliance_check';
  if (/що таке|визначення|означає|розуміння/i.test(q)) return 'definition';
  if (/підслідн|досудов|слідч|оскаржен|позов|порядок|строки|процедур/i.test(q)) return 'procedure';
  if (/відповідальність|штраф|санкція|покарання|позбавлення/i.test(q)) return 'liability';
  if (/ст\.\s*\d+|стаття\s*\d+|згідно\s+з|згідно\s+статті/i.test(q)) return 'reference_resolution';
  return 'definition';
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
    return [andMatch[1].trim(), andMatch[2].trim()].slice(0, GOALS_MAX);
  }

  return [q];
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
  const { multi: multiT, domains } = detectMultiTopic(query, domainHint);

  if (multiQ) reasonCodes.push('multi_question');
  if (multiT) reasonCodes.push('multi_topic');
  if (inputLikeContract) reasonCodes.push('input_looks_like_contract');
  if (inputLikeTable) reasonCodes.push('input_looks_like_table');

  const subqueries = splitIntoSubqueries(query);
  const useMultiGoal = subqueries.length >= 2 || (multiT && domains.length >= 2) || (inputLikeContract && query.length > 100);

  if (!useMultiGoal || subqueries.length === 0) {
    const single: EvidenceGoal = {
      id: 'goal_0',
      goal_type: inputLikeContract && /відповідність|перевір/i.test(query) ? 'compliance_check' : inferGoalType(query, inputLikeContract),
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

  const top1IsSubstance = SUBSTANCE_CATEGORIES.has(top1Cat);
  const top2IsProcedure = PROCEDURE_CATEGORIES.has(top2Cat);
  const top2IsSubstance = SUBSTANCE_CATEGORIES.has(top2Cat);
  const top1IsProcedure = PROCEDURE_CATEGORIES.has(top1Cat);
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
