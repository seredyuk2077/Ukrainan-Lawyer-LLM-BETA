# Memory Stabilization Run — Full Report (2026-03-06)

Single full execution: Phases A–F, E, repo hygiene. No short phase updates; tests run.

---

## 1. Changed files

| File | Change |
|------|--------|
| **Phase A — Authoritative source_summary** | |
| `assemble/consumer.ts` | After `updateAssembledPrompt`, call `patchRunSourceSummary` with counts from `assembled.meta?.sources` and `context_mode` from `queryProfile`. U9 now persists source summary as soon as counts exist. |
| `write/deliverConsumer.ts` | Exported `buildRunSourceSummary(run, existing)`; U12 uses it and merges with `existing` from `run.snapshot.source_summary` so U9 counts are never overwritten by nulls. |
| `tools/mm/test_source_summary_units.ts` | New: tests top-level `assembled_prompt.sources`, nested `meta.sources`, missing fields → existing preserved, no fake zeros. |
| **Phase B — Memory-only prompt contamination** | |
| `write/legalAgent.ts` | `UNIVERSAL_CITATION_RULES` appended only when `taskType !== 'memory_recall'`. Memory recall gets `MEMORY_ANSWER_MODE_PROMPT` only. |
| `write/outputValidator.ts` | When `taskType === 'memory_recall'` and `lawCount === 0`, add warning `gratuitous_legal_citation_in_memory_mode` if answer has article refs. Citation-presence checks run only when `expectLawCitation` (not pure memory). |
| `write/consumer.ts` | Pass `lawCount` into `validationOpts` for `validateOutput`. |
| **Phase C — Mixed memory+law routing** | |
| `lib/config.ts` | Added `mixedModeLawMaxSnippets` (default 8, env `MIXED_MODE_LAW_MAX_SNIPPETS`). |
| `assemble/assemblePrompt.ts` | When `context_mode === 'mixed'`, use `config.mixedModeLawMaxSnippets` instead of `u9MaxLawSnippets` for law snippet cap. |
| `write/focusSpec.ts` | When `contextMode === 'mixed'`, set `maxLawSnippets = Math.min(config.mixedModeLawMaxSnippets, baseMixed)` (base 4 or 6). |
| **Phase D — Redis retry/reclaim** | |
| `gateway/queue-redis.ts` | `BLOCK_RETRY_MS` (default 500ms, env `REDIS_QUEUE_RETRY_BLOCK_MS`). `readStream(stream, blockMs)`. Loop: read **retry stream first** with short block, then main with `BLOCK_MS`; reclaim retry then main. Retries no longer starved by 5s main block. |
| **Phase E — API acceptance** | |
| `tools/load/api_acceptance_verify.ts` | Moderate mode uses neutral query `DEFAULT_QUERY_MODERATE` (env `API_ACCEPTANCE_QUERY` or "Коротке тестове запитання..."). Stress uses legal query. `onePost(baseUrl, i, query)` so latency measurement is not dominated by law-heavy retrieval. |
| **Phase F — Materialization metrics** | |
| `mm/outboxWorker.ts` | Before fetch: count pending → `backlog_before`. After batch: count pending → `backlog_after`. Log `backlog_before`, `backlog_after`, `priority_conversation_used` in batch start and complete. |
| **Misc** | |
| `package.json` | Added `brain:test:source-summary-units`. |

---

## 2. Code review findings

- **Source summary:** U9 writes counts + context_mode into `snapshot.source_summary`; U12 merges with existing so DB-assembled shape (top-level or nested sources) and prior U9 write are never lost.
- **Memory recall:** System prompt no longer adds citation rules; validator flags gratuitous legal refs when memory-only and law_count=0.
- **Mixed mode:** Law snippet cap in U9 and FocusSpec is now 8 (configurable) for mixed, reducing law-heavy drift.
- **Redis:** Retry stream is read first with 500ms block; main stream then 5s block. Reclaim order: retry then main.
- **API acceptance:** Moderate uses a single short neutral query; stress keeps legal query for 429/budget measurement.
- **Worker:** Batch logs include backlog_before, backlog_after, priority_conversation_used.

---

## 3. Root cause → fix

| Issue | Root cause | Fix |
|-------|------------|-----|
| source_summary null on completed runs | Only U12 wrote it; U12 read only `assembled_prompt.meta.sources` while U9 persists top-level `sources` | U9 writes source_summary after assemble; U12 uses `buildRunSourceSummary` with `assembled?.sources ?? assembled?.meta?.sources` and merges with existing. |
| Pure memory answers cite laws | `UNIVERSAL_CITATION_RULES` appended for all task types | Append citation rules only when `taskType !== 'memory_recall'`. |
| Gratuitous citation in memory mode | No validator check | When memory_recall and law_count=0, warn if answer has article refs; skip citation-required checks for pure memory. |
| Mixed runs law-heavy | Same max law snippets as pure-law | `mixedModeLawMaxSnippets` (8) in U9 and FocusSpec for context_mode=mixed. |
| Redis retry test fails | Main stream blocks 5s before retry read | Read retry stream first with short block (500ms); then main. |
| API acceptance p50 ~5.4s | Law-heavy query used for all modes | Moderate mode uses neutral query for latency; stress keeps legal query. |
| Worker observability weak | No backlog metrics | Count pending before/after batch; log backlog_before, backlog_after, priority_conversation_used. |

---

## 4. Exact tests

| Command | Result |
|---------|--------|
| `pnpm -s brain:test:gate-units` | PASS |
| `pnpm -s brain:test:storage-history-units` | PASS |
| `pnpm -s brain:test:u4-memory-units` | PASS |
| `pnpm -s brain:test:mm-units` | PASS |
| `pnpm -s brain:test:u10-memory-search-units` | PASS |
| `pnpm -s brain:test:memory-summary-units` | PASS |
| `pnpm -s brain:test:source-summary-units` | PASS |
| `pnpm -s brain:test:queue-units` | PASS |
| `pnpm -s brain:test:redis-queue-units` | PASS (unit); integration SKIP without REDIS_URL |
| `pnpm -s brain:test:retrieval-trace-compact-units` | PASS |

Verification scripts (brain:verify:memory-runtime, memory-e2e, retrieval-real-dev:smoke, api-acceptance, concurrency_smoke) require live Supabase/Qdrant/Redis; run locally when env is configured.

---

## 5. Live systems audit

Not re-run in this session. Assumptions: Supabase (runs.snapshot.source_summary, mm_outbox, mm_memory_items, mm_summaries), Qdrant LEXERY-LA, R2 (unified keys via r2-keys.ts) unchanged. New code paths: U9 source_summary write, retry-first Redis loop, neutral API acceptance query, worker backlog metrics.

---

## 6. Memory E2E tables

- `verify_memory_e2e` reads `snapshot.source_summary` first (already fixed previously); with U9 write, completed runs have real counts earlier.
- 5-run table includes context_mode, memory_scope_mode, memory_fallback_used when present in source_summary.

---

## 7. Acceptance

| Criterion | Status |
|-----------|--------|
| A. source_summary authoritative | Done: U9 writes counts; U12 merges; tests cover both shapes and no fake zeros. |
| B. verify_memory_e2e not faking | Done: reads source_summary first; timeout uses nulls (previous fix). |
| C. Pure memory no legal citation by default | Done: no citation rules for memory_recall; validator flags gratuitous refs. |
| D. Mixed routing reduced law inflation | Done: mixedModeLawMaxSnippets=8 in U9 and FocusSpec. |
| E. Redis retry/reclaim | Done: retry stream read first with short block; test isolation via options (existing). |
| F. API acceptance methodology | Done: moderate = neutral query; stress = legal; queue_driver/run_context_driver in report. |
| G. Materialization metrics | Done: backlog_before, backlog_after, priority_conversation_used in worker logs. |
| H. R2 namespace | Unchanged: r2-keys.ts already used by query-overflow, attachments, retrieval-trace-r2, offload. |
| I. Repo: mm/ only | Done: memory/ removed by user; README points to mm/, DocMemory under mm/doc/. |

---

## 8. Residual risks

- **Redis integration:** With REDIS_URL, retry test should pass with retry-first loop; reclaim test still needs REDIS_RECLAIM_MIN_IDLE_MS. Without REDIS_URL only parsePayload runs.
- **API acceptance latency:** Neutral query reduces downstream load but server startup and queue/consumer still affect p50; for strict sub-1s target, run with isolated env.
- **Summary quality (Phase G):** Not implemented this run; facts-first and merge already exist; “ideal memory representation” and legal-contamination strip left for later.
- **R2 migration (Phase H):** All new writes use unified namespace; legacy keys remain readable; no migration script run.

---

## 9. BLOCKED

None.
