# [U3] Plan — SearchPlan + SearchStep (Evidence Search)

Планувальник пошуку: "Де шукати?" — rules engine за QueryProfile/RoutingFlags формує SearchPlan; U3a Builder перетворює його на конкретні SearchSteps (LLDBI, Memory, DocList, Import fast-mode).

## Контракти (LEX-105)

| Тип | Файл | Опис |
|-----|------|------|
| **SearchPlan** | `scripts/lexery-legal-agent/plan/types.ts` | sources (use_lldbi, use_memory, use_doclist, use_web), thresholds (top_k, min_score), reason_codes, meta |
| **SearchStep** | там само | kind: lldbi_chunks \| lldbi_acts \| memory \| doclist \| import_fast \| web; params (top_k, min_score, timeout_ms, nreg_filter), order |
| **RunRecord audit** | `runs.search_plan` (JSONB) | Зберігається через RunRepository.updateSearchPlan(); формат — RunRecordSearchPlanAudit (plan + steps + built_at) |

## Документація

| Документ | Опис |
|----------|------|
| [pipeline.md](./pipeline.md) | U3 rules + U3a builder, failure policy, observability, тести |
| [test-results.md](./test-results.md) | Результати прогону pnpm brain:u3:test |
| [decisions/schema-search-plan.md](./decisions/schema-search-plan.md) | ADR: SearchPlan/Step schema, RunRecord audit |
| [decisions/u3-u3a-step-boundary.md](./decisions/u3-u3a-step-boundary.md) | ADR: чому U3 і U3a окремо |

## Код

- `scripts/lexery-legal-agent/plan/types.ts` — типи + Zod-схеми
- `scripts/lexery-legal-agent/plan/rules.ts` — U3 rules engine (buildSearchPlanFromProfile)
- `scripts/lexery-legal-agent/plan/builder.ts` — U3a builder (buildSearchSteps)
- `scripts/lexery-legal-agent/plan/consumer.ts` — handleU3Event, handleU3aEvent
- Тест: `pnpm brain:u3:test` (потрібен server; порт через BRAIN_BASE_URL/BRAIN_URL)
- **Автономна перевірка**: `pnpm brain:verify:u3` — один запуск: random port, server, health, smoke, u3:test, shutdown (0 ручних кроків)
