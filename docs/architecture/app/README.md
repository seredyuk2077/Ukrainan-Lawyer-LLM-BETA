# Lexery Legal Agent — Implementation Architecture

Опис реалізації архітектури Agent Brain по етапах.

## Етапи

| Етап | Папка | Ключові документи | Статус |
|------|-------|-------------------|--------|
| U1 Gateway/Intake | [u1/](./u1/) | [README](./u1/README.md), [gateway.md](./u1/gateway.md), [test-results](./u1/test-results.md), [decisions/](./u1/decisions/) | ✅ Реалізовано |
| U2 Query Profiling | [u2/](./u2/) | [README](./u2/README.md), [pipeline.md](./u2/pipeline.md), [test-results](./u2/test-results.md), [checklist](./u2/ARCHITECTURE_COMPLIANCE_CHECKLIST_V3.md), [decisions/](./u2/decisions/) | ✅ Реалізовано |
| U3 Plan + U3a Builder | [u3/](./u3/) | [README](./u3/README.md), [decisions/schema-search-plan](./u3/decisions/schema-search-plan.md) | 🔶 Wave 1 контракти; consumer Wave 2 |
| U4 CacheRAG | [u4/](./u4/) | [README](./u4/README.md), [pipeline.md](./u4/pipeline.md), [test-results](./u4/test-results.md), [decisions/](./u4/decisions/) | ✅ Реалізовано (LLDBI + Memory Phase 1) |
| U5 Gate | [u5/](./u5/) | [README](./u5/README.md), [pipeline.md](./u5/pipeline.md), [decisions/](./u5/decisions/) | ✅ Реалізовано |
| U9 Assemble | [u9/](./u9/) | [README](./u9/README.md), [pipeline.md](./u9/pipeline.md), [verification.md](./u9/verification.md), [decisions/](./u9/decisions/) | ✅ Реалізовано, триває стабілізація |
| U10 Legal Agent | [u10/](./u10/) | [README](./u10/README.md), [pipeline.md](./u10/pipeline.md), [verification.md](./u10/verification.md), [reports/](./u10/reports/README.md), [decisions/](./u10/decisions/) | ✅ Реалізовано, якість відповіді ще полірується |
| U11 Verify | [u11/](./u11/) | [README](./u11/README.md), [pipeline.md](./u11/pipeline.md), [decisions/](./u11/decisions/) | ✅ Durable scaffold live |
| U12 Deliver | [u12/](./u12/) | [README](./u12/README.md), [pipeline.md](./u12/pipeline.md), [decisions/](./u12/decisions/) | ✅ Durable deliver path live |
| MM Memory / MM Docs | [mm/](./mm/) | [README](./mm/README.md), [memory-pipeline](./mm/memory-pipeline.md), [verification](./mm/verification.md), [reports/](./mm/reports/README.md) | ✅ Live, active hardening |
| Context / recovery | [context/](./context/) | [README](./context/README.md), [CURRENT_PIPELINE_STATE](./context/CURRENT_PIPELINE_STATE.md), recovery docs, [reports/](./context/reports/README.md) | 🔶 Support / recovery notes |

## Загальний pipeline U1→U12 + MM

Єдине джерело правди щодо кроків і збереження даних: [PIPELINE_U1_U2.md](./PIPELINE_U1_U2.md).

Evidence Search (U3–U9): контракти та U2→U3 enqueue — Wave 1 (LEX-104…110). Деталі: [EVIDENCE_SEARCH_WHATS_REAL.md](./EVIDENCE_SEARCH_WHATS_REAL.md).

U6/U7/U8 поки що не мають окремих canonical stage folders у `docs/architecture/app/`; їхня актуальна поведінка документується через `u4/`, `u5/`, `u9/` і крос-стадійні recovery notes.
