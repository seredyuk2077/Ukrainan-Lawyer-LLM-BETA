# DEV RUN v18 — U9 context quality & token budget + strict UA citation + response template

**Scope:** Context starvation forensics, U9 budget re-calibration for GPT-5.2, strict citation output template, evidence block formatting, citation validator + 1 repair. **No U4 changes. No dictionaries.**

---

## Phase 1 — Forensics (run c04ca9c8)

- **Run** `c04ca9c8-6506-4565-b7d0-4693700d9998`: `assembled_prompt` present but **`meta` null** (legacy pipeline). Budget/lawSourceRefs not persisted for this run.
- **Conclusion:** Cannot infer root cause from this run. Implemented observability (u10_prompt_debug, budget in snapshot) for all future runs.

---

## 2) What changed

### Observability (Phase 2)

- **`snapshot.u10_prompt_debug`** (every real run): `system_len`, `user_len`, `evidence_block_len`, `law_parts_count`, `total_evidence_chars`, `max_single_snippet_chars`, `sample_source_ref_ids` (5), `model_id`, `budget` (from assembled.meta).
- **Tool:** `pnpm brain:forensics:u10-debug -- --run-id <uuid>` prints `snapshot.u10_prompt_debug` and `assembled_prompt.meta.budget`.

### U9 budget (Phase 4)

- **`lawBudgetExhausted`:** When `lawCharsUsed + result.text.length > maxTotalLawChars` we break and set `budget.truncated = true` (was only set when all law was “[Норма недоступна]”).
- **Profile `gpt5`:** `U9_BUDGET_PROFILE=gpt5` → `u9MaxSnippetChars=2600`, `u9MaxTotalLawChars=42000` (env overrides: `U9_MAX_SNIPPET_CHARS`, `U9_MAX_TOTAL_LAW_CHARS`).
- **Quote-critical truncation** (`r2-fragment.ts`): If snippet starts with “Стаття”/“Частина”/“Статья”/“Часть”, first **350 chars** are preserved, then the rest is truncated at `maxChars` (word boundary). Unit test: “Стаття 256…” preserved after truncate.

### Citation template & evidence formatting (Phases 5–6)

- **Universal citation rules** in system prompt (always): “Норма (цитування): … ст. X, ч. Y”, “Цитата:”, “Пояснення:”, “Як застосовується (умови/винятки):”. Format: “НПА (Закон України від … якщо є в evidence): ст. X, ч. Y”.
- **Law evidence blocks:** Each snippet: `### [LAW #i] <actTitle> ст. X <normRef>\nSOURCE_ID: …\nTEXT:\n…` (structured for GPT-5.2).

### Validator & repair (Phase 5)

- **`missing_citation`:** Answer length > 100 and no “ст.” or “Стаття” → warning.
- **`ch_without_st`:** “ч.” present but no “ст.”/“Стаття” → warning.
- **Repair:** If `missing_citation`, one call to `repairCitationAnswer()` (nano): “rewrite to include explicit citations”; result replaced, then re-validated.

---

## 3) Files changed

| File | Change |
|------|--------|
| `lib/config.ts` | `u9BudgetProfile`, `u9MaxSnippetChars`/`u9MaxTotalLawChars` gpt5 defaults when `U9_BUDGET_PROFILE=gpt5`. |
| `assemble/assemblePrompt.ts` | `lawBudgetExhausted`; `budget.truncated` when law budget exhausted. |
| `retrieval/r2-fragment.ts` | `truncateSnippetText`: preserve first 350 chars for “Стаття”/“Частина” header. |
| `write/legalAgent.ts` | `UNIVERSAL_CITATION_RULES`, law blocks `### [LAW #i]` + SOURCE_ID + TEXT, `buildU10PromptDebug`, `preBuiltMessages`, `repairCitationAnswer`. |
| `write/consumer.ts` | Build messages once → `buildU10PromptDebug` → `patchSnapshotField(u10_prompt_debug)`; `preBuiltMessages`; citation repair on `missing_citation`. |
| `write/outputValidator.ts` | `checkCitationPresence()` → `missing_citation`, `ch_without_st`. |
| `tools/forensics/u10_prompt_debug.ts` | New: print u10_prompt_debug + budget by run_id. |
| `tools/u9/test_assemble_units.ts` | Test: truncation preserves “Стаття 256”. |
| `tools/u10/test_legal_agent_units.ts` | Test 14: validator flags `missing_citation`. |
| `package.json` | Script `brain:forensics:u10-debug`. |

---

## 4) Tests

- `pnpm lint` — PASS  
- `npx tsc --noEmit` — PASS  
- `pnpm brain:test:u9-units` — PASS (incl. quote-critical truncation)  
- `pnpm brain:test:u10-units` — PASS (incl. citation validator)  

---

## 5) How to run (Phase 8–9)

**Dry-run (no real LLM):**

```bash
pnpm brain:chat:run -- --dry-run --message "Види і типи позовної давності" --tenant tenant-dev --user user-dev-andrii --conversation conv-dev-andrii
```

**One real run:**

```bash
pnpm brain:chat:run -- --real-llm --i-understand-costs --message "Види і типи позовної давності. Поясни з посиланням на норми." --tenant tenant-dev --user user-dev-andrii --conversation conv-dev-andrii
```

**Forensics after run:**

```bash
pnpm brain:forensics:u10-debug -- --run-id <run_id>
```

**Supabase (Phase 9):** For the new run_id, check `assembled_prompt.meta.budget`, `snapshot.u10_prompt_debug`, `llm_result.warnings` (empty or no `missing_citation` after repair).

---

## 6) Root cause (inferred from code)

- Run c04ca9c8 had no meta → no numeric proof.
- **Inferred:** (1) Law budget exhaustion was not marked as `truncated`, so the model did not see a truncation warning. (2) Evidence was one flat block; GPT-5.2 benefits from per-snippet structure. (3) No universal citation rule → vague “ЦК: «…», ч.1” without “ст. X”. Addressed by: `lawBudgetExhausted` → truncated, `### [LAW #i]` blocks, universal citation rules, validator + one repair.

---

## 7) Self-guard

- No U4 changes.  
- No dictionaries / keyword→article maps.  
- Evidence-only; numbers from config and forensics tool.
