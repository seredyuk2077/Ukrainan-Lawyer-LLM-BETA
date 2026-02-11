/**
 * U4 Evidence Goals — multi-goal retrieval planning (no DB writes).
 * Goal types: definition, liability, procedure, compliance_check, reference_resolution.
 */
export type EvidenceGoalType =
  | 'definition'
  | 'liability'
  | 'procedure'
  | 'compliance_check'
  | 'reference_resolution';

export interface EvidenceGoal {
  id: string;
  goal_type: EvidenceGoalType;
  subquery: string;
  domain_hint?: string;
  required_categories?: string[];
  must_have_signals?: string[];
  budget_hint?: 'low' | 'normal' | 'high';
}

export interface GoalSplitResult {
  goals: EvidenceGoal[];
  used_heuristic: boolean;
  used_llm_planner: boolean;
  reason_codes: string[];
}
