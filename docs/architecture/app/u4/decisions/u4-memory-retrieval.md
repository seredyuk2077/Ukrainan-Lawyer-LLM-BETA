# ADR U4-MEM: Memory Retrieval in U4 CacheRAG

**Status:** Implemented (Phase 1 — Recent Memory only)  
**Date:** 2026-02-17  
**Scope:** scripts/lexery-legal-agent/retrieval/memory-store.ts, cache-rag.ts  

---

## Context

Architecture (MEGA_DIAGRAM_FULL.md, answer.md) specifies that U4 CacheRAG must fetch both:
- **Supabase Memory** (`mm_memory_items`, `mm_summaries`) — recent user-scoped memory
- **Qdrant Memory** (`lexery_memory_semantic_v1`) — semantic similarity search (optional)

U4 output must include `MemoryRefs[]` for downstream U9 Assemble to inject into the writer's context.

**Pre-conditions found:**
- `mm_memory_items`, `mm_summaries`, `mm_outbox` tables **exist** in the same Supabase project as `runs`.
- All tables are currently **empty** (0 rows) — write pipeline (U12 → MM_OUTBOX → MM_ITEMS) is not yet implemented.
- A separate Qdrant memory cluster (`QDRANT_MEMORY_*`) is **not yet provisioned**.
- `MemoryRef` type already exists in `assemble/types.ts`.
- `DegradedSourcesSchema.memory` already exists in `retrieval/types.ts`.

---

## Decision

### Phase 1 (implemented): Recent Supabase memory

Implement `fetchRecentMemory` from `mm_memory_items`:
- Query: `SELECT ... FROM mm_memory_items WHERE user_id=X AND tenant_id=Y ORDER BY created_at DESC LIMIT N`
- Timeout: 1500ms (configurable `MEMORY_RECENT_TIMEOUT_MS`)
- Non-fatal: failure → `degraded_sources.memory=true`, empty refs, pipeline continues
- Multi-tenant safe: **always** filter by both `tenant_id` AND `user_id`
- No PII in logs: only counts and latencies are logged
- Empty result (0 rows) is valid — not a degradation

### Phase 2 (not yet implemented): Qdrant semantic memory

Will use `lexery_memory_semantic_v1` collection when:
1. `MEMORY_SEMANTIC_ENABLED=true`
2. `QDRANT_MEMORY_URL` is configured
3. Qdrant memory cluster is provisioned with correct payload filters (`tenant_id`, `user_id`)

Gated by `config.memorySemanticEnabled` (default: `false`).

---

## Configuration (new env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `MEMORY_RECENT_ENABLED` | `true` | Disable with `=false` |
| `MEMORY_RECENT_LIMIT` | `5` | Max items per run |
| `MEMORY_RECENT_TIMEOUT_MS` | `1500` | AbortController timeout |
| `MEMORY_SEMANTIC_ENABLED` | `false` | Requires Qdrant memory cluster |
| `QDRANT_MEMORY_URL` | `` | Qdrant memory cluster endpoint |
| `QDRANT_MEMORY_API_KEY` | `` | Qdrant memory cluster API key |
| `MEMORY_QDRANT_COLLECTION` | `lexery_memory_semantic_v1` | Collection name |
| `MEMORY_TOP_K` | `8` | Semantic search top-K |
| `MEMORY_SEMANTIC_TIMEOUT_MS` | `3000` | Semantic search timeout |

---

## Failure Policy

| Scenario | Behavior |
|----------|----------|
| Supabase not configured | Skip silently, `degraded=false` (no penalty — config missing is expected) |
| Query error (DB error) | `degraded=true`, `reason_codes: [SUPABASE_QUERY_ERROR]`, empty refs |
| Timeout (AbortController) | `degraded=true`, `reason_codes: [TIMEOUT]`, empty refs |
| 0 rows found | Empty refs, `degraded=false` — normal state before U12 is implemented |
| Qdrant unavailable (if enabled) | `degraded=true`, `reason_codes: [QDRANT_UNAVAILABLE]`, fall back to Supabase-only |

Pipeline **always continues** regardless of memory failure.

---

## Trace / Observability

`retrieval_trace.meta.memory`:
```json
{
  "enabled": true,
  "semantic_enabled": false,
  "recent_count": 0,
  "semantic_count": 0,
  "degraded": false,
  "latency_ms": { "recent": 42 },
  "sources_used": []
}
```

Metrics added to `gateway/observability.ts`:
- `u4_memory_recent_count_total` — total memory items fetched
- `u4_memory_degraded_total` — runs where memory fetch failed
- `u4_memory_latency_ms_total` / `_count` — for p50/p95 computation

---

## Multi-tenant Safety

- `mm_memory_items` has RLS enabled (confirmed in Supabase).
- Service role key bypasses RLS — therefore code **must** always pass `user_id` AND `tenant_id` as explicit WHERE filters.
- If `user_id` is empty: skip fetch entirely (no query issued).
- Cross-user mixing: **impossible** by design — both filters are always applied.

---

## Integration Point in cache-rag.ts

Memory fetch runs **after** all LLDBI retrieval, before `retrievalTrace` construction:
- Doesn't block or delay critical path retrieval
- Memory refs attached to `RunCacheRagResult.memoryRefs`
- Downstream U9 Assemble can consume `memoryRefs` to inject into writer context

---

## Known Limitations (Phase 1)

1. `mm_memory_items` is empty until U12 Deliver + MM_OUTBOX write pipeline is implemented.
2. `mm_summaries` not yet fetched (can be added in Phase 2 alongside semantic).
3. No Qdrant semantic search until separate memory cluster is provisioned.
4. `memoryRefs` from U4 are not yet passed to U9 Assemble (U9 not implemented yet).

---

## Next Steps

- Implement U12 Deliver + MM_OUTBOX worker to populate `mm_memory_items`
- Provision Qdrant memory cluster (`lexery_memory_semantic_v1`) with tenant/user payload filters
- Enable semantic search via `MEMORY_SEMANTIC_ENABLED=true`
- Connect `memoryRefs` in U9 Assemble context builder
