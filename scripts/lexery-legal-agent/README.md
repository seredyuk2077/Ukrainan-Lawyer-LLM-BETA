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

## Структура папок (поточний runtime tree)

| Папка | Блоки | Призначення |
|-------|-------|-------------|
| **gateway/** | U1 | HTTP intake, attachments, queue, storage, observability |
| **classify/** | U2, U2a–U2d | Intent/domain/entity/ambiguity routing |
| **plan/** | U3, U3a | SearchPlan і builder кроків |
| **retrieval/** | U4, U6 | LLDBI/MM retrieval, routing hints, trace shaping, fragment loading |
| **gate/** | U5 | Рішення `expand` / `no expand` перед U9 |
| **assemble/** | U9 | Збір prompt context: law + docs + memory + history |
| **write/** | U10–U12 | Legal agent, composer, verify consumer, deliver consumer |
| **mm/** | MM | Memory runtime, outbox worker, MM Docs (`mm/doc/`) |
| **tools/** | verify/dev | Unit tests, smoke/live verifiers, forensics, dev chat, infra checks |
| **lib/** | — | Конфіг, pipeline contracts, shared utils |

U7/U8 зараз лишаються інтеграційними стадіями без окремих top-level папок: їхні точки входу проходять через `plan/`, `gate/`, `retrieval/` і суміжні consumer paths.

## Потік запиту

```
U1 → U2 → U3 → U4 (→ MM) → U5
  → достатньо → U9 → U10 → U11 → U12
  → мало → U6 → U7 → U8 → U4 (repeat) → U5 → …
```

## Пов'язані проєкти

- **DocListDB** (офлайн): `scripts/legislation/` — каталог актів, T0→O2→O3→O4→O5→O6
- **LLDBI** (офлайн): `scripts/legislation/` — імпорт фрагментів законів, T6→O7…O12
