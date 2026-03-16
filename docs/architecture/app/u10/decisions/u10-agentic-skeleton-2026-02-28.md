# ADR: U10 Agentic Skeleton — Evidence Policy + Memory + Composer (DEV RUN v8)

**Date:** 2026-02-28
**Status:** Accepted
**Task:** LEX-133, LEX-134

## Context

U10 skeleton (v2) мав базову структуру. Для "реального агента" потрібні:
1. Evidence insufficient policy (не вигадувати норм).
2. Structured context sections (law/memory/history чітко розділені).
3. Memory readiness (безпечна деградація + metrics).
4. Composer 2.0 (latency tracking + skip when insufficient).
5. Context truncation awareness.

## Decisions

### 1. Evidence Insufficient Policy
`isEvidenceInsufficient(assembled, runContext): boolean`
- Triggers: `lawCount=0` OR `(degraded && loadErrorsCount > 0)` OR `gate.expand=true`
- Action: prepend `EVIDENCE_INSUFFICIENT_PREFIX` to system prompt; `warnings: ['evidence_insufficient']`
- Composer: SKIPPED when evidence insufficient (budget saving)
- Future hook: this is where "retry RAG" or "doclist fallback" would be triggered (not activated yet)

### 2. Structured Context Sections
`buildMessagesFromAssembled` creates labeled sections:
```
=== LAW EVIDENCE ===   (law parts)
=== MEMORY CONTEXT === (memory parts)
=== CHAT HISTORY ===   (history parts)
```
Agent sees explicit channel boundaries; no ambiguity between "what is law" and "what is user memory".

### 3. Memory Readiness
- Memory is a passive channel: if present → logged + passed to LLM in its own section
- If `memory_trace.degraded=true` → `logger.warn('U10 memory degraded')` but pipeline continues
- No Qdrant calls from U10 (memory already filled in U4/RunContext)

### 4. Composer 2.0
- Returns `{ appendix, modelUsed, latencyMs }`
- Logged: `composer_used`, `composer_model`, `composer_latency_ms`
- Skipped when `evidence_insufficient=true`
- Max tokens remains small (512); system prompt explicitly says "No legal facts"

### 5. Context Truncation Warning
If `assembled.meta.budget.truncated=true` → append warning to system:
`⚠️ NOTE: The legal context was truncated due to token budget limits. Some law snippets may be missing.`

## Future Hooks (decision skeleton, not activated)
- Retry RAG: when `evidence_insufficient=true`, future U10 could trigger retry to U4.
- Tool calls: DocList/web lookup — hooks in `isEvidenceInsufficient` path.
- Multi-turn: U10 could request clarification if query ambiguous.

## Acceptance
- `pnpm brain:test:u10-units` → 13/13 PASS
- `pnpm brain:verify:u5` → PASS (U10 disabled; pipeline stable)
- MCP: `run_id=bb6ac403`, `llm_model="anthropic/claude-3.7-sonnet:thinking"`, status=completed
