# DEV RUN v15 — Final Report (CLI Chat + DX)

**Date:** 2026-02-28  
**Goal:** Polish CLI chat experience (interactive terminal), user guide for Andriy, safety/cost guards. No U4/U5/U9/U10 logic changes.

---

## 1) Files changed / added

| Path | Change |
|------|--------|
| `scripts/lexery-legal-agent/tools/dev_chat/core.ts` | **New** — runOnce(), fetchRunSummary(), RunOnceOptions, RunResult, RunSummaryFromDb, DEV_* constants |
| `scripts/lexery-legal-agent/tools/dev_chat/run_cli.ts` | **New** — single-shot CLI (brain:chat:run / brain:chat:dev), aliases tenant-dev → seed UUIDs |
| `scripts/lexery-legal-agent/tools/dev_chat/interactive.ts` | **New** — REPL (brain:chat), /mode, /prompt, /new, /status, /run, /verbose, /exit, YES confirmation, max 2 real runs/session |
| `scripts/lexery-legal-agent/tools/dev_chat/test_core_units.ts` | **New** — unit tests for runOnce (mock server), real mode without API key, prompt_stack in body, fetchRunSummary |
| `docs/architecture/app/u10/cli-chat.md` | **New** — setup, quick start, interactive commands, real LLM, debug, command reference, "як потестити за 5 хв" |
| `package.json` | brain:chat, brain:chat:interactive, brain:chat:run, brain:chat:dev → new entry points; brain:test:dev-chat-units |

**Removed / deprecated:** `brain:chat:dev` now points to `run_cli.ts` (same interface). Old `dev_chat_runner.ts` remains in repo but is no longer used by package.json scripts.

---

## 2) Example commands

**Dry-run interactive:**
```bash
pnpm brain:chat
# then: You: Поясни склад умисного вбивства за КК України
```

**Dry-run single-shot:**
```bash
pnpm brain:chat:run -- --message "Поясни склад умисного вбивства за КК України"
pnpm brain:chat:run -- --dry-run --message "..." --tenant tenant-dev --user user-dev-andrii --conversation conv-dev-andrii
```

**Real LLM single-shot:**
```bash
pnpm brain:chat:run -- --real-llm --i-understand-costs --message "Поясни склад злочину умисного вбивства за КК України і наведи статтю"
```

---

## 3) Short manual: як Андрію потестити за 5 хв

1. **Dry-run:** `pnpm brain:chat` → ввести повідомлення → Enter. Відповідь stub + run summary (run_id, total_ms, model).
2. **Single-shot:** `pnpm brain:chat:run -- --message "Поясни склад умисного вбивства за КК України"`.
3. **Real LLM:** У REPL: `/mode real` → ввести `YES` → відправити запит. Або: `pnpm brain:chat:run -- --real-llm --i-understand-costs --message "..."`.
4. **DB:** run_id з summary → `SELECT run_id, status, completed_at FROM runs WHERE run_id = '<run_id>';`

Env: `DEV_ALLOW_ANONYMOUS=true`; для real LLM — `OPENROUTER_API_KEY_BRAIN`.

---

## 4) Cost / safety guardrails

- **Real LLM allowed only if:** `OPENROUTER_API_KEY_BRAIN` (or `OPENROUTER_API_KEY_ONLINE`) is set **and** user confirmed `YES` in REPL (or `--i-understand-costs` in single-shot).
- **Interactive session:** max **2** real LLM runs per session. Restart for more. `--unsafe-unlimited` raises limit (not recommended).
- **runOnce:** in `real` mode, throws with a clear message if API key is missing (no silent fallback).

---

## 5) Run summary fields (after each run)

CLI prints:

- **run_id**
- **status**
- **total_ms**
- **lawCount** (if in response)
- **memoryCount** (if in response)
- **triage_used** (if in llm_result)
- **triage_selected_count** (if in llm_result)
- **evidence_insufficient** (if in llm_result)
- **usage** (prompt_tokens, completion_tokens, total_tokens when real LLM)
- **model**
- **warnings** (if any)

With `--verbose` (single-shot) or `/verbose on` (REPL): DB verification line (completed_at, has_assembled, has_llm_result). `fetchRunSummary(run_id)` used for that (reads from Supabase via RunRepository).

---

## 6) Verification commands (PASS)

- `pnpm lint` — PASS  
- `tsc --noEmit` — PASS  
- `pnpm brain:db:capabilities` — PASS  
- `pnpm brain:r2:capabilities` — PASS  
- `pnpm brain:test:u9-units` — PASS  
- `pnpm brain:test:u10-units` — PASS  
- `pnpm brain:test:dev-chat-units` — PASS  
- `pnpm brain:chat:run -- --dry-run --message "Поясни склад умисного вбивства за КК України" --tenant tenant-dev --user user-dev-andrii --conversation conv-dev-andrii` — PASS  

Manual: `pnpm brain:chat` — 2–3 повідомлення перевірено (dry-run UX).
