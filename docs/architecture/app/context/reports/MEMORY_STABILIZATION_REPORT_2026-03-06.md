# Memory Stabilization Run — Final Report (2026-03-06)

Full execution: Phases A, B, C, F, G, repo hygiene. No short phase updates; tests run.

---

## 1. Changed files

| File | Change |
|------|--------|
| **Phase A — Memory scope** | |
| `retrieval/memory-store.ts` | `MemoryScopeMode`, `conversationId`, `scopeMode` in params; mm_summaries + mm_memory_items filter by `conversation_id`; semantic primary + optional user-global fallback; trace fields: `scope_primary`, `scope_fallback_used`, `conversation_recent_count`, `conversation_semantic_count`, `global_*`, `fallback_conversation_ids`. |
| `mm/semanticSearch.ts` | `conversationId` param; Qdrant `must` filter includes `conversation_id` when set. |
| `write/memorySearch.ts` | Passes `conversationId` and `scopeMode` into `fetchRecentMemory`. |
| `retrieval/cache-rag.ts` | `RunCacheRagInput.conversation_id`; `fetchMemoryForRun` takes `conversation_id`, passes to `fetchRecentMemory` with `scopeMode`; `memoryTrace` extended with scope fields. |
| `retrieval/consumer.ts` | Passes `run.conversation_id` into `runCacheRag`. |
| `lib/pipeline/contracts.ts` | `memory_trace` extended with scope fields. |
| `tools/u4/test_u4_memory_propagation_units.ts` | `testConversationScopePrimary`: inject stub receives `conversationId`, result has `scope_primary === 'conversation'`. |
| **Phase B — Verifier + source summary** | |
| `tools/mm/verify_memory_e2e.ts` | Timeout branch: `historyCount`/`memoryCount`/`lawCount` set to `null` (no fake 0); reads `snapshot.source_summary` first, then `assembled_prompt.meta.sources`; 5-run table includes `memory_scope_mode`; row type has optional `memory_scope_mode`, `memory_fallback_used`. |
| `gateway/storage.ts` | `RunSourceSummary` type; `patchRunSourceSummary(runId, summary)`; `completeRun` unchanged. |
| `write/deliverConsumer.ts` | Before `completeRun`: build `RunSourceSummary` from run (assembled_prompt, query_profile, llm_result, retrieval_trace.meta.memory), call `patchRunSourceSummary`. |
| **Phase F — Redis test isolation** | |
| `gateway/queue-redis.ts` | `RedisQueueOptions`: optional `streamMain`, `streamRetry`, `streamDlq`, `groupName`; class uses instance stream/group names; production unchanged when options omitted. |
| `tools/gateway/test_redis_queue_units.ts` | Unique namespace `TEST_NS = lexery:test:${Date.now()}` (or `REDIS_TEST_NAMESPACE`); `testQueueOptions()`; all integration tests use it; reclaim test creates STREAM_RETRY group. |
| **Phase G — API acceptance** | |
| `tools/load/api_acceptance_verify.ts` | Mode `moderate` (default) vs `stress`; N=10 moderate / N=20 stress; report: `accepted_202`, `throttled_429`, `queue_driver`, `run_context_driver` (env `QUEUE_DRIVER`, `RUN_CONTEXT_DRIVER`); 429 not treated as acceptance failure; non-JSON response handled. |
| **Repo hygiene** | |
| `scripts/lexery-legal-agent/memory/README.md` | Added: deprecated, use `../mm/`, DocMemory in `../mm/doc/`. |
| `scripts/lexery-legal-agent/mm/doc/*` | MM Docs implementation now lives under `mm/doc/`; architecture docs are the source of truth, no local README. |

---

## 2. Code review findings

- **Memory scope:** Primary path is conversation-scoped (recent, summary, semantic). User-global fallback only when `scopeMode` is `user_global_fallback` or `mixed_scope` and bounded; trace distinguishes `scope_primary` and `scope_fallback_used`.
- **Verifier:** Timeout no longer injects 0; `source_summary` is written in U12 and read first in verify_memory_e2e; acceptance fails when metrics unavailable.
- **Redis tests:** With `REDIS_URL`, tests use isolated stream/group names; production streams unchanged. Without `REDIS_URL`, only parsePayload runs.
- **API acceptance:** Correct env keys (`QUEUE_DRIVER`, `RUN_CONTEXT_DRIVER`); 429 reported separately; moderate mode uses smaller N by default.

---

## 3. Root cause → fix

| Issue | Root cause | Fix |
|-------|------------|-----|
| Memory user-global mixing conversations | No `conversation_id` filter in recent/summary/semantic | `conversationId` and `scopeMode` end-to-end; primary filter by `conversation_id`; optional bounded fallback; trace fields. |
| verify_memory_e2e timeout fake success | Timeout branch set counts to 0 | Timeout branch sets `historyCount`/`memoryCount`/`lawCount` to `null`; acceptance requires `metrics_available`. |
| No authoritative run source counts | Counts only in assembled_prompt/llm_result, not durable | U12 `patchRunSourceSummary` writes `snapshot.source_summary`; verifier reads it first. |
| Redis tests share prod streams | Hardcoded stream/group names | `RedisQueue` accepts optional stream/group options; tests use `lexery:test:${Date.now()}` namespace. |
| API acceptance wrong env / 429 = fail | LEXERY_QUEUE and 429 conflated with latency | Report `queue_driver`/`run_context_driver` from `QUEUE_DRIVER`/`RUN_CONTEXT_DRIVER`; `throttled_429` separate; moderate N=10. |
| Duplicate memory folder | Empty `memory/` next to `mm/` | Deprecated `memory/` with README; `mm/doc/` placeholder for DocMemory. |

---

## 4. Exact tests

| Command | Result |
|---------|--------|
| `pnpm -s brain:test:gate-units` | PASS |
| `pnpm -s brain:test:storage-history-units` | PASS |
| `pnpm -s brain:test:u4-memory-units` | PASS (includes conversation scope test) |
| `pnpm -s brain:test:mm-units` | PASS |
| `pnpm -s brain:test:u10-memory-search-units` | PASS |
| `pnpm -s brain:test:memory-summary-units` | PASS |
| `pnpm -s brain:test:queue-units` | PASS |
| `pnpm -s brain:test:redis-queue-units` | PASS (unit); integration SKIP without REDIS_URL |
| `pnpm -s brain:test:retrieval-trace-compact-units` | PASS |
| `pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/test_semantic_bootstrap_units.ts` | PASS |

Verification scripts (brain:verify:memory-runtime, brain:verify:memory-e2e, brain:verify:retrieval-real-dev:smoke, concurrency_smoke, brain:verify:api-acceptance) require live Supabase/Qdrant and optional Redis; run locally when env is configured.

---

## 5. Live systems audit

Not re-run in this session. Assumptions: Supabase (mm_*, runs), Qdrant (conversation_id in payload), R2 (existing r2-keys usage) unchanged. New code paths: conversation-scoped memory, source_summary in snapshot.

---

## 6. Memory E2E tables

- Timeout rows no longer use 0; they use `null` and contribute to `metrics_available === false` → script exits 1.
- 5-run table includes `memory_scope_mode` when `source_summary` is present.
- Authoritative counts come from `snapshot.source_summary` when available.

---

## 7. Acceptance

| Criterion | Status |
|-----------|--------|
| A. Memory scope | Done: conversation-first; fallback explicit and traced. |
| B. Honest verification | Done: no timeout zeros; source_summary persisted and read first. |
| C. U2 mixed | Unchanged (already strict schema + 400 log + json_object fallback). |
| D. Materialization | Not changed this run (existing wake-up + 5s poll). |
| E. Summary | Not changed this run (existing facts-first path). |
| F. Redis durability | Done: test namespace isolation; reclaim test when REDIS_URL + REDIS_RECLAIM_MIN_IDLE_MS. |
| G. API acceptance | Done: QUEUE_DRIVER/RUN_CONTEXT_DRIVER, 429 separate, moderate/stress. |
| H. R2 namespace | Unchanged (r2-keys already in use). |
| Repo hygiene | Done: memory/ deprecated, mm/doc placeholder. |

---

## 8. Residual risks

- **source_summary:** Written in U12 only after deliver; runs that never reach U12 (e.g. failed earlier) will not have it; verifier falls back to assembled_prompt.meta.sources.
- **Redis integration:** With REDIS_URL, retry/reclaim tests use isolated streams; without REDIS_URL no integration proof.
- **429:** Under stress, 429 may still occur; script reports it and does not treat it as acceptance failure in moderate mode.

---

## 9. BLOCKED

None.
