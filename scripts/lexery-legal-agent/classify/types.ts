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
  | 'health'
  | 'corporate'
  | 'education'
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
  /** Legacy code retained for backward compatibility; no longer emitted by detector. */
  | 'AMBIG_TERM_MATCH'
  | 'TOO_SHORT_QUERY'
  | 'NO_ENTITIES_GENERIC_TOPIC'
  | 'GENERAL_DOMAIN_NO_DIRECT_REF';

export interface AmbiguityResult {
  is_ambiguous: boolean;
  reasons: string[];
  ambig_terms?: string[];
  /** When from rules: "hard" = override LLM for clearly underspecified short query; "soft" = merge/OR */
  strength?: 'hard' | 'soft';
  /** Canonical reason codes for audit. */
  reason_codes?: AmbiguityReasonCode[];
}

/** U2 LLM: which context to use. law = legislation; memory = conversation/history; mixed = both. */
export type ContextMode = 'law' | 'memory' | 'mixed';

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
  /** U2 LLM: context_mode — law (legislation), memory (conversation/history), mixed (both). */
  context_mode?: ContextMode;
}

/** Gating: why LLM was or wasn't used */
export type GatingDecision =
  | 'rules_high_confidence'
  | 'rules_docs_only_scope'
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
  /** U2 domain source (heuristic vs AI) for audit */
  u2_domain?: { primary: string; secondary?: string; confidence?: number; source: 'heuristic' | 'ai' };
  /** U2 AI domain classifier (Phase 6) */
  u2_ai_domain?: {
    called: boolean;
    used: boolean;
    not_used_reason?: string;
    attempts?: number;
    parse_mode?: string;
  };
  /** U2 AI routing v2 (categories + document_types from LLDBI vocabulary) */
  u2_ai_routing?: {
    called: boolean;
    used: boolean;
    categories_top3?: string[];
    document_types_top3?: string[];
    confidence?: number;
    parse_mode?: string;
    not_used_reason?: string;
  };
  /** U2 lldbi hints (derived from vocabulary або AI), for audit. */
  u2_lldbi_hints?: {
    derived: boolean;
    reasons: string[];
  };
  /** LLDBI vocabulary snapshot used for lldbi hints (for MCP audit + forward-compat). */
  lldbi_vocabulary_source?: 'supabase' | 'stub';
  lldbi_vocabulary_fetched_at?: string;
  lldbi_vocab_stats?: {
    totalDocs: number;
    distinctCategories: number;
    distinctDocumentTypes: number;
  };
}

export interface QueryProfile {
  query_profile_version: number;
  intent: Intent;
  domain: LegalDomain;
  /** Taxonomy family key for U4 (when set by AI domain or heuristic mapping). */
  domainHint?: string;
  domain_confidence?: number;
  domain_candidates_top2?: string[];
  /** LLDBI routing hints (categories + document_types from vocabulary; U2 AI or heuristic). */
  lldbi?: {
    categories_ranked_top3: string[];
    document_types_ranked_top3: string[];
    routing_confidence: number;
    routing_source: 'heuristic' | 'ai' | 'mixed';
  };
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
