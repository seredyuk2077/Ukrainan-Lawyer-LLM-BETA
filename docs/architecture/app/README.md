# Lexery Legal Agent — Implementation Architecture

Опис реалізації архітектури Agent Brain по етапах.

## Етапи

| Етап | Папка | Ключові документи | Статус |
|------|-------|-------------------|--------|
| U1 Gateway/Intake | [u1/](./u1/) | [README](./u1/README.md), [gateway.md](./u1/gateway.md), [test-results](./u1/test-results.md), [decisions/](./u1/decisions/) | ✅ Реалізовано |
| U2 Query Profiling | [u2/](./u2/) | [README](./u2/README.md), [pipeline.md](./u2/pipeline.md), [test-results](./u2/test-results.md), [checklist](./u2/ARCHITECTURE_COMPLIANCE_CHECKLIST_V3.md), [decisions/](./u2/decisions/) | ✅ Реалізовано |
| U3 Plan + U3a Builder | [u3/](./u3/) | [README](./u3/README.md), [decisions/schema-search-plan](./u3/decisions/schema-search-plan.md) | 🔶 Wave 1 контракти; consumer Wave 2 |
| U4 CacheRAG | [u4/](./u4/) | [README](./u4/README.md), [pipeline.md](./u4/pipeline.md), [test-results](./u4/test-results.md), [decisions/](./u4/decisions/) | ✅ Реалізовано (LLDBI + Memory Phase 1) |

## Загальний pipeline U1→U2

Єдине джерело правди щодо кроків і збереження даних: [PIPELINE_U1_U2.md](./PIPELINE_U1_U2.md).

Evidence Search (U3–U9): контракти та U2→U3 enqueue — Wave 1 (LEX-104…110). Деталі: [EVIDENCE_SEARCH_WHATS_REAL.md](./EVIDENCE_SEARCH_WHATS_REAL.md).
