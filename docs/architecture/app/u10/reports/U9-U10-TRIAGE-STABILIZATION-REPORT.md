# U9/U10 Triage Stabilization — Implementation Report

**Date:** 2026-03-03  
**Scope:** Phase 1–6 (triage policy, U9 selection, evidence triage quality, forensics, tests, real runs).

---

## 1) Що змінив (по файлах)

### Phase 1 — Triage model policy
- **lib/openrouter.ts:** `effectiveMaxTokens = max_completion_tokens ?? max_tokens ?? 1024`; `OpenRouterResult` extended with `request_max_completion_tokens`; return includes it for forensic.
- **lib/config.ts:** U9 `u9MetaTriageMaxCompletionTokens`, `u9MetaTriageRetryMaxCompletionTokens`; evidence `evidenceTriageMaxCompletionTokens`, `evidenceTriageRetryMaxCompletionTokens`; U9 diversity `u9MaxChunksPerSource` (default 6). Backward-compatible fallback from existing MAX_TOKENS env.
- **assemble/metaTriage.ts:** Uses `TRIAGE_RESPONSE_FORMAT`, `reasoning: { effort: 'low' }`, `max_completion_tokens`; 3-step retry (primary base → primary retry budget → fallback); `logAttempt(attempt, result, outcome)`; parse fail → `gapFreeDeterministicFallback`.
- **write/evidenceTriage.ts:** Uses `EVIDENCE_RESPONSE_FORMAT`, `reasoning: { effort: 'low' }`, `max_completion_tokens`; same 3-step retry; `modelChain` push on every attempt (including failed); `logAttempt` per attempt.

### Phase 2 — U9 law selection
- **assemble/metaTriage.ts:** `gapFreeDeterministicFallback` (anchor top-5, round-robin segments, query-number match, diversity cap 6 per `r2_key`); all fallback paths use it; `coveragePreservingFallback` deprecated.
- **assemble/assemblePrompt.ts:** Multi-signal selection: candidates = anchor (top 5) + meta triage indices + query-number match; fill by rank if needed; combined score (0.4 score + 0.4 model + 0.2 query); diversity cap via `config.u9MaxChunksPerSource`; log `u9_law_selection: multi_signal` with `sources_count`.

### Phase 3 — Evidence triage quality
- **lib/config.ts:** `evidenceTriageMaxSelected` (env `EVIDENCE_TRIAGE_MAX_SELECTED`, default 8).
- **write/evidenceTriage.ts:** `queryAwareExcerpt(text, query, excerptChars)` — best window by token overlap; prompt uses heading/article/source + query-aware excerpt; min/max from config in prompt; top-up by combined relevance (rank + overlap + diversity), not pure rank; full `triage_model_chain` (push on each attempt including failures).

### Phase 4 — Forensics
- **tools/forensics/u9_u10_chunk_diagnostic.ts:** Removed hardcoded 185/186/187; uses `gapFreeDeterministicFallback` for simulation; added `tokenOverlapCount`, `sourceDiversityIndex`, `rankHistogram`; output: query article numbers, article-number overlap, source diversity index, selected rank histogram; with `--load-r2`: per-snippet `query_token_overlap`, % selected with non-zero lexical overlap, diversity index.

### Phase 5 — Tests
- **tools/u9/test_assemble_units.ts:** `testGapFreeDeterministicFallback()` — cap 20, at least one query-number (185/187) included, diversity cap 6 per source.
- **tools/u10/test_evidence_triage_units.ts:** New file; `queryAwareExcerpt` overlap window and no-overlap fallback.
- **package.json:** `brain:test:evidence-triage-units` script.

---

## 2) Чому це працює (коротко, технічно)

- **Stability:** Retry policy (base → higher budget → fallback) avoids silent fail on `finish_reason=length`; every attempt is logged and recorded in `modelChain`/snapshot, so fallback path is visible.
- **Structured output:** `response_format` (TRIAGE_RESPONSE_FORMAT / EVIDENCE_RESPONSE_FORMAT) + `max_completion_tokens` give the model enough room and a clear schema; `reasoning: { effort: 'low' }` reduces reasoning tokens on nano, leaving more for the JSON.
- **Quality:** Multi-signal U9 selection (model + score + query-number + diversity cap) avoids fixed top-10 locking in noise; gap-free fallback has no rank gaps and includes query-number matches and source diversity.
- **Evidence triage:** Query-aware excerpts improve Stage 1 relevance signal; configurable min/max and top-up by combined relevance (rank + overlap + diversity) keep context sufficient without blind rank top-up.

---

## 3) Результати тестів

### Unit
- `pnpm brain:test:u9-units` — PASS (incl. gapFreeDeterministicFallback).
- `pnpm brain:test:u10-units` — PASS.
- `pnpm brain:test:focus-spec-units` — PASS.
- `pnpm brain:test:evidence-triage-units` — PASS (queryAwareExcerpt).
- `tsx scripts/lexery-legal-agent/tools/_units/test_openrouter_units.ts` — PASS.

### Real runs (Phase 6)

| Run | Query | run_id | U9 EMPTY/LENGTH? | U9 model (final) | U10 triage EMPTY? | U10 triage model | U9 sources_count | Quality note |
|-----|-------|--------|------------------|------------------|-------------------|------------------|------------------|---------------|
| 1 | Крадіжка vs грабіж, процитуй ККУ | 096c6be2-4e14-4e7d-80eb-b99bf3ecd83c | No (stop) | gpt-5-nano | N/A (skipped, law=7) | — | 2 | ст.185/186 у відповіді, коректно |
| 2 | Незаконний перетин кордону під час воєнного стану | d51e0d59-c604-4347-b150-a1574e3fc225 | Yes → retry 2 ok | gpt-5-nano | Yes → retry 2 ok | gpt-5-nano | 4 | ст.332²/332/111 у контексті |
| 3 | Шахрайство vs привласнення ввіреного майна, ККУ | 29676757-d7d9-4f9f-9fec-5369486badcf | Yes (empty content) → retry 2 ok | gpt-5-nano | No (stop) | gpt-5-nano | 5 | ст.190 + пленум у відповіді |

- У всіх трьох run triage не закінчився silent fail: при length/empty спрацьовує retry з більшим budget, потім при потребі fallback; лог `u9_meta_triage: attempt` / `evidence_triage: attempt` показує attempt, model_id, finish_reason, token_budget.
- U9 selected law context: multi_signal з `sources_count` 2–5 (різні джерела), без жорсткого top-10.

---

## 4) Залишкові ризики

- **gpt-5-nano** все ще часто дає length/empty на першій спробі; retry з 800 tokens стабільно допомагає, але затримка зростає (2 спроби U9/U10).
- **400 від OpenRouter:** якщо провайдер не приймає `response_format` або `reasoning` для nano, можливий 400; поточний код при HTTP_ERROR йде на fallback model; якщо обидва падають — triage fallback (gap-free / use all) з фіксацією в snapshot.
- **U2 classifier timeout (5s):** не змінювався; при degraded mode це може впливати на подальший pipeline (позначено в ТЗ як medium).

---

## 5) Що рекомендую далі

- Моніторити частоту `EMPTY_OUTPUT_LENGTH` / `EMPTY_ASSISTANT_CONTENT` на attempt 1; якщо висока — розглянути збільшення базового `U9_META_TRIAGE_MAX_COMPLETION_TOKENS` / `EVIDENCE_TRIAGE_MAX_COMPLETION_TOKENS` (наприклад 700/800 за замовчуванням).
- Для run з `law > threshold` перевірити forensic `u9_u10_chunk_diagnostic --load-r2 --run-id <id>`: % selected with lexical overlap, source diversity index, rank histogram.
- Якщо з’являться 400 на nano з `response_format` — додати fallback виклик без `response_format` (тільки для fallback model) і зафіксувати в звіті.

---

## Команди для відтворення

```bash
# Unit tests
pnpm brain:test:u9-units
pnpm brain:test:u10-units
pnpm brain:test:focus-spec-units
pnpm brain:test:evidence-triage-units
pnpm exec tsx scripts/lexery-legal-agent/tools/_units/test_openrouter_units.ts

# Real runs (приклад)
pnpm brain:chat:run -- --message "яка різниця між крадіжкою та грабіжем? конкретно процитуй ККУ" --real-llm --i-understand-costs
pnpm brain:chat:run -- --message "Незаконний перетин кордону під час воєнного стану" --real-llm --i-understand-costs
pnpm brain:chat:run -- --message "Шахрайство vs привласнення ввіреного майна, процитуй ККУ" --real-llm --i-understand-costs

# Forensics (після run)
pnpm brain:forensics:u9-u10-chunks -- --run-id <run_id> --load-r2
```

**Before/after (метрики):** Раніше в 3 run-ах U9/U10 triage майже завжди давав EMPTY_OUTPUT_LENGTH і переходив на gpt-4o-mini без повної прозорості. Після змін: (1) triage не закінчується silent fail — або успіх на 1–2 спробі з nano, або явний fallback з записом у логах/snapshot; (2) U9 selection — multi_signal з 2–5 джерел замість фіксованого top-10; (3) evidence triage — query-aware excerpt, configurable bounds, top-up за combined relevance; (4) forensics — domain-agnostic, без hardcoded 185/186/187.
