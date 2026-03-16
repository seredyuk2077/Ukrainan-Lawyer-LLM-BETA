# ADR: U9 Canonical snippets + budgeting + provenance (DEV RUN v7)

**Date:** 2026-02-27
**Status:** Accepted
**Task:** LEX-132

## Context

U9 Assemble skeleton (v2/skeleton ADR) завантажувало snippets з R2, але:
- Нові S3Client на кожен хіт (дорого при 20+ хітах).
- Немає дедуп (один `r2_key+json_path` міг з'явитися двічі).
- Немає token/size budgeting → потенційно гігантський контекст.
- `sourceRef` відсутній у `ContextPart` → thinking agent не знав джерело.
- `assembled_prompt` зберігався тільки в in-memory RunContext → втрата при краші інстансу.
- Логи мінімальні (лише contextPartsCount).

## Decision

### 1. S3Client singleton
`getR2Client()` повертає один `S3Client` на (endpoint, region) конфігурацію. Тест-ін'єкція через `_setR2ClientForTest()`.

### 2. Dedup + stable ordering
`dedupAndSortHits(rawHits)`: унікальні `r2_key+json_path`, сортовані `score desc, key asc`. Детерміновано при однаковому вхіді.

### 3. Concurrent loading
`Promise.all` + `Semaphore(U9_R2_CONCURRENCY=6)` → максимум 6 паралельних R2 запитів на run.

### 4. Budget heuristics
- `U9_MAX_LAW_SNIPPETS` (20): після дедупу беремо top-N.
- `U9_MAX_SNIPPET_CHARS` (2000): обрізаємо по слову.
- `U9_MAX_TOTAL_LAW_CHARS` (30000): загальний ліміт для law channel.
- `U9_MAX_TOTAL_MEMORY_CHARS` (6000): ліміт memory channel.
- Token estimate: `chars / 4` (heuristic, Ukrainian/English mix).
- `meta.budget.truncated + droppedChannels` фіксують що обрізалось.

### 5. Provenance
- Кожен `ContextPart` отримує `sourceRef: LawSourceRef | MemorySourceRef | HistorySourceRef`.
- `LawSourceRef`: `r2_key`, `json_path`, `score`, `rank`, `rada_nreg`, `article_number`, `loaded`.
- `meta.lawSourceRefs`: компактний список всіх law sourceRef (без тексту).

### 6. Graceful missing R2
`loadCanonicalSnippet` ніколи не кидає. На помилці → `ok=false`, missing marker у `contextParts.text`, `loadErrorsCount++`, `meta.degraded=true`. Pipeline не зупиняється.

### 7. Durable persistence
`runs.assembled_prompt` (jsonb) — новий стовпець (migration `20260227000000_lexery_runs_assembled_prompt.sql`).
Зберігається компактна мета (без тексту) — достатньо для crash recovery (U10 може перезавантажити snippets з R2 за `lawSourceRefs`).
`updateAssembledPrompt()` в RunRepository: non-fatal (не блокує pipeline при помилці).

### 8. Observability
`U9 finished` log: `law_hits_raw`, `law_snippets_loaded`, `law_snippets_missing`, `tokenEstimateTotal`, `truncation_truncated`, `u9_latency_ms`, `userPromptLength` — без жодного контенту.

## Non-goals
- Не змінюємо U4 (retrieval quality / routing).
- Не реалізуємо U10 thinking agent.
- Не логуємо повний текст snippets, промптів, memory.
- Без словника `крадіжка → ст. 185`.

## Acceptance criteria
- `pnpm brain:test:u9-units` → 6/6 PASS (dedup, budget, provenance, missing R2, determinism, utilities).
- `pnpm brain:verify:u5` → PASS (U9 runs with real R2 snippets, U10 disabled).
- MCP: `runs.assembled_prompt IS NOT NULL` для щойно виконаного run_id.
- Логи: `law_snippets_loaded > 0`, `tokenEstimateTotal > 0`.

## Results (verified 2026-02-27)
- `run_id: e424ef30`, `law_snippets_loaded: 20`, `tokenEstimateTotal: 4275`, status `completed`.
- `assembled_prompt.sources = {lawCount:20, memoryCount:0, historyCount:0}` в Supabase.
