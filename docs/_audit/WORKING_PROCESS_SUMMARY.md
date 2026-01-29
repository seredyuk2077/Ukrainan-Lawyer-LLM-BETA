# Working Process Summary — Audit + Restructure (no deletions)

**Дата:** 2025-01-29 · **Коміт:** `chore(legislation): working-process audit + restructure (no deletions)`

---

## 1. Що переміщено (old path → new path)

| Old path | New path |
|----------|----------|
| `scripts/legislation/PHASE_*.md` (всі) | `scripts/legislation/docs_lexery_legislation_db_infra/history_by_commit/PHASE_*.md` |
| `scripts/legislation/GATE_A_*.md`, `AUDIT_GATE_A_100.md` | `.../history_by_commit/` |
| `scripts/legislation/PROD_READINESS_PROGRESS.md`, `PROD_GATE_USER_SET_STATUS.md` | `.../history_by_commit/` |
| `scripts/legislation/REFACTOR_*.md` | `.../history_by_commit/` |
| `scripts/legislation/DOCUMENT_TYPE_*.md` | `.../history_by_commit/` |
| `scripts/legislation/SAFETY_AUDIT.md`, `SESSION_RECAP_CHECKPOINT.md`, `SCHEMA_AUDIT.md` | `.../history_by_commit/` |
| `scripts/legislation/EVIDENCE_REPORT.md`, `FINAL_*.md`, `MIGRATION_*.md`, `PROGRESS_REPORT.md` | `.../history_by_commit/` |
| `scripts/legislation/BATCH_IMPORT_TEST_REPORT.md`, `TEST_IMPORT_REPORT.md`, `TEST_RESULTS_*`, `POST_PHASE_*` | `.../history_by_commit/` |

**Залишено в корені (current):** `README.md`, `OPERATIONAL_GUIDE.md`, `CONTEXT_RESTORE_NOTES.md`, `SECURITY_RLS_NOTES.md`, `SCHEMA_MAP.md`, `VERSIONING_POLICY.md`.

**Не переміщували:** `runs/`, `test/`, `taxonomy/`, `Documentation List DB/`. Код (commands, lib, canonical, …) лишається в корені.

---

## 2. Compat stubs

Створено **ні** — переміщували лише .md. Код не переміщували, тому stub’и не потрібні.

---

## 3. Перейменування

Лише переміщення; оригінальні назви .md збережено.

---

## 4. Нова структура

```
scripts/legislation/
  prod_lexery_legislation_db_infra/   { core, commands, adapters, sql, utils } + README
  tests_lexery_legislation_db_infra/  { stage_01..05_*, helpers, data } + README
  docs_lexery_legislation_db_infra/   { current, history_by_commit, investigations } + README
  trash_oneoff_lexery_legislation_db_infra/  { tmp, oneoff_migrations, dead_reports, notes_unreliable } + README
```

Код і тести поки в корені; у нових папках лише README + `history_by_commit` з історичними .md.

---

## 5. Як запускати prod / тести

- **Prod CLI:** `pnpm exec tsx scripts/legislation/admin-cli.ts --help`  
  `add`, `update`, `remove`, `verify`, `repair consistency`, `status`, `soak-test`, `regression-validity`, тощо.
- **Тести:** `admin-cli test-kku`, `test-kupap`, `test-corpus`, `soak-test [--dry-run]`, `verify --nreg <nreg>`, `regression-validity`.  
  Unit: `pnpm exec tsx scripts/legislation/test/vr_speaker_order.test.ts` тощо.

Див. `OPERATIONAL_GUIDE.md`, `docs/_audit/INVENTORY_INDEX.md` (TEST MATRIX).

---

## 6. Evidence E2E 580-VIII («Про Національну поліцію»)

| Крок | Результат |
|------|-----------|
| **add** `--nreg "580-VIII"` | ✅ Успішно. rada_nreg 580-19, title «Про Національну поліцію», R2 `legislation/other/580-19.json`, 134 chunks, Qdrant acts=1 chunks=134. |
| **verify** `--nreg "580-19"` `--write-health` | ✅ PASS, sync_health green. |
| **inspect** `--nreg "580-19"` | ✅ Supabase + Qdrant + R2 (до remove). |
| **remove** `--nreg "580-19"` `--confirm` | ❌ Помилка: `Could not find the table 'public.legislation_chunks' in the schema cache`. Remove очікує таблицю `legislation_chunks`; її немає (чанки в Qdrant). |
| **Повторний verify** після failed remove | R2 key `legislation/other/580-19.json` not found (remove міг видалити R2 до падіння на Supabase chunks). |

**Висновок:** add → verify → inspect пройшли успішно. Remove падає через відсутність `legislation_chunks`; це обмеження інфра/схеми, не реорганізації. «Remove → add again → GREEN» не виконано через неможливість коректного remove.

---

## 7. Артефакти аудиту

- `docs/_audit/AUDIT_PLAN.md`
- `docs/_audit/COMMITS_LAST_7_DAYS.md`
- `docs/_audit/FILES_CHANGED_LAST_7_DAYS.md`
- `docs/_audit/PROJECT_CONTEXT_RESTORE.md`
- `docs/_audit/INVENTORY_INDEX.md`
- `docs/_audit/SELF_VALIDATION_GATE.md`
- `docs/_audit/WORKING_PROCESS_SUMMARY.md` (цей файл)

---

*Working process audit — 2025-01-29*
