# U10 Internal Tools (DEV RUN v12)

**Status:** Skeleton for agentic tool-calling; Memory Search is the first internal tool.  
**Date:** 2026-02-28  

---

## Memory Search Tool (internal)

**Module:** `write/memorySearch.ts`  
**Export:** `searchMemoryTool()`, `formatMemorySearchSection()`

### When it is used

- **evidence_insufficient** — when law evidence is missing or degraded, U10 calls the memory search tool and appends the result to the user message so the LLM can still use profile/preference/case memory.
- Future: can be triggered when the user asks explicitly about profile (“як мене звати?”, “мої вподобання”) once intent detection is wired.

### Contract

**Input:**

| Param | Type | Description |
|-------|------|-------------|
| `tenant_id` | string \| null | Tenant scope |
| `conversation_id` | string \| null | Conversation scope |
| `user_id` | string | Required for multi-tenant isolation |
| `queryText` | string | Query for semantic search (e.g. user input) |
| `limit` | number | Max facts to return (default 8) |
| `runId` | string | For tracing |
| `stubForDryRun` | boolean | When true, returns fast deterministic stub (no real fetch) |

**Output:** `MemorySearchResult`

- `summaries: string[]` — summary text(s) from `mm_summaries`
- `facts: string[]` — top facts (content_preview or loaded from R2)
- `trace`: `{ latency_ms, qdrant_used, supabase_latency_ms?, qdrant_latency_ms?, offload_loaded_count?, degraded? }`

### Integration in U10

- Consumer (`write/consumer.ts`): when `evidenceInsufficient === true`, calls `searchMemoryTool()` with `stubForDryRun: config.legalAgentDisableLlm`, then `formatMemorySearchSection(result)` and appends to `assembledForAgent.userPrompt`.
- Section header: `=== MEMORY SEARCH RESULTS ===` followed by Summaries and Facts.

### Dry_run / tests

- With `LEGAL_AGENT_DISABLE_LLM=true`, `stubForDryRun: true` → no real fetch; returns stub message. Unit tests: `pnpm brain:test:u10-memory-search-units`.
