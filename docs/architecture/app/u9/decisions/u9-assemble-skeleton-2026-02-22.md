# ADR: U9 Assemble skeleton (LEX-132)

**Date:** 2026-02-22  
**Status:** Accepted

## Context

U9 Assemble збирає промпт для U10 Legal Agent: system + user + context (law, memory, history). Full design may include token budgeting, advanced prompt templates, and refinement. This run implements the skeleton only.

## Decision

1. **Skeleton implementation**
   - Single public function: `assemblePrompt({ runContext, u4, gate })` → AssembledPrompt.
   - Law: top-N rawHits (default 20), each loaded via getFragmentFromR2; on failure or missing config use placeholder text.
   - Memory: RunContext.memory_items (content_preview) + memory_summaries (summary_text). No direct DB or MM Search — only data already in RunContext.
   - History: last K messages (default 10) from RunContext.history.
   - Output: systemPrompt (evidence-only instruction), userPrompt (user_input), contextParts with type law | memory | history.

2. **Integration**
   - U9 consumer (handleU9Event) loads RunContext, builds U4Result/GateDecision, calls assemblePrompt, stores assembled_prompt in RunContext, enqueues U10. U10 is currently a stub (log only).

3. **Not in scope**
   - Token budgeting, context truncation heuristics, advanced prompt engineering. These are follow-up (e.g. LEX-133).

## Consequences

- U4 → U5 → U9 → U10 chain is wired; AssembledPrompt is available for U10 when implemented.
- Unit tests (brain:test:u9-units) cover law/memory/history presence in contextParts.
