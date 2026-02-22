# ADR: SearchPlan + SearchStep schema та RunRecord audit (LEX-105)

## Context

U3 Plan формує SearchPlan ("де шукати?"); U3a Builder — конкретні SearchSteps. Потрібен формальний контракт і місце збереження для аудиту.

## Decision

- **SearchPlan**: один JSON-об'єкт з полями `version`, `sources` (use_lldbi, use_memory, use_doclist, use_web), опційно `thresholds` (top_k_chunks, top_k_acts, min_score, embedding_required), `reason_codes`, `meta`. Валідація — Zod (plan/types.ts).
- **SearchStep**: масив кроків з `kind` (lldbi_chunks | lldbi_acts | memory | doclist | import_fast | web), опційно `params` (top_k, min_score, timeout_ms, nreg_filter), `order`.
- **RunRecord audit**: зберігаємо в існуючому полі `runs.search_plan` (JSONB). Формат: `{ plan: SearchPlan, steps?: SearchStep[], built_at?: string }`. Окремих таблиць для plan не створюємо.
- **RunRepository**: додано метод `updateSearchPlan(runId, searchPlan, status = 'Planning')`.

## Alternatives

- Окремі таблиці `search_plans`, `search_steps`: відхилено — більше міграцій і JOIN-ів, достатньо JSONB для аудиту одного run.
- Зберігати лише в RunContext: відхилено — audit має жити в Postgres (RunRecord).

## Consequences

- U3/U3a пишуть один JSONB; GET /v1/runs/:id може повертати search_plan клієнту.
- Версійність SearchPlan через поле `version`; при зміні контракту змінюємо Zod і опційно version.

## How to verify

- Unit: Zod parse валідного SearchPlan/SearchStep — success; невалідний (unknown kind, від'ємний top_k) — fail.
- Runtime: після реалізації U3 consumer — POST /v1/runs → GET /v1/runs/:id → search_plan присутній і проходить RunRecordSearchPlanAuditSchema.
