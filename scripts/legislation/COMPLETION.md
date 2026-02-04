# Legislation RAG — задача виконана

**Дата:** 2026-02-04

## Що зроблено

### 1. Продакшн-пакет Lexery Legislation DB Infra
- Пайплайн імпорту актів: rada.gov.ua → canonical → R2 → embeddings → Qdrant (acts/chunks) → Supabase (metadata, jobs).
- Єдиний CLI: `admin-cli.ts` (add, remove, verify, inspect, search, jobs, repair, backfill тощо).
- Документація: README, ARCHITECTURE, PIPELINE у папці `Lexery Legislation DB Infra/`.

### 2. Run-артефакти в R2 (без локальної папки runs)
- Артефакти кожного add/update/remove зберігаються в R2 під `legislation/tech/runs/`.
- Локально використовується лише тимчасова директорія (потім видаляється); папка `scripts/legislation/runs` не створюється.

### 3. Портабельні шляхи (ізольований запуск)
- Усі шляхи відносно workspace root: `process.cwd()` або `LEXERY_LEGISLATION_WORKSPACE_ROOT`.
- Виходи аудитів/звітів: `runs/`, `data/` під workspace root (без прив’язки до `scripts/legislation/`).
- Пакет можна копіювати разом з `admin-cli.ts` і `.env` та запускати окремо.

### 4. Очищення репозиторію
- Видалено: `runs/`, `test/`, `tests_lexery_legislation_db_infra/`, `trash_oneoff_lexery_legislation_db_infra/`.
- Документація перенесена в `docs/legislation-rag/legislation_audit/`.
- Додаткові скрипти зібрані в `other/` (pilot, r2, lookup, тести).

## Що працює

- **add** — імпорт документа за nreg (наприклад 3321-IX, 2947-III, 322-08); canonical в R2, embeddings у Qdrant, метадані в Supabase.
- **verify** — перевірка консистентності (Supabase, R2, Qdrant); оновлення sync_health.
- **inspect** — діагностика документа (наявність, chunks, r2_key, discrepancies).
- **remove** — видалення з Qdrant, R2 (з архівуванням), Supabase; ідемпотентний.
- **search** — семантичний пошук по Qdrant (релевантні чанки за запитом).
- **status** — перевірка готовності інфраструктури (Supabase, Qdrant, R2).
- **jobs** — list/resume імпорт-джобів.

E2E перевірено на документах: Сімейний кодекс (2947-III), КЗпП (322-08), Про цифровий контент та цифрові послуги (3321-IX).

## Як запускати

```bash
pnpm exec tsx scripts/legislation/admin-cli.ts --help
pnpm exec tsx scripts/legislation/admin-cli.ts add --nreg "3321-IX"
pnpm exec tsx scripts/legislation/admin-cli.ts verify --nreg "3321-20" --write-health
pnpm exec tsx scripts/legislation/admin-cli.ts search --query "цифровий контент" --topk 5
```

Env: SUPABASE_LEGISLATION_*, R2_*, qdrant_cluster*_LEXERY_LEGISLATION_DB, OPEN_ROUTER_API_RAG (див. Lexery Legislation DB Infra/README.md).
