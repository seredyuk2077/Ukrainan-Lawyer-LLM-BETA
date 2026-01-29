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

**Після реструктуризації:** код у `prod_.../`; на старих шляхах — stubs. `runs/`, `test/`, `Documentation List DB/` лишаються в корені.

---

## 2. Compat stubs (фінальна реструктуризація)

Створено stubs на старих шляхах після перенесення коду в `prod_lexery_legislation_db_infra/`:
- `commands/*.ts` → `export * from '../prod_lexery_legislation_db_infra/commands/<name>.js'`
- `lib/supabaseAdmin.ts` → реекспорт з `prod_.../lib/supabaseAdmin.js`
- `config.ts`, `radaClient.ts` → реекспорт з `prod_.../lib/`

---

## 3. Перейменування

Лише переміщення; оригінальні назви .md збережено.

---

## 4. Нова структура (після фінальної реструктуризації)

**Канонічне місце коду:** `prod_lexery_legislation_db_infra/`

```
scripts/legislation/
  admin-cli.ts                        # entrypoint (без змін шляху)
  commands/*.ts                       # compat stubs → prod_.../commands
  lib/supabaseAdmin.ts                # compat stub → prod_.../lib
  config.ts, radaClient.ts            # compat stubs → prod_.../lib
  prod_lexery_legislation_db_infra/
    commands/   lib/   canonical/   documentTypes/   taxonomy/   utils/
  tests_lexery_legislation_db_infra/   docs_lexery_legislation_db_infra/
  trash_oneoff_lexery_legislation_db_infra/   test/   runs/
```

**Compat stubs** на старих шляхах — реекспорти з `prod_lexery_legislation_db_infra/...`. Запуск: `pnpm exec tsx scripts/legislation/admin-cli.ts ...`.

---

## 5. Як запускати prod / тести

- **Prod CLI:** `pnpm exec tsx scripts/legislation/admin-cli.ts --help`  
  `add`, `update`, `remove`, `verify`, `repair consistency`, `status`, `soak-test`, `regression-validity`, тощо.
- **Тести:** `admin-cli test-kku`, `test-kupap`, `test-corpus`, `soak-test [--dry-run]`, `verify --nreg <nreg>`, `regression-validity`.  
  Unit: `pnpm exec tsx scripts/legislation/test/vr_speaker_order.test.ts` тощо.

Див. `OPERATIONAL_GUIDE.md`, `docs/_audit/INVENTORY_INDEX.md` (TEST MATRIX).

---

## 6. Remove fix (Qdrant → R2 → Supabase, без `legislation_chunks`)

**Зміни:** `commands/remove.ts` — прибрано звернення до `legislation_chunks`; порядок видалення: Qdrant (chunks → acts) → R2 → Supabase. Ідемпотентність: повторний `remove --confirm` при відсутньому документі завершується OK (best-effort Qdrant delete-by-nreg, без падіння).

**Як запускати:** `pnpm exec tsx scripts/legislation/admin-cli.ts remove --nreg "<rada_nreg>" [--confirm]`. Без `--confirm` — тільки preview. Двічі `--confirm` на вже видаленому документі — OK.

---

## 7. Evidence E2E 580-VIII («Про Національну поліцію»)

| Крок | Результат |
|------|-----------|
| **add** `--nreg "580-VIII"` | ✅ rada_nreg 580-19, R2 `legislation/other/580-19.json`, 134 chunks. |
| **verify** `--nreg "580-19"` `--write-health` | ✅ PASS, sync_health green. |
| **remove** `--nreg "580-19"` `--confirm` | ✅ Qdrant + R2 + Supabase видалено. |
| **inspect** `--nreg "580-19"` | ✅ document_found false, qdrant 0. |
| **remove** `--nreg "580-19"` `--confirm` (ідемпотент) | ✅ OK, «No document in Supabase…». |
| **add** `--nreg "580-VIII"` → **verify** `--nreg "580-19"` | ✅ PASS. |

**Висновок:** повний цикл add → verify → remove → remove → add → verify = PASS.

---

## 8. Evidence E2E «Про прокуратуру» (1697-VII / 1697-18)

| Крок | Результат |
|------|-----------|
| **add** `--nreg "1697-VII"` | ✅ rada_nreg 1697-18, R2 `legislation/other/1697-18.json`, 524 chunks. |
| **verify** `--nreg "1697-18"` `--write-health` | ✅ PASS, sync_health green. |
| **remove** `--nreg "1697-18"` `--confirm` | ✅ Qdrant + R2 + Supabase видалено. |
| **inspect** `--nreg "1697-18"` | ✅ document_found false, qdrant 0. |
| **remove** `--nreg "1697-18"` `--confirm` (ідемпотент) | ✅ OK. |
| **add** `--nreg "1697-VII"` → **verify** `--nreg "1697-18"` | ✅ PASS. |

**Висновок:** E2E на «Про прокуратуру» пройдено. Для verify/remove/inspect використовувати `1697-18`. Після реструктуризації (код у `prod_.../`, stubs): remove → add → verify 1697-18 — PASS.

---

## 9. Артефакти аудиту

- `docs/_audit/AUDIT_PLAN.md`
- `docs/_audit/COMMITS_LAST_7_DAYS.md`
- `docs/_audit/FILES_CHANGED_LAST_7_DAYS.md`
- `docs/_audit/PROJECT_CONTEXT_RESTORE.md`
- `docs/_audit/INVENTORY_INDEX.md`
- `docs/_audit/SELF_VALIDATION_GATE.md`
- `docs/_audit/WORKING_PROCESS_SUMMARY.md` (цей файл)

---

*Working process audit — 2025-01-29 · оновлено 2026-01-29 (remove fix, E2E 580-19, Prokuratura 1697-VII/1697-18)*
