# U9 Assemble — Verification Runbook

> DEV RUN v9 | Last updated: 2026-02-28

## Quick smoke (runs in < 30s)

```bash
pnpm brain:test:u9-units          # assemble unit suite
pnpm brain:concurrency:smoke      # 15 parallel assemblePrompt calls
pnpm brain:mm:smoke               # memory items/summaries in contextParts
pnpm brain:u9:snippet-audit       # real R2 snippet fidelity (5 snippets)
```

## Unit tests (fast, mock R2)

File: `tools/u9/test_assemble_units.ts`

| Test | What it checks |
|------|---------------|
| 1 | Basic channels: law=0 + memory + history appear in contextParts |
| 1b | Docs channel: retrieved user-document snippets are preserved and ordered before memory |
| 2 | Missing R2 → graceful placeholder, `degraded=true`, `loadErrorsCount>0` |
| 3 | Dedup: identical `r2_key+json_path` → single snippet kept |
| 4 | Budgeting: same input → same output (deterministic) |
| 5 | Provenance: `sourceRef` present on each contextPart; `lawSourceRefs` in meta |
| 6 | Utilities: `extractTextByJsonPath`, `truncateSnippetText` edge cases |
| B3 | Semaphore: 12 hits → max 6 concurrent R2 loads (Semaphore enforced) |

## Snippet fidelity audit (real R2, ~10s)

```bash
pnpm brain:u9:snippet-audit
```

Tool: `tools/u9/manual_snippet_audit.ts`

- Fetches the most recent run with `loaded=true` law snippets from Supabase
- For each snippet (max 5): re-loads from R2 via `loadCanonicalSnippet`
- Checks:
  - `ok=true` (load succeeds)
  - Text is non-empty and not an error placeholder
  - `json_path` matches `$.content.chunks[N].text` format
  - Truncation marker (`…`) present if `truncated=true`
  - **Prefix stability**: two independent loads return the same first 120 characters

Expected: `PASS — all snippets fidelity OK`

If `SKIP` is shown: no runs with loaded law snippets exist yet — run `pnpm brain:verify:u5` first.

## Concurrency smoke (mock R2, < 3s)

```bash
pnpm brain:concurrency:smoke
```

Tool: `tools/load/concurrency_smoke.ts`

- 15 parallel `assemblePrompt` calls, concurrency limit 8
- Different `tenant_id`/`conversation_id`/`run_id` per call
- Validates: all 15 complete, `userPrompt` matches per-run input (no cross-contamination), `meta.budget` present
- Prints per-run law/memory/history counts and total time

Expected: `PASS — all parallel runs completed, no cross-contamination detected.`

## Memory smoke (mock R2, ~5s)

```bash
pnpm brain:mm:smoke
```

Tool: `tools/mm/seed_memory_smoke.ts`

Tests three scenarios:
- A: `memory_summaries` + `memory_items` in RunContext → appear in contextParts
- B: empty `memory_items/summaries` → 0 memory parts, no crash
- C: `memory_trace.degraded=true` + undefined items → graceful (0 parts, no crash)

DB write mode (inserts + cleans up test records):
```bash
MEMORY_SMOKE_DB_WRITE=true pnpm brain:mm:smoke
```

## What U9 guarantees for U10

| Invariant | Where to check |
|-----------|---------------|
| `assembled.meta.lawSourceRefs[]` populated | snippet audit, unit test 5 |
| `assembled.meta.budget` always present | unit test 4 |
| `assembled.meta.degraded` = true on R2 failure | unit test 2 |
| `assembled.meta.sources` has `lawCount/docCount/memoryCount/historyCount` | unit test 1, mm smoke |
| Dedup stable: same hits → same order | unit test 3, 4 |
| R2 concurrency ≤ 6 (Semaphore) | unit test B3 |
| Snippets are real Ukrainian legal text | snippet fidelity audit |
| Missing R2 → placeholder, not crash | unit test 2 |

## MCP verification (Supabase)

After `pnpm brain:verify:u5`, run this in MCP `user-supabase-lexery-legal-agent-db`:

```sql
SELECT run_id,
       assembled_prompt->>'sourcesSummary' AS sources,
       assembled_prompt->>'degraded' AS degraded,
       jsonb_array_length(assembled_prompt->'lawSourceRefs') AS ref_count,
       status, completed_at IS NOT NULL AS done
FROM runs
ORDER BY created_at DESC
LIMIT 5;
```

Expected: latest run has populated `lawSourceRefs`, `degraded=false` for healthy R2 runs, and a completed downstream status once the queue drains.
