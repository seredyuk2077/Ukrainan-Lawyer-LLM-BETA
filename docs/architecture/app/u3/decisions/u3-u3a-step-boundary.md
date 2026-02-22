# ADR: U3 та U3a як окремі кроки (LEX-112, LEX-113)

## Context

Потрібно визначити, чи робити U3 ("де шукати?") і U3a ("конкретні кроки пошуку") одним модулем чи двома окремими кроками в пайплайні.

## Decision

- **U3** і **U3a** — окремі логічні кроки з окремими подіями в черзі (step U3, step U3a).
- **U3** тільки rules engine: QueryProfile + RoutingFlags → SearchPlan (sources, thresholds, reason_codes). Зберігаємо plan у RunRecord.search_plan і RunContext.search_plan; після цього enqueue U3a.
- **U3a** тільки builder: SearchPlan → SearchStep[] (lldbi_chunks, lldbi_acts, memory, doclist, import_fast, web). Зберігаємо steps у RunRecord.search_plan.steps і RunContext.search_steps; next_step = 'U4'; enqueue U4.
- Один audit-об'єкт: RunRecord.search_plan (JSONB) містить { plan, steps?, built_at?, next_step? }. Не плодимо окремі колонки для steps.

## Alternatives

- Об'єднати U3 і U3a в один consumer: відхилено — розділення дає чіткі межі, окремі метрики та можливість повторного запуску U3a при зміні плану без повторного U2/U3.
- Окрема таблиця для steps: відхилено — достатньо JSONB search_plan.steps для аудиту одного run.

## Consequences

- Два етапи обробки (U3 → U3a) з чіткими контрактами; U4 consumer отримує вже готові steps з RunContext або RunRecord.
- E2E: POST /v1/runs → U2 → U3 → U3a → U4 (stub); GET /v1/runs/:id показує search_plan з plan і steps.

## How to verify

- `pnpm brain:u3:test` — усі кейси проходять; у логах U3 finished → U3a enqueued → U3a finished → U4 enqueued.
- GET /v1/runs/:id після обробки повертає search_plan.plan і search_plan.steps, search_plan.next_step = 'U4'.
