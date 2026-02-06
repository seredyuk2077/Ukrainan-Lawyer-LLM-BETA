/**
 * U2 Query Profiling — Types (LEX-87, LEX-94)
 */

export type Intent =
  | 'question'
  | 'drafting'
  | 'procedure'
  | 'research'
  | 'other';

export type LegalDomain =
  | 'criminal'
  | 'civil'
  | 'labor'
  | 'admin'
  | 'tax'
  | 'corporate'
  | 'general';

export type EntityType =
  | 'act_abbrev'
  | 'law_title'
  | 'article_ref'
  | 'authority'
  | 'term';

export interface ExtractedEntity {
  type: EntityType;
  value: string;
  norm?: { act?: string; article?: string; part?: string };
}

/** Rule-based reason codes for ambiguity (for override policy and audit) */
export type AmbiguityReasonCode =
  | 'AMBIG_TERM_MATCH'
  | 'TOO_SHORT_QUERY'
  | 'NO_ENTITIES_GENERIC_TOPIC'
  | 'GENERAL_DOMAIN_NO_DIRECT_REF';

export interface AmbiguityResult {
  is_ambiguous: boolean;
  reasons: string[];
  ambig_terms?: string[];
  /** When from rules: "hard" = override LLM (e.g. AMBIG_TERMS); "soft" = merge/OR */
  strength?: 'hard' | 'soft';
  /** Canonical reason codes for audit (e.g. AMBIG_TERM_MATCH) */
  reason_codes?: AmbiguityReasonCode[];
}

export interface RoutingFlags {
  need_deep_retrieval?: boolean;
  need_web?: boolean;
  ambiguous?: boolean;
  input_is_large?: boolean;
  need_clarification?: boolean;
  /** U2: input has file attachments (e.g. PDF) */
  has_attachments?: boolean;
  /** U2: heuristic/LLM — input looks like contract text */
  input_looks_like_contract?: boolean;
  /** U2: heuristic — table-like (CSV/markdown table) */
  input_looks_like_table?: boolean;
  /** U2: heuristic — legal text excerpt */
  input_looks_like_legal_text?: boolean;
  /** U2: possible PII/sensitive data detected */
  contains_sensitive_data_possible?: boolean;
}

/** Gating: why LLM was or wasn't used */
export type GatingDecision =
  | 'rules_high_confidence'
  | 'llm_low_confidence'
  | 'llm_large_input'
  | 'llm_contract_like'
  | 'llm_table_like'
  | 'llm_legal_text_like'
  | 'llm_ambiguous'
  | 'llm_noise_clarification'
  | 'llm_fallback'
  | 'circuit_open'
  | 'rules_only_config';

export interface RulesConfidence {
  intent: number;
  domain: number;
  ambiguity: number;
  overall: number;
}

export interface QueryProfileMeta {
  classifier_mode: 'llm' | 'rules' | 'degraded';
  prompt_version?: number;
  model_id?: string;
  provider?: string;
  latency_ms?: number;
  retries?: number;
  warnings?: string[];
  input_truncated?: boolean;
  original_length?: number;
  effective_length?: number;
  /** Smart gating */
  gating_decision?: GatingDecision;
  rules_confidence?: RulesConfidence;
  llm_used_reason?: string[];
  /** U2 input source when query was overflowed to R2 */
  input_source?: 'db_query' | 'snapshot_preview' | 'r2_full';
  /** Where final ambiguity came from (rules override vs LLM) */
  ambiguity_source?: 'llm' | 'rules_soft' | 'rules_hard_override' | 'merged';
}

export interface QueryProfile {
  query_profile_version: number;
  intent: Intent;
  domain: LegalDomain;
  entities: ExtractedEntity[];
  ambiguity: AmbiguityResult;
  computed_flags: {
    has_direct_citation: boolean;
    profile_generation?: 'rules' | 'llm' | 'degraded';
  };
  routing_flags?: RoutingFlags;
  meta?: QueryProfileMeta;
  pipeline_step: string;
  updated_at: string;
}

export interface U2PipelineInput {
  query: string;
  tenant_id: string | null;
  user_id: string;
  locale?: string;
}

export interface U2PipelineContext extends U2PipelineInput {
  intent?: Intent;
  domain?: LegalDomain;
  entities?: ExtractedEntity[];
  ambiguity?: AmbiguityResult;
}
