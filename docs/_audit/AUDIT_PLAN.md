# WORKING PROCESS AUDIT + FILE STRUCTURE REBUILD — PLAN

**Мова:** українська · **Режим:** Auto + Planning · **Роль:** Senior Architect / Lead Dev / Repo Auditor  
**Scope:** `scripts/legislation` · **Evidence-first:** кожне твердження підтверджується grep/командою/git.

---

## 0. ЖОРСТКІ ПРАВИЛА (НЕ ПОРУШУВАТИ)

- **Evidence-first:** кожне "працює/неактуальне/застаріло/прод" — (а) grep/import reference, (б) команда/тест, (в) git історія.
- **НЕ ВИДАЛЯТИ** файли на цьому етапі. Тільки: переміщувати, перейменовувати, compat stubs.
- При зміні шляху/назви: оновити всі імпорти, посилання в документації, запустити мінімальні перевірки.
- **Ніяких великих нових систем.** Тільки аудит, структура, документація, валідація командами.
- Працюємо в межах: `scripts/legislation` (+ `docs/_audit` для артефактів).

---

## 1. ЧЕКПОІНТИ ПЛАНУ

| Phase | Назва | Артефакти | Команди |
|-------|--------|-----------|---------|
| **0** | **PLANNING** | `docs/_audit/AUDIT_PLAN.md` | — |
| **1** | **Git audit (7 днів)** | `COMMITS_LAST_7_DAYS.md`, `FILES_CHANGED_LAST_7_DAYS.md` | `git log --since="7 days ago"` |
| **2** | **Context restore** | `PROJECT_CONTEXT_RESTORE.md` (картки ядра) | Читання доків, посилань, код |
| **3** | **Інвентаризація** | `INVENTORY_INDEX.md` (PROD/TEST/DOCS/LEGACY/TRASH + TEST MATRIX + DOC INDEX) | grep, імпорти |
| **3 STOP** | **Перевірка** | — | Чекати "OK" від автора перед Phase 4 |
| **4** | **Реорганізація** | Нова структура папок, compat stubs, оновлені імпорти/посилання | move/rename, tsc/typecheck |
| **5** | **Regression/Commands** | Evidence що команди не падають | `admin-cli --help`, `verify`, `repair consistency`, `regression-validity`, `soak-test` |
| **6** | **E2E 580-VIII** | Лог + SQL + R2 + Qdrant evidence | add → verify → repair → remove → add |
| **7** | **Documentation + Commit** | `WORKING_PROCESS_SUMMARY.md` | `chore(legislation): working-process audit + restructure (no deletions)` |

---

## 2. КОМАНДИ ДЛЯ ВИКОНАННЯ (ПО ФАЗАХ)

### Phase 1 — Git audit
- `git log --since="7 days ago" --oneline --decorate`
- `git log --since="7 days ago" --name-status --date=iso`
- `git log --since="7 days ago" --name-only --pretty=format:"=== %h | %ad | %s ===" --date=short`

### Phase 5 — Acceptance (адмін-CLI)
- `node scripts/legislation/admin-cli.ts --help`
- `node scripts/legislation/admin-cli.ts verify --help`
- `node scripts/legislation/admin-cli.ts verify --all` (або `--nreg <nreg>`)
- `node scripts/legislation/admin-cli.ts verify --all --write-health`
- `node scripts/legislation/admin-cli.ts repair consistency --all` (або `--nreg <nreg>`)
- `node scripts/legislation/admin-cli.ts regression-validity`
- `node scripts/legislation/admin-cli.ts soak-test --dry-run` (або 1–2 nreg)

### Phase 6 — E2E 580-VIII
- add "Про Національну поліцію" 580-VIII → verify (targeted) → repair (якщо потрібно) → remove → add знову → GREEN.

---

## 3. РЕКОМЕНДОВАНА СТРУКТУРА (Phase 4)

```
scripts/legislation/
  prod_lexery_legislation_db_infra/
    core/           # прод-ядро: importer, canonical, clients, cli core
    commands/       # актуальні CLI команди
    adapters/       # supabase, qdrant, r2, rada
    sql/            # актуальні SQL (view, migrations якщо тут)
    README.md
  tests_lexery_legislation_db_infra/
    stage_01_import/
    stage_02_verify_health/
    stage_03_qdrant_sync/
    stage_04_validity_pipeline/
    stage_05_soak/
    helpers/
    README.md
  docs_lexery_legislation_db_infra/
    current/
    history_by_commit/
    investigations/
    README.md
  trash_oneoff_lexery_legislation_db_infra/
    tmp/
    oneoff_migrations/
    dead_reports/
    notes_unreliable/
```

---

## 4. КРИТИЧНІ КОМПОНЕНТИ (НЕ ЛАМАТИ)

- **admin-cli** (`scripts/legislation/admin-cli.ts`) — entrypoint CLI.
- **Validity pipeline V2:** `lib/radaValidityResolver.ts`, `canonical/extractValidity.ts`, `commands/backfill-validity.ts`, `commands/regression-validity.ts`, `repair-consistency` (Qdrant sync).
- **Supabase UX view:** `legislation_documents_ui` + `verify --write-health` (health_badge / health_rank).
- **Soak-test** (`commands/soak-test.ts`) — не зламати.

---

*Створено: 2025-01-29 · AUDIT_PLAN*
