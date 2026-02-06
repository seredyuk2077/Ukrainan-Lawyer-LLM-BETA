# Lexery Legal Agent — Agent Brain

Структура папок для Lexery Legal AI Agent (Agent Brain) відповідно до архітектури системи.

## U1 Gateway (реалізовано)

**Запуск:** `pnpm brain:dev` — HTTP сервер на порту 3081

- `POST /v1/runs` — створення run (dev auth, rate limits, dry-run)
- `GET /health` — health check

**Документація:** [docs/architecture/app/u1/](../../../docs/architecture/app/u1/)

### R2 runs/attachments

Overflow attachments (>512KB) зберігаються в R2 bucket `lexery-legal-agent` під prefix `runs/{tenant_id}/{run_id}/attachments/`.

**Міграція з legislation → lexery-legal-agent:**
```bash
pnpm brain:migrate-r2-runs -- --dry-run  # перегляд
pnpm brain:migrate-r2-runs               # копіювання
```
Потрібно створити bucket `lexery-legal-agent` в Cloudflare R2 перед міграцією.

## Архітектура

> **Документація архітектури:** [`docs/architecture/`](../../docs/architecture/)
>
> - [MEGA_DIAGRAM_FULL.md](../../docs/architecture/MEGA_DIAGRAM_FULL.md) — єдина діаграма всієї системи
> - [LEXERY_LEGAL_AI_AGENT_ARCHITECTURE.md](../../docs/architecture/LEXERY_LEGAL_AI_AGENT_ARCHITECTURE.md) — повний опис архітектури
> - [mermaid/](../../docs/architecture/mermaid/) — детальні діаграми та Block Cards

## Структура папок (онлайн-пайплайн)

| Папка | Блоки | Призначення |
|-------|-------|-------------|
| **gateway/** | U1 | Вхідні двері: прийом запиту, auth, ліміти, RunRecord |
| **classify/** | U2, U2a–U2d | Розуміння запиту: IntentClassifier, LegalDomainTagger, Entity Extractor, Ambiguity Detector |
| **plan/** | U3, U3a | Планування пошуку: SearchPlan, Plan Builder |
| **retrieval/** | U4, U5, U6 | CacheRAG, Gate, Expand: пошук в LLDBI + пам'яті, Gate, Synonymizer |
| **doclist/** | U7 | DocList API: запит → nreg[] (Act Catalog Resolver) |
| **import/** | U8, U8a, U8b | Import: ActIngestionOrchestrator, ActRelevanceValidator → T6 LLDBI |
| **assemble/** | U9 | Збір промпту: system + user + context (EvidencePack, Memory) |
| **write/** | U10 | Генерація відповіді LLM (gpt-4o, evidence-only) |
| **verify/** | U11, U11a–U11e | CoverageCritic, CrossEncoderReranker, QueryRefiner, StopPolicy, WebNavigator |
| **deliver/** | U12 | SSE stream, messages, outbox (index_memory, summarize_case) |
| **memory/** | MM | Memory Manager: Search, Load, Outbox (mm_memory_items, mm_summaries, Qdrant) |
| **lib/** | — | Спільні утиліти, типи, константи |

## Потік запиту

```
U1 → U2 → U3 → U4 (→ MM) → U5
  → достатньо → U9 → U10 → U11 → U12
  → мало → U6 → U7 → U8 → U4 (repeat) → U5 → …
```

## Пов'язані проєкти

- **DocListDB** (офлайн): `scripts/legislation/` — каталог актів, T0→O2→O3→O4→O5→O6
- **LLDBI** (офлайн): `scripts/legislation/` — імпорт фрагментів законів, T6→O7…O12
