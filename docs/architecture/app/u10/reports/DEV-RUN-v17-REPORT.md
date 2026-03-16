# DEV RUN v17 — Model swap (U9 → GPT-5 nano, U10 → GPT-5.2) + JSON hardening + CLI fixes

**Scope:** U9 meta-triage → GPT-5 nano; U10 → GPT-5.2 (writer) + GPT-5 nano (triage/composer); robust JSON parsing; CLI interactive UX. **No U4 changes. No dictionaries.**

---

## 1) Files changed

| File | Changes |
|------|--------|
| `scripts/lexery-legal-agent/lib/config.ts` | Added `u9MetaTriageModelId`, `u9MetaTriageTimeoutSec`, `u9MetaTriageMaxTokens`, `u9MetaTriageRetries`. Defaults: `legalAgentModelId` → `openai/gpt-5.2`, `evidenceTriageModelId` → `openai/gpt-5-nano`, `promptComposerModel*` → GPT-5.2 / GPT-5-nano. |
| `scripts/lexery-legal-agent/assemble/metaTriage.ts` | Model from config; strict JSON prompt; `parseMetaTriageIndices` + `fallbackTopNByScore`; 1 retry on invalid JSON; deterministic top-N fallback. Exported parse/fallback for tests. |
| `scripts/lexery-legal-agent/write/evidenceTriage.ts` | `parseTriageIndices()` (array or object); 1 retry on empty parse; strict prompt "No markdown, no comments". |
| `scripts/lexery-legal-agent/tools/dev_chat/interactive.ts` | `LOG_LEVEL=warn` by default for clean REPL; safety notice once on real confirm + once when limit reached; `/last`, `/runs [n]`, `/unsafe-unlimited` (confirm: `YES I UNDERSTAND COSTS`); `lastRunId` / `recentRunIds` in state. |
| `scripts/lexery-legal-agent/tools/u9/test_assemble_units.ts` | Tests for `parseMetaTriageIndices` and `fallbackTopNByScore`. |
| `scripts/lexery-legal-agent/tools/u10/test_u10_preview_units.ts` | Preview model from `config.legalAgentModelId` (no hardcoded Claude). |

---

## 2) Model IDs (current defaults)

| Step | Config key | Default model id | Env override |
|------|------------|------------------|--------------|
| U9 meta-triage | `u9MetaTriageModelId` | `openai/gpt-5-nano` | `U9_META_TRIAGE_MODEL_ID` |
| U10 evidence triage | `evidenceTriageModelId` | `openai/gpt-5-nano` | `EVIDENCE_TRIAGE_MODEL_ID` |
| U10 prompt composer (simple) | `promptComposerModelSimpleId` | `openai/gpt-5-nano` | `PROMPT_COMPOSER_MODEL_SIMPLE_ID` |
| U10 prompt composer (complex) | `promptComposerModelComplexId` | `openai/gpt-5.2` | `PROMPT_COMPOSER_MODEL_COMPLEX_ID` |
| U10 main writer | `legalAgentModelId` | `openai/gpt-5.2` | `LEGAL_AGENT_MODEL_ID` / `U10_MODEL_ID` |

All use `OPENROUTER_API_KEY_BRAIN` (or `OPENROUTER_API_KEY_ONLINE`) via existing precedence.

---

## 3) JSON hardening (retry / fallback)

**U9 meta-triage**

- Parse: direct `[...]`, or object `selected_indices` / `selected_source_ids` / `indices`.
- If no valid indices: **1 retry** with hint "Return JSON only. No other text."
- If still empty: **deterministic fallback** = top N by score (indices `0..N-1`).
- On throw: same fallback, `skipped: false` so pipeline still gets indices.

**U10 evidence triage**

- Parse: first `[...]` or object `selected_indices` / `indices`.
- If no valid indices: **1 retry** with "Return JSON only. No other text."
- If still empty: **fallback** = use all snippets (`skipped: true`).

**U2** (unchanged): existing 1 retry + caller fallback; no structural changes.

---

## 4) CLI fixes (UX)

- **Logs:** `LOG_LEVEL=warn` when not set, so server `info`/`debug` do not flood stdout; REPL stays readable.
- **Safety:** "Safety: max 2 real LLM runs…" shown **once** when user confirms real mode (YES), and **once** when limit is first reached; later attempts get short "Limit reached."
- **Commands:**  
  - `/unsafe-unlimited` → prompt to type `YES I UNDERSTAND COSTS`; then `maxRealRuns = 999` for the session.  
  - `/last` → print last `run_id`.  
  - `/runs [n]` → print last n `run_id`s (default 5, max 20).
- **State:** `lastRunId`, `recentRunIds` (up to 20) updated after each run.

---

## 5) Verification (to run locally)

**Dry-run**

```bash
pnpm brain:chat
# /mode dry
# 1) "Водіння в нетверезому стані: коли адмін, коли кримінальна?"
# 2) "Організація незаконного перетину кордону: відповідальність?"
```

**Real (max 2 runs)**

```bash
# /mode real → YES
# Same 2 questions; save run_id from summary.
```

**Supabase proof (Phase 6)**

- For each run: `runs.completed`, `assembled_prompt` present, `llm_result` present.
- Drunk-driving run: `assembled_prompt.meta.lawSourceRefs` contains `sourceId` with `80731-10.json` (КУпАП ст.130); snapshot has `u9_meta_triage`; U10 selection has `triage_used: true` if persisted.

---

## 6) Inventory (Phase 1) — where models are called

| File | Function | Model (config / default) | Purpose | Env |
|------|----------|--------------------------|---------|-----|
| `assemble/metaTriage.ts` | `metaTriageHits` | `u9MetaTriageModelId` → gpt-5-nano | U9 meta-triage | `U9_META_TRIAGE_MODEL_ID` |
| `write/evidenceTriage.ts` | `triageEvidence` | `evidenceTriageModelId` → gpt-5-nano | U10 triage | `EVIDENCE_TRIAGE_MODEL_ID` |
| `write/promptComposer.ts` | `composeInstructions` | Simple/Complex → gpt-5-nano / gpt-5.2 | U10 composer | `PROMPT_COMPOSER_MODEL_*` |
| `write/legalAgent.ts` | `runLegalAgent` | `legalAgentModelId` → gpt-5.2 | U10 main writer | `LEGAL_AGENT_MODEL_ID` |
| `classify/llm-classifier.ts` | `classifyWithLLM` | `clfModelId` | U2 classify | `CLF_MODEL_ID` |
| `lib/config.ts` | — | (defaults above) | — | various |

---

## 7) Tests

- `pnpm brain:test:u9-units` — PASS (includes meta-triage parse + fallback).
- `pnpm brain:test:u10-units` — PASS.
- `pnpm brain:test:u10-preview-units` — PASS (model from config).
- `pnpm brain:test:mm-units` — PASS (unchanged).
- `npx tsc --noEmit` — PASS.
- `pnpm lint` — PASS.

Phase 5 (dry-run + 2 real runs) and Phase 6 (Supabase proof) are left for manual execution and evidence capture.
