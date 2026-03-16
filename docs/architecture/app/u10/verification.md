# U10 Legal Agent — Verification Runbook

> DEV RUN v14 | Last updated: 2026-02-28

## Noise control + citation template (DEV RUN v14)

To avoid "RAG noise" (model drifting into broad overview instead of focused answer):

- **FocusSpec**: Deterministic primary norm selection from `assembled.meta.lawIndex` (e.g. art. 115 for "умисне вбивство"); `maxLawSnippets=3` for crime_composition.
- **Enforce focus**: After triage, law context is filtered to include primary norm first and capped at `maxLawSnippets`.
- **System prompt**: RAG-awareness ("context from internal Lexery database; do not say 'надані матеріали'"); mandatory template for `crime_composition`: Норма (цитування) → Цитата → Склад злочину (4 elements) → Санкція.
- **Output validator**: Checks banned phrases, citation/structure for crime_composition; records warnings in `llm_result.warnings`.

See ADR: `decisions/u10-noise-control-and-citation-2026-02-28.md`.

## Quick smoke (< 30s, no real LLM)

```bash
pnpm brain:test:u10-units          # 13 unit tests (prompt stack, evidence policy, composer)
pnpm brain:test:u10-preview-units  # 8 preview mode tests (hashes, counts, channel order)
```

## Unit tests (fast, no LLM)

File: `tools/u10/test_legal_agent_units.ts`

| Test | What it checks |
|------|---------------|
| 1–2 | `buildMessagesFromAssembled`: minimal + structured context (LAW / USER DOCUMENTS / MEMORY / HISTORY sections) |
| 3–5 | `buildPromptStack`: ordering, user can't override global safety, defaults |
| 6–9 | `isEvidenceInsufficient`: 0 law, gate.expand=true, degraded, sufficient cases |
| 10 | `evidenceInsufficient=true` → `EVIDENCE INSUFFICIENT` prefix in system prompt |
| 11 | `contextTruncated=true` → truncation warning appended to system |
| 12–13 | `computeComplexityScore`: increases with context; simple query → composer skipped |

## Preview mode tests

File: `tools/u10/test_u10_preview_units.ts`

| Test | What it checks |
|------|---------------|
| P1 | `prompt_stack_keys` in correct order (global→project→chat→user) |
| P2 | `evidence_insufficient` flag correctly set based on law count |
| P3 | `composer_skipped=true` when `evidence_insufficient=true` |
| P4 | Channel separation markers stay stable; docs-enabled runs also surface `=== USER DOCUMENTS ===` before memory |
| P5 | `prompt_stack_lengths` reported per level |
| P6 | `system_hash` and `user_hash` are valid sha256 hex (64 chars) |
| P7 | `counts.law/doc/memory/history` match `contextParts` |
| P8 | Evidence insufficient prefix changes `system_hash` (different prompt = different hash) |

## Preview mode (prompt verification without LLM)

Enable when `LEGAL_AGENT_DISABLE_LLM=true` (already set in CI) and add:

```bash
U10_PREVIEW_MESSAGES=true pnpm brain:verify:u5
```

After running, query Supabase to see the preview:

```sql
SELECT run_id,
       snapshot->'u10_preview' AS preview
FROM runs
WHERE snapshot->'u10_preview' IS NOT NULL
ORDER BY created_at DESC
LIMIT 3;
```

Preview contains:
- `model`: configured model id for the current U10 runtime
- `prompt_stack_keys`: which stack levels were provided
- `evidence_insufficient`: boolean
- `counts.law/doc/memory/history`: channel counts
- `prompt_stack_lengths.global/project/chat/user`: lengths in chars
- `system_hash`: sha256 of assembled system prompt
- `user_hash`: sha256 of assembled user message
- `system_prefix` / `user_prefix`: first 200 chars
- `composer_skipped`: was composer bypassed
- `created_at`

This allows verifying prompt format correctness without real LLM calls.

## Memory and offload

When memory items are offloaded to R2 (see `docs/architecture/app/mm/memory-pipeline.md`), U9 assembles context using **content_preview** (first N chars) in `contextParts`; full content may be loaded lazily from R2 when that path is enabled. U10 receives the same MEMORY channel; counts and hashes reflect the assembled context (preview or full).

## Memory Search Tool (internal)

When **evidence is insufficient** (no law snippets or degraded), U10 calls the internal Memory Search tool (`write/memorySearch.ts`): semantic-first search over agent memory; result is appended as `=== MEMORY SEARCH RESULTS ===` to the user message. In dry_run (`LEGAL_AGENT_DISABLE_LLM=true`) a deterministic stub is returned. Logs: `memory_tool_used`, `memory_tool_latency_ms`, `memory_tool_hits`. See `docs/architecture/app/u10/tools.md`.

## What U10 guarantees for U11/U12

| Invariant | Where to check |
|-----------|---------------|
| `llm_result.answerText` non-empty (or error thrown) | unit tests + MCP |
| `llm_result.warnings=['evidence_insufficient']` when law=0 | unit test 10 |
| `llm_result.model` = configured model id | consumer dry_run stub |
| `llm_result` written durably to `runs.llm_result` | MCP SQL |
| Idempotency: existing `llm_result` → skip LLM, enqueue U11 | consumer logic |
| Preview saved to `runs.snapshot.u10_preview` when preview mode enabled | MCP SQL |

## Multi-tenant safety check

```sql
SELECT DISTINCT tenant_id, COUNT(*) AS run_count
FROM runs
GROUP BY tenant_id;
```

- Each tenant's data is isolated by `tenant_id` (present in every run row)
- `assembled_prompt` only contains data from that run's U4 result (no cross-run leakage)
- `llm_result` is per-run, not shared

## MCP verification after full pipeline

```sql
SELECT run_id,
       status,
       (assembled_prompt IS NOT NULL) AS has_ap,
       (llm_result IS NOT NULL) AS has_llm,
       (verify_result IS NOT NULL) AS has_verify,
       completed_at IS NOT NULL AS done,
       snapshot->'u10_preview' IS NOT NULL AS has_preview
FROM runs
ORDER BY created_at DESC
LIMIT 5;
```

Expected for a completed run: `has_ap=true`, `has_llm=true`, `has_verify=true`, `done=true`.

## Before enabling real LLM (checklist)

Before setting `LEGAL_AGENT_DISABLE_LLM=false` for production:

1. [ ] Run `U10_PREVIEW_MESSAGES=true pnpm brain:verify:u5` and verify `system_hash` is stable across identical inputs
2. [ ] Confirm `system_prefix` starts with `You are Lexery Legal Agent` (global safety prompt present)
3. [ ] Confirm `evidence_insufficient` flag is `false` for runs with real law hits (law=20 expected for ЦЦУ ст.115 / mobilization queries)
4. [ ] Verify `composer_skipped=false` for complex queries (lawCount ≥ 5, no degradation)
5. [ ] Set OpenRouter API key in `.env`: `OPENROUTER_API_KEY_ONLINE=...`
