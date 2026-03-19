/**
 * Pipeline contracts: U4 → U5 → U9 → U10/U12 (LEX-130)
 *
 * Cross-U-block types live in this module. No new top-level `online/` folder.
 * RunContext is built early (U1/U2) and enriched by U4 (MM Search/Load); U5/U9/U10 only read it.
 */

// --- Prompt Stack (multi-level system prompts, DEV RUN v8) ---

/**
 * Multi-level system prompt stack for U10.
 * Levels (priority, global first):
 *   global  → always present (service-level evidence-only safety policy)
 *   project → optional (folder/project context from product backend)
 *   chat    → optional (specific chat/session context)
 *   user    → optional ("additional user instructions", never overrides global safety)
 *
 * Stored in runs.snapshot.prompt_stack and in RunContext.
 * Accepted via POST /v1/runs body.client_context.prompt_stack.
 * DB columns in chat_sessions are not yet present; snapshot is the source of truth.
 */
export interface PromptStack {
  /** Service-level prompt override (normally auto-injected by U10; can be customised per tenant). */
  global?: string;
  /** Project/folder-level system prompt (optional; set by product backend for a project). */
  project?: string;
  /** Chat-level system prompt (optional; set per conversation). */
  chat?: string;
  /** User-supplied additional constraints (optional; appended last, no safety override). */
  user?: string;
}
import type { RawHit, RetrievalTrace, DegradedSources } from '../../retrieval/types.js';
import type { GateDecision, GateDecisionReasonCode } from '../../gate/types.js';
import type { QueryProfile } from '../../classify/types.js';
import type { SearchPlan } from '../../plan/types.js';
import type { MemoryRef } from '../../assemble/types.js';

// Re-export for consumers that want a single import
export type { GateDecision, GateDecisionReasonCode } from '../../gate/types.js';
export type { RawHit, RetrievalTrace, DegradedSources } from '../../retrieval/types.js';
export type { MemoryRef } from '../../assemble/types.js';

/** Normalized U4 output: raw hits + retrieval trace. Used by U5 and U9. */
export interface U4Result {
  rawHits: RawHit[];
  retrievalTrace: RetrievalTrace;
  /** Convenience: degraded_sources from trace. */
  degradedSources?: DegradedSources;
}

/**
 * RunContext — in-memory context for a run (U1/U2 build, U4 enriches memory, U5/U9/U10 read).
 * Stored in RunContextStore; not all fields present at every step.
 */
export interface RunContext {
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  conversation_id?: string | null;
  project_id?: string | null;
  /** User query (from request or snapshot). */
  user_input?: string;
  /** Pre-loaded chat history from supabase-lexery-legal-agent-db.messages (by conversation_id). */
  history?: Array<{ role: string; content: string }>;
  /** Memory items (MM Search/Load, filled inside U4). */
  memory_items?: MemoryRef[];
  /** Memory summaries (MM Load). */
  memory_summaries?: Array<{ scope?: string; summary_text: string }>;
  /** MM Docs retrieved snippets (filled before U9 assemble when docs are enabled). */
  doc_snippets?: DocSnippetRef[];
  /** MM Docs retrieval/ingest meta for forensics. */
  doc_trace?: {
    enabled?: boolean;
    requested_scope?: 'conversation' | 'project' | 'user_global' | null;
    ingested_count?: number;
    retrieved_count?: number;
    latency_ms?: number;
    warnings?: string[];
  };
  /** Meta for memory fetch (degraded, latency, counts, scope). */
  memory_trace?: {
    degraded?: boolean;
    recent_count?: number;
    semantic_count?: number;
    latency_ms?: number;
    sources_used?: string[];
    reason_codes?: string[];
    scope_primary?: 'conversation' | 'user_global';
    scope_fallback_used?: boolean;
    conversation_recent_count?: number;
    conversation_semantic_count?: number;
    global_recent_count?: number;
    global_semantic_count?: number;
    fallback_conversation_ids?: string[];
  };
  query_profile?: QueryProfile | null;
  search_plan?: SearchPlan | null;
  retrieval_trace?: RetrievalTrace | null;
  raw_hits?: RawHit[];
  gate_decision?: GateDecision | null;
  /**
   * Multi-level prompt stack for U10 (DEV RUN v8).
   * Sourced from runs.snapshot.prompt_stack or client_context.prompt_stack.
   * U10 merges this into the system prompt: global → project → chat → user.
   */
  prompt_stack?: PromptStack;
}

/**
 * Gate input: RunContext + U4Result. U5 evaluates only on these (no direct DB).
 */
export interface GateInput {
  runContext: RunContext;
  u4: U4Result;
}

/**
 * Derived gate status for API/docs: "ok" = proceed to U9; "rag_missing" = not enough evidence (stub path).
 */
export type GateStatus = 'ok' | 'rag_missing';

/**
 * Maps GateDecision to a single status for downstream (U9/stub). LEX-131.
 * expand === false → ok; expand === true → rag_missing.
 */
export function gateStatus(decision: GateDecision): GateStatus {
  return decision.expand ? 'rag_missing' : 'ok';
}

/** Reason codes that imply rag_missing (for logging/metrics). */
export const RAG_MISSING_REASON_CODES: GateDecisionReasonCode[] = [
  'FEW_HITS',
  'LOW_SCORE',
  'DIRECT_REF_MISSING',
  'DEGRADED_LLDBI',
  'AMBIGUOUS_QUERY',
  'NEED_DEEP_RETRIEVAL',
  'WEAK_EVIDENCE',
  'LIKELY_MISSING_ACT',
  'OUT_OF_SCOPE_QUERY',
];

// --- U9/U10 contracts (LEX-130, LEX-132) ---

export type EvidenceSourceType = 'law' | 'memory' | 'history' | 'doc';

export interface EvidenceItem {
  sourceType: EvidenceSourceType;
  sourceIds: string[];
  text: string;
  meta?: { rada_nreg?: string; article_number?: string | null; score?: number; scope?: string };
}

/**
 * Extracted norm reference from snippet text (U9 focus / U10 triage).
 * Used for focus spec and lawIndex; leave null when extraction is uncertain.
 */
export interface NormRef {
  actTitle?: string;
  actNumber?: string;
  articleNumber?: number | null;
  partNumber?: string | null;
  heading?: string | null;
  keywords?: string[];
}

/** Provenance reference for a law snippet (from RawHit). */
export interface LawSourceRef {
  r2_key: string;
  json_path: string;
  score: number;
  /** Retrieval rank after dedup+sort (lower is higher retrieval score). */
  rank: number;
  /** Order in which U9 selected/loaded the chunk (independent from retrieval rank). */
  selected_order?: number;
  rada_nreg?: string;
  article_number?: string | null;
  act_title?: string;
  goal_id?: string;
  loaded: boolean;
  /** Extracted from snippet text for focus/triage (DEV RUN v14). */
  normRef?: NormRef | null;
}

/** Provenance reference for a memory item or summary. */
export interface MemorySourceRef {
  id?: string;
  scope?: string;
  scope_type?: string;
}

export interface DocSourceRef {
  doc_id?: string;
  r2_key?: string;
  json_path?: string;
  scope_type?: string;
  scope_id?: string;
  filename?: string;
  title?: string;
  score?: number;
}

export interface DocSnippetRef {
  doc_id: string;
  text: string;
  score: number;
  r2_key: string;
  json_path: string;
  scope_type?: string;
  scope_id?: string | null;
  filename?: string;
  title?: string;
}

/** Provenance reference for history entry. */
export interface HistorySourceRef {
  index: number;
  role: string;
}

export type SourceRef = LawSourceRef | MemorySourceRef | HistorySourceRef | DocSourceRef;

export interface ContextPart {
  type: EvidenceSourceType;
  text: string;
  /** Legacy: flat array of string ids. Kept for backward compat. */
  sourceIds: string[];
  /** Rich provenance (populated by U9 ideal implementation). */
  sourceRef?: SourceRef;
}

export interface AssembledPromptBudget {
  tokenEstimateTotal: number;
  tokenEstimateByChannel: { law: number; memory: number; history: number; doc?: number };
  truncated: boolean;
  droppedChannels: EvidenceSourceType[];
}

export interface AssembledPrompt {
  systemPrompt: string;
  userPrompt: string;
  contextParts: ContextPart[];
  meta?: {
    tokenEstimate?: number;
    sourcesSummary?: string;
    assembledAt?: string;
    /** Full token budget accounting (U9 ideal). */
    budget?: AssembledPromptBudget;
    /** Number of law snippets that failed to load from R2. */
    loadErrorsCount?: number;
    /** True when at least one law snippet is missing. */
    degraded?: boolean;
    /** Per-channel counts. */
    sources?: { lawCount: number; memoryCount: number; historyCount: number; docCount?: number };
    /** Law sourceRefs (compact; for DB persistence and crash recovery). */
    lawSourceRefs?: LawSourceRef[];
    /** sourceId -> normRef summary for U10 focus/triage (DEV RUN v14). */
    lawIndex?: Record<string, { articleNumber?: number; heading?: string; actTitle?: string }>;
    /** U9 metadata pre-triage result (DEV RUN v16). */
    u9MetaTriage?: {
      skipped: boolean;
      /** Meta-triage LLM selected count (indices from triage). */
      selected_count: number;
      /** Final U9 selection count (after multi-signal, for R2). */
      final_selected_count?: number;
      total_hits: number;
      model?: string;
      latency_ms: number;
      parse_ok?: boolean;
      fallback_used?: boolean;
      fallback_mode?: string;
      reason_code?: string | null;
      finish_reason?: string | null;
      raw_content_type?: string | null;
      reasoning_tokens?: number | null;
      triage_attempts?: number;
      triage_model_chain?: string[];
      triage_attempt_trail?: Array<{
        attempt_no: number;
        model_id: string;
        finish_reason?: string | null;
        raw_content_type?: string | null;
        reasoning_tokens?: number | null;
        token_budget?: number | null;
        /** Optional OpenRouter error code when attempt failed/retired. */
        error_code?: string | null;
        outcome: string;
      }>;
      /** Phase 2.1: explainability (no full text). */
      candidate_count?: number;
      selected_indices?: number[];
      score_breakdown?: Array<{
        index: number;
        retrieval: number;
        model: number;
        queryNum: number;
        lexical: number;
        novelty: number;
        /** Source redundancy penalty (same family already selected). */
        redundancy_penalty?: number;
        /** Structural legalness bonus (article_number + heading richness). */
        structural_bonus?: number;
      }>;
      rejected_top_candidates?: Array<{ index: number; reason: string }>;
    };
  };
}

export interface LegalAgentResult {
  answerText: string;
  model: string;
  latencyMs: number;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  warnings?: string[];
  citations?: Array<{ act?: string; article?: string; text?: string }>;
  usedSources?: string[];
  /** PHASE 2: compact repair applied when suggestCompact/article_sprawl */
  compact_repair_applied?: boolean;
  compact_repair_success?: boolean;
  article_refs_before?: number;
  article_refs_after?: number;
}

/** U11 Verify scaffold: verdict + reasons + optional metrics (LEX-133 follow-up). */
export interface VerifyResult {
  verdict: 'complete' | 'retry' | 'failed';
  reasons?: string[];
  metrics?: { coverageScore?: number };
}

/** Prompt Composer output: structured instruction appendix for main agent. No new facts. */
export interface ComposedInstructionPack {
  task_summary?: string;
  answer_requirements?: string[];
  legal_reasoning_steps?: string;
  output_format?: string;
}

export type { EvidencePack } from '../../assemble/types.js';
