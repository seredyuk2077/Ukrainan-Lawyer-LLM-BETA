# [U9] Assemble — prompt assembly for Legal Agent (LEX-132)

U9 збирає повний промпт для LLM: **system** + **user** + **context** (law + docs + memory + history). Evidence-only: Writer бачить лише підтверджений контекст.

## Inputs

- **RunContext** (run_id, user_input, history, memory_items, memory_summaries, retrieval_trace, raw_hits, gate_decision) — заповнений U1/U2/U4/U5.
- **U4Result** (rawHits, retrievalTrace) — нормалізований вихід U4.
- **GateDecision** — результат U5 (для логіки/статусу; U9 не змінює потік за gate).

## Output

- **AssembledPrompt**: systemPrompt, userPrompt, contextParts (type: law | doc | memory | history), meta.
- **meta**: assembledAt, sourcesSummary, tokenEstimate, budget (tokenEstimateByChannel, truncated, droppedChannels), loadErrorsCount, degraded, sources, lawSourceRefs.

## Evidence channels

| Channel | Source | Content |
|---------|--------|---------|
| **law** | U4 rawHits → R2 snippets | Top-N canonical chunks via `loadCanonicalSnippet` (real text). Deduped, sorted by score, loaded concurrently. On R2 failure: graceful missing marker, no crash. |
| **doc** | `RunContext.doc_snippets` / MM Docs retrieval | Retrieved user-document snippets, ordered ahead of memory in non-memory modes. |
| **memory** | RunContext.memory_summaries, memory_items | summary_text + content_preview (MM Search/Load already filled in U4). |
| **history** | RunContext.history | Last K messages (role + content). |

## Canonical snippet loading

`loadCanonicalSnippet(sourceRef, maxChars) → SnippetLoadResult`

- Reads `r2_key + json_path` from RawHit.
- **Dedup**: identical `r2_key+json_path` → single snippet (max score kept).
- **Ordering**: deterministic score desc, tie-break by r2_key+json_path.
- **Concurrency**: `U9_R2_CONCURRENCY` (default 6) parallel R2 fetches via Semaphore.
- **Error handling**: missing fragment → missing marker in contextParts + `loadErrorsCount++` + `degraded=true`; never throws.
- **S3Client reuse**: singleton per (endpoint, bucket) config — no new client per request.

## Budget & Truncation

Priority order (law first):
1. LAW snippets up to `U9_MAX_TOTAL_LAW_CHARS` (default 30000 chars)
2. USER DOCUMENTS snippets inside the same assembled user-message budget
3. Memory summaries + items up to `U9_MAX_TOTAL_MEMORY_CHARS` (default 6000 chars)
4. History: last `U9_MAX_HISTORY_MESSAGES` (default 10)

Per-snippet max: `U9_MAX_SNIPPET_CHARS` (default 2000), truncated at word boundary with `…`.

Token estimate: `chars / 4` (heuristic). Stored in `meta.budget.tokenEstimateByChannel`.

When budget exceeded: `meta.budget.truncated = true`, `droppedChannels` lists what was cut.

## Provenance

Each `ContextPart` has:
- `sourceRef: LawSourceRef | DocSourceRef | MemorySourceRef | HistorySourceRef`
- For law: `r2_key`, `json_path`, `score`, `rank`, `rada_nreg`, `article_number`, `loaded`
- For docs: `doc_id`, `scope_type`, `scope_id`, `filename`, `score`
- For memory: `id`, `scope`, `scope_type`
- For history: `index`, `role`

`meta.lawSourceRefs`: compact array of all LawSourceRef (for DB persistence and crash recovery).

## Persistence (durable)

After U9:
- **RunContext** (in-memory): full `assembled_prompt` stored for U10 direct access.
- **Supabase `runs.assembled_prompt`** (durable): compact meta stored via `RunRepository.updateAssembledPrompt()`.
  - Contains: sourcesSummary, tokenEstimateTotal, budget, loadErrorsCount, degraded, sources, lawSourceRefs.
  - Does **not** store full snippet text (re-loadable from R2 by r2_key+json_path).
  - Non-fatal on failure: never blocks U9 → U10 pipeline.

Migration: `supabase/migrations/20260227000000_lexery_runs_assembled_prompt.sql`

## Observability (structured logs)

`U9 finished` log fields (no content):
- `law_hits_raw`, `law_snippets_loaded`, `law_snippets_missing`
- `doc_snippets_count`
- `memory_items_count`, `memory_summaries_count`, `history_messages_used`
- `tokenEstimateTotal`, `truncation_truncated`, `degraded`
- `u9_latency_ms`, `contextPartsCount`, `userPromptLength`

## Code

- `assemble/assemblePrompt.ts` — core assembly (dedup, concurrent load, budget, provenance).
- `assemble/consumer.ts` — handleU9Event: load RunContext, call assemblePrompt, persist to DB + RunContext, enqueue U10.
- `retrieval/r2-fragment.ts` — loadCanonicalSnippet, getFragmentFromR2, S3Client singleton.
- `lib/pipeline/contracts.ts` — AssembledPrompt, ContextPart, LawSourceRef, AssembledPromptBudget.
- `gateway/storage.ts` — `RunRepository.updateAssembledPrompt()`.

## Config

| Env var | Default | Description |
|---------|---------|-------------|
| `U9_MAX_LAW_SNIPPETS` | 20 | Max law snippets after dedup |
| `U9_MAX_SNIPPET_CHARS` | 2000 | Max chars per snippet |
| `U9_MAX_TOTAL_LAW_CHARS` | 30000 | Budget: total law chars |
| `U9_MAX_TOTAL_MEMORY_CHARS` | 6000 | Budget: total memory chars |
| `U9_MAX_HISTORY_MESSAGES` | 10 | Max history messages |
| `U9_R2_CONCURRENCY` | 6 | Concurrent R2 fetches |

## Verification

```bash
pnpm brain:test:u9-units
pnpm brain:verify:u5       # Server-level U5 smoke; downstream assemble/write path stays enabled in dry-run mode
```

Pipeline: U4 → U5 → U9 (assemble) → U10 (write).
