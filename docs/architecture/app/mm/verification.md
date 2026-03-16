# MM Verification Runbook

**Status:** production verification runbook for `MM memory` and `MM Docs` on the shared Lexery-LA stack.  
**Last validated:** 2026-03-16

This document is the operational source for proving that:

- chat memory stays isolated by tenant/user/conversation
- MM Docs stays isolated by tenant/user/scope
- workers/materialization stay healthy under parallel load
- Supabase/R2/Qdrant storage stays bounded and production-safe
- long-chat recall still works after summarization/compression

## Production topology

- Supabase: shared Lexery Legal Agent DB
- R2 bucket: `lexery-legal-agent`
- Qdrant cluster: shared Lexery-LA cluster
- MM memory collection: `lexery_memory_semantic_v1`
- MM Docs collection: `lexery_mm_docs_chunks_v1`

Shared-cluster Qdrant is an accepted production topology for MM/MM Docs as long as collection separation and payload filtering remain intact.

## Core commands

### MM memory

```bash
pnpm -s brain:test:mm-units
pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/test_outbox_units.ts
pnpm -s brain:verify:memory-runtime
MEMORY_SEMANTIC_ENABLED=true pnpm -s brain:verify:memory-runtime
pnpm -s brain:verify:memory-e2e
MM_OUTBOX_WORKER_ENABLED=true MM_OUTBOX_POLL_INTERVAL_MS=5000 pnpm -s brain:verify:memory-e2e
MM_OUTBOX_WORKER_ENABLED=true pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_long_conversation.ts
MM_OUTBOX_WORKER_ENABLED=true pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_parallel_stress.ts
pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_isolation_real.ts
```

### MM Docs

```bash
pnpm -s brain:test:mm-doc-units
pnpm -s brain:verify:mm-doc-readiness
MM_DOCS_VERIFY_ALLOW_FALLBACK=true pnpm -s brain:verify:mm-doc-live
MM_DOCS_VERIFY_ALLOW_FALLBACK=true pnpm -s brain:verify:mm-doc-pipeline-live
pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm-doc/verify_mm_docs_large_context_stress.ts
```

### Shared infrastructure

```bash
pnpm -s brain:db:capabilities
pnpm -s exec tsx scripts/lexery-legal-agent/tools/r2/r2_capabilities_check.ts
pnpm -s brain:verify:api-acceptance
pnpm -s exec tsx scripts/lexery-legal-agent/tools/load/concurrency_smoke.ts
pnpm -s exec tsx scripts/lexery-legal-agent/tools/mm/check_lexery_db_rollout_path.ts
```

## What a green state looks like

### MM memory

- `brain:verify:memory-runtime`
  - `pending=0`
  - `processing=0`
  - `failed=0`
  - `stale_processing_count=0`
- worker `memory-e2e`
  - `outbox_done_count=5`
  - `outbox_expected_count=5`
  - `materialization_ok=true`
- long conversation
  - `both_facts=true`
  - `lawCount=0` on memory-only recall
  - prompt growth bounded
- parallel stress
  - `40/40 terminal`
  - outbox drain clean: `done=40 failed=0 stale=0 pending=0 processing=0`
- isolation real
  - same user/different chats: PASS
  - different users/same tenant: PASS
  - same user/different tenants: PASS

### MM Docs

- readiness
  - `publicReadBlocked=true`
  - `qdrantSharedWithMemory=true`
  - `qdrantCollection=lexery_mm_docs_chunks_v1`
  - `max_mm_doc_record_json_bytes` stays small
  - `max_mm_doc_ingest_log_json_bytes` stays small
- live ingest/retrieve
  - docs-only recall returns `lawCount=0`
  - cross-chat/user/tenant leak checks return `docCount=0`
- pipeline live
  - conversation/project/user-global scope retrieval PASS
  - project spreadsheet/pdf/image/rtf paths PASS
  - docs-only routing disables unnecessary LLDBI work early
- large context stress
  - docs-only recall PASS
  - mixed docs+law recall PASS
  - memory+docs recall PASS
  - no-chat/no-user leak PASS

## Storage safety expectations

### Supabase

- `mm_memory_items`
  - short content only, or preview + `r2_key`
- `mm_summaries`
  - bounded text only
- `mm_doc_records`
  - metadata only, no large canonical text blobs
- `mm_doc_ingest_log`
  - bounded retention and bounded row size

### R2

- MM offload:
  - `tenant/{tenant_id}/mm/offload/{memory_item_id}.json`
- MM Docs raw:
  - `tenant/{tenant_id}/mm/docs/user/{user_id}/raw/{doc_id}/{filename}`
- MM Docs canonical:
  - `tenant/{tenant_id}/mm/docs/user/{user_id}/scope/{scope_type}/{scope_id}/{doc_id}/canonical.v1.json`

### Qdrant

- MM memory payload must include isolation keys:
  - `tenant_id`, `user_id`, `conversation_id`
- MM Docs payload must include isolation keys:
  - `tenant_id`, `user_id`, `project_id`, `conversation_id`, `scope_type`, `scope_id`

## Security checks

The following must remain true:

- RLS is forced for MM Docs tables
- anon/public path sees zero MM Docs rows
- internal attachment reuse is restricted to same tenant + same user
- MM Docs canonical artifacts are not accepted back through generic attachment intake
- memory fetch always filters by `tenant_id + user_id`
- MM Docs retrieval always filters by `tenant_id + user_id + scope`

## Current live-proof highlights

Validated in this run:

- `verify_memory_isolation_real.ts` -> PASS
- `verify_memory_long_conversation.ts` -> PASS with `both_facts=true`
- `verify_mm_docs_pipeline_live.ts` -> PASS
- `verify_mm_docs_large_context_stress.ts` -> PASS
- `brain:verify:mm-doc-readiness` -> PASS
- `brain:verify:api-acceptance` -> PASS
- `concurrency_smoke.ts` -> PASS
- `db/db_capabilities_check.ts` -> PASS
- `r2_capabilities_check.ts` -> PASS

## Failure triage

If a run fails, classify it before changing code:

1. `write-path loss`
   - inspect `mm_outbox`, `mm_memory_items`, `mm_summaries`
   - check extractor warnings and malformed JSON handling
2. `retrieval/path leak`
   - inspect `plan_reason_codes`, `use_lldbi`, `use_memory`, `docCount`, `lawCount`
   - verify scope filters and early docs-only routing
3. `runtime pressure`
   - inspect Redis backlog / stale processing / repeated retries
   - inspect R2 repeated fetches and Qdrant latency
4. `docs parser gap`
   - inspect parser warnings in `mm_doc_ingest_log`
   - inspect canonical artifact structure in R2

Do not weaken verifiers to make failures disappear. Fix the root cause and rerun the live proof.
