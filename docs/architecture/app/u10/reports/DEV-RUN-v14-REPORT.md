# DEV RUN v14 — Final Report

**Date:** 2026-02-28  
**Goal:** Fix "RAG noise" → focused answer + strict UA legal citation (DSTU/NPA) + internal-RAG awareness (U9/U10) + non-LLM tests + 1 sanity real LLM.

---

## 1) Files changed / added

| Path | Change |
|------|--------|
| `lib/pipeline/contracts.ts` | Added `NormRef`, `LawSourceRef.normRef`, `meta.lawIndex` |
| `assemble/normRef.ts` | **New** — extract normRef from snippet text (article, part, heading) |
| `assemble/assemblePrompt.ts` | Call `extractNormRef`, populate `lawIndex` in meta |
| `write/focusSpec.ts` | **New** — buildFocusSpec, enforceFocusOnContextParts |
| `write/legalAgent.ts` | RAG-awareness, banned phrases, crime_composition template |
| `write/outputValidator.ts` | **New** — validateOutput (banned, citation, structure, sprawl) |
| `write/consumer.ts` | Build focusSpec, enforce focus on context, pass taskType, run validator, persist warnings |
| `classify/consumer.ts` | **Fix** — persist `user_input`, `tenant_id`, `user_id`, `conversation_id` in run context (U2) so U9/U10 get real query |
| `tools/u9/test_assemble_units.ts` | Test 7: normRef + lawIndex for "Стаття 115. Умисне вбивство" |
| `tools/u10/test_focus_spec_units.ts` | **New** — FocusSpec unit tests |
| `tools/u10/test_output_validator_units.ts` | **New** — validator unit tests |
| `docs/architecture/app/u10/verification.md` | Section "Noise control + citation template" |
| `docs/architecture/app/u10/decisions/u10-noise-control-and-citation-2026-02-28.md` | **New** — ADR |
| `docs/architecture/app/u10/real-llm-checklist.md` | v14 acceptance note |
| `package.json` | Scripts: `brain:test:focus-spec-units`, `brain:test:output-validator-units` |

---

## 2) Root cause analysis

The model drifted into "overview" because: (1) **20 law snippets** were passed to the agent without a focus signal, so the model treated them as a broad set of "materials"; (2) **run context did not carry the user query** into U10 — `user_input` was never set by U2, so FocusSpec received an empty string and classified `task_type=general`, and no citation template was applied; (3) system prompt lacked **RAG-awareness** and **mandatory citation-first** instructions, so the model was not constrained to one primary norm and DSTU/NPA format. Fix: persist `user_input` (and ids) in U2 run context; add FocusSpec + enforce max 3 law snippets for crime_composition with primary norm first; add RAG-awareness and crime_composition template to system prompt; add output validator (warnings only, no repair in v14).

---

## 3) What changed in U9 metadata (normRef)

- **NormRef** (in contracts): `actTitle`, `actNumber`, `articleNumber`, `partNumber`, `heading`, `keywords` (optional). Extracted in `assemble/normRef.ts` via regexes on snippet text ("Стаття 115", "ст. 115", "Частина перша"/"ч. 1", first-line or post-"Стаття N" heading).
- **LawSourceRef.normRef**: each law snippet gets `normRef` when assembled; backward compatible (null if extraction uncertain).
- **meta.lawIndex**: `Record<sourceId, { articleNumber?, heading?, actTitle? }>` for U10 triage/focus without reading full text.
- Unit test: snippet "Стаття 115. Умисне вбивство…" → articleNumber=115, heading contains "Умисне вбивство", lawIndex present.

---

## 4) FocusSpec + triage enforcement summary

- **buildFocusSpec(userQuestion, assembledMeta, gateExpand):** Deterministic. Detects taskType from query (e.g. "склад злочину" → crime_composition). Scores law refs by heading/article match to query (e.g. умисне вбивство + 115 → high score). Picks primaryNormSourceId (best score or top), primaryNormConfidence (high/low). Sets maxLawSnippets (3 for crime_composition, 4 otherwise), requiredSections, bannedPhrases, citationStyle, tone.
- **enforceFocusOnContextParts:** After triage (or when skipped): put primary norm part first, then slice law parts to maxLawSnippets. Non-law parts unchanged.
- **Consumer:** Builds focusSpec from `runContext.user_input` and assembled.meta; logs task_type, primary_norm_source_id, primary_confidence, max_law_snippets; always runs enforceFocusOnContextParts and replaces assembledForAgent.contextParts; logs "U10 focus enforced" when law count reduced.

---

## 5) Validator + repair behavior

- **validateOutput(answerText, focusSpec):** Checks: banned phrases (e.g. "надані матеріали", "наданих матеріалів"); for crime_composition — citation contains "ст." and "ч." for primary norm, and ("Склад злочину" or 4 elements); article sprawl (e.g. >5 "ст." refs) → warning. Returns `{ pass, warnings }`.
- Warnings are merged into `result.warnings` and persisted in `llm_result`; logged. **Repair (single retry with template) not implemented in v14** — validator is observability-only.

---

## 6) Test commands PASS

- `pnpm lint` — PASS  
- `tsc --noEmit` — PASS  
- `pnpm brain:db:capabilities` — PASS  
- `pnpm brain:r2:capabilities` — PASS  
- `pnpm brain:test:u9-units` — PASS  
- `pnpm brain:test:u10-units` — PASS  
- `pnpm brain:test:mm-units` — PASS  
- `pnpm brain:test:focus-spec-units` — PASS  
- `pnpm brain:test:output-validator-units` — PASS  
- `pnpm brain:chat:dev -- --dry-run --message "Поясни склад умисного вбивства за КК України і наведи статтю"` — PASS  

---

## 7) Real-LLM single run output quality (meets acceptance)

**Run ID:** `b52e26ae-43b5-4654-aa29-7d37a3e9f458`  
**Query:** "Поясни склад злочину умисного вбивства за КК України і наведи статтю"

- **task_type:** crime_composition  
- **primary_confidence:** high  
- **law_before:** 20 → **law_after:** 3  

**Answer:** Starts with "Норма (цитування): Кримінальний кодекс України: Закон України від 05.04.2001 № 2341-III (зі змінами), ч. 1 ст. 115."; includes Цитата; Склад злочину (Об'єкт, Об'єктивна сторона, Суб'єкт, Суб'єктивна сторона); Санкція. Does **not** contain "надані матеріали"; ends with "витягів з норм законодавства з внутрішньої бази Lexery". One relevant extra (ч. 2 ст. 115) — within limit.

**Acceptance:** ✅ Citation block + quote; structured composition; no banned phrase; ≤3 law snippets; internal RAG wording.

---

## 8) MCP proof (run_id in Supabase)

```sql
SELECT run_id, status, assembled_prompt IS NOT NULL AS has_assembled, llm_result IS NOT NULL AS has_llm_result, completed_at
FROM runs WHERE run_id = 'b52e26ae-43b5-4654-aa29-7d37a3e9f458';
```

Expected: `has_assembled=true`, `has_llm_result=true`, `completed_at` set. For lawSourceRefs/counts on earlier run `60a71180-12ac-4fb4-a058-7ab2ffb9095a`: see Phase 1 (20 law refs, no triage, no citation template).

---

## 9) Linear (suggested comment for LEX-133 / LEX-134)

Suggested text for a comment:

> **DEV RUN v14 — noise control + citation:** Shipped FocusSpec (deterministic primary norm + max 3 law snippets for crime_composition), U9 normRef/lawIndex, RAG-awareness and citation-first template in system prompt, output validator (warnings in llm_result). Fixed U2 run context so user_input is persisted and U10 receives the real query (fixes task_type=general bug). Real-LLM sanity: "умисне вбивство" run meets acceptance (citation ч. 1 ст. 115, Склад злочину, no "надані матеріали"). ADR: docs/architecture/app/u10/decisions/u10-noise-control-and-citation-2026-02-28.md

---

*End of DEV RUN v14 report.*
