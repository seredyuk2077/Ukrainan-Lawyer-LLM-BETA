# Memory Pipeline — MM Memory Runtime

**Status:** production-ready MM memory runtime on shared Lexery-LA infrastructure; semantic-first, summary-first, lazy R2 load, worker materialization live  
**Last updated:** 2026-03-16  

---

## Storage policy (DEV RUN v11)

- **Supabase** — minimal: metadata, indexes, short content or pointer only.
  - When content ≤ `MM_OFFLOAD_THRESHOLD_CHARS`: store full text in `mm_memory_items.content`.
  - When content > threshold: store in R2; in Supabase keep `content` = preview (first N chars), `r2_key`, `content_size`, `content_hash`.
- **Qdrant** — vectors + payload with ids/preview only (no long text in payload); optional `r2_key` when offloaded.
- **R2** — heavy content: `tenant/{tenant_id}/mm/offload/{memory_item_id}.json` (JSON body: content, content_hash, created_at).
- **Idempotency:** content_hash dedup; Qdrant point id = memory_item_id.

### Env vars (offload)

| Var | Default | Notes |
|-----|---------|-------|
| `MM_OFFLOAD_ENABLED` | `false` | Set `true` to offload long facts to R2 |
| `MM_OFFLOAD_THRESHOLD_CHARS` | `1000` | Content longer than this is offloaded (min 10 for dev proof) |
| `MM_OFFLOAD_PREVIEW_CHARS` | `200` | Preview length in Supabase when offloaded |
| `MM_MAX_FACT_TEXT_CHARS` | `500` | Max length per extracted fact before store |

---

## Architecture

```
U12 Deliver → mm_outbox (pending) → MM Outbox Worker → mm_memory_items + mm_summaries + Qdrant lexery_memory_semantic_v1
                                                       ↑
U4 CacheRAG ← mm_memory_items (recent, Supabase) + lexery_memory_semantic_v1 (semantic, Qdrant)
            → RunContext.memory_items + memory_summaries → U9 Assemble → memory channel in LLM context
```

---

## DB Tables

| Table | Key fields | Notes |
|-------|-----------|-------|
| `mm_memory_items` | `tenant_id, user_id, conversation_id, content, content_hash, r2_key, content_size` | When offloaded: content=preview, r2_key set |
| `mm_summaries` | `tenant_id, user_id, conversation_id, summary_text, message_ids` | Per-conversation summary |
| `mm_outbox` | `run_id, conversation_id, tenant_id, event_type, status, payload` | Statuses: `pending→processing→done|failed` |
| `projects` | `tenant_id, name, system_prompt` | Project-level prompts |
| `chat_sessions` | `project_id, chat_system_prompt, user_system_prompt` | Chat-level prompts |

---

## Write Path (MM Outbox Worker)

### Event lifecycle
1. `U12 Deliver` inserts `mm_outbox` row with `status='pending'`, `event_type='index_memory'`
2. `MM Outbox Worker` (`mm/outboxWorker.ts`) polls for pending events
3. Per event: soft-lock → LLM extract facts (Haiku) → embed → insert `mm_memory_items` → upsert Qdrant → upsert `mm_summaries` → mark `done`

### Run the worker manually
```bash
pnpm brain:mm:seed-dev-user   # seed Andrii's identity + run worker once
```

Or call `runOutboxWorkerBatch()` programmatically (e.g., from a cron/serverless function).

### Worker config
| Env var | Default | Notes |
|---------|---------|-------|
| `MM_OUTBOX_BATCH_SIZE` | `5` | Events per poll |
| `MM_EXTRACTION_MODEL_ID` | `anthropic/claude-3-5-haiku` | Cheap Haiku for fact extraction |
| `MM_MAX_FACTS_PER_EVENT` | `5` | Max facts per event |
| `MM_EXTRACTION_TIMEOUT_MS` | `8000` | Timeout for extraction LLM call |

---

## Read Path (U4 CacheRAG) — DEV RUN v12: semantic-first

`fetchRecentMemory()` in `retrieval/memory-store.ts`:

**Retrieval tiers (order):**
1. **Summaries first:** 1–3 `mm_summaries` (high signal, ≤800 chars); returned as `summaryText`.
2. **Semantic primary:** When `MEMORY_SEMANTIC_ENABLED=true` and `queryText` present → Qdrant semantic search (top-k); results ordered by score desc.
3. **Recent fallback:** Only when semantic unavailable or degraded → Supabase recent `mm_memory_items` (limit 3).

**Lazy R2 offload load:** For refs that have `r2_key`, content is loaded from R2 in the read path (bounded concurrency ≤3), truncated to `MM_OFFLOAD_PREVIEW_CHARS`; `offload_loaded_count` and `offload_load_latency_ms` in trace.

### Enable semantic memory
```env
MEMORY_SEMANTIC_ENABLED=true
QDRANT_MEMORY_URL=<same as QDRANT_URL for dev>
QDRANT_MEMORY_API_KEY=<same as legislation key for dev>
```

Note: In production, `QDRANT_MEMORY_URL` should point to a separate dedicated memory cluster.

---

## Qdrant Collection

Collection: `lexery_memory_semantic_v1`  
Vector size: 1536 (text-embedding-3-small)  
Distance: Cosine  
Payload indexes: `conversation_id`, `user_id`, `tenant_id` (keyword type)

---

## DEV Seed (Andrii Tester)

```bash
pnpm brain:mm:seed-dev-user
```

Seeds memory for dev user:
- `tenant_id = 00000000-0000-0000-0000-000000000001`
- `user_id = 00000000-0000-0000-0000-000000000002`
- `conversation_id = 00000000-0000-0000-0000-000000000003`

Expected result:
- 5 mm_memory_items: name, role, company, jurisdiction, language
- 5 Qdrant points in `lexery_memory_semantic_v1`
- `mm_outbox` status = `done`

---

## Verification Checklist

### Via MCP / SQL

```sql
-- 1. Check mm_memory_items populated
SELECT id, content FROM mm_memory_items WHERE conversation_id='00000000-0000-0000-0000-000000000003';

-- 2. Check mm_outbox status
SELECT status, processed_at FROM mm_outbox WHERE run_id='dev-seed-andrii-v1';

-- 3. Check mm_summaries
SELECT summary_text FROM mm_summaries WHERE conversation_id='00000000-0000-0000-0000-000000000003';
```

### Via Qdrant HTTP
```bash
curl -X POST "$QDRANT_URL/collections/lexery_memory_semantic_v1/points/count" \
  -H "api-key: $QDRANT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"must":[{"key":"conversation_id","match":{"value":"00000000-0000-0000-0000-000000000003"}}]}}'
# Expected: {"result":{"count":5}}
```

### Via pipeline
```bash
MEMORY_RECENT_ENABLED=true pnpm brain:verify:u5
# Check U9 log: memory_items_count > 0 (requires test run to use dev user_id)
```

---

## Project/Chat System Prompt Persistence

### Tables added in DEV RUN v10
- `projects` — project-level system prompt
- `chat_sessions.project_id` — FK to projects
- `chat_sessions.chat_system_prompt` — per-chat override
- `chat_sessions.user_system_prompt` — user-level addition

### How it flows
1. Frontend passes `client_context.prompt_stack` in POST /v1/runs
2. U1 gateway stores it in `runs.snapshot.prompt_stack`
3. U10 reads `prompt_stack` from snapshot and passes to `buildPromptStack()`
4. `buildPromptStack()` assembles: global → project → chat → user (priority order)

---

## Current production notes

1. Worker materialization is part of the supported runtime path and is live-verified.
2. Shared Lexery-LA Qdrant topology is accepted for MM memory and MM Docs, with separate collections.
3. Long-conversation closure now requires:
   - `mm_summaries` present
   - bounded prompt growth
   - final recall references both early durable facts
4. The operational runbook now lives in [verification.md](./verification.md).
5. Historical MM Docs bootstrap notes live in [reports/](./reports/).
