# PROJECT_CONTEXT_RESTORE — картки ядрових компонентів

**Мета:** відновлення контексту для аудиту та реорганізації. Evidence-only: entrypoints, артефакти, статус.

**Джерела:** `CONTEXT_RESTORE_NOTES.md`, `README.md`, `OPERATIONAL_GUIDE.md`, grep по імпортах/викликах.

---

## 1. admin-cli

| Поле | Значення |
|------|----------|
| **Файл/модуль** | `scripts/legislation/admin-cli.ts` |
| **Роль** | Головний CLI: add, update, remove, verify, repair, jobs, soak-test, backfill-validity, regression-validity, detect-type-absurdities, тощо. |
| **Entry points** | Зовнішній виклик: `pnpm tsx scripts/legislation/admin-cli.ts` / `node ... admin-cli.ts`. Імпортів **немає** — це кореневий entrypoint. |
| **Артефакти** | Не пише напряму в БД/ R2/Qdrant; делегує командам. |
| **Статус** | **core / prod-critical** |

**Evidence:** `README.md`, `OPERATIONAL_GUIDE.md`, всі phase-доки згадують `admin-cli.ts` як основний entrypoint.

---

## 2. importer (importOne)

| Поле | Значення |
|------|----------|
| **Файл/модуль** | `scripts/legislation/lib/importer.ts` |
| **Роль** | Один документ: Rada → buildCanonical → R2 → AI enrichment → embeddings → Supabase → Qdrant → verify (в implicit flow). |
| **Entry points** | `commands/add.ts`, `commands/update.ts`, `commands/add-batch.ts`, `commands/soak-test.ts`, `commands/test-kku.ts`, `commands/test-kupap.ts`, `commands/test-corpus.ts`, `commands/test-weird-docs.ts`, `commands/import-hard-soak-batch.ts`, `continue_batch2.ts`. |
| **Артефакти** | **Supabase:** `legislation_documents`, `legislation_import_jobs`. **R2:** canonical JSON (`legislation/{storage_category}/{encoded_nreg}.json`), AI cache. **Qdrant:** `lexery_legislation_acts`, `lexery_legislation_chunks`. **runs/** — лог, enrichment. |
| **Статус** | **core / prod-critical** |

**Evidence:** `grep "from.*importer"` → add, update, add-batch, soak-test, test-*, import-hard-soak-batch, continue_batch2.

---

## 3. canonical builder (buildCanonical)

| Поле | Значення |
|------|----------|
| **Файл/модуль** | `scripts/legislation/canonical/buildCanonical.ts` |
| **Роль** | Побудова canonical JSON з raw Rada API; виклик `extractValidityAsync` / `extractValidity`; `generateRagChunks`. |
| **Entry points** | `lib/importer.ts`, `pipeline_import_one.ts`, `pilot_import_full.ts`, `pilot_import_constitution.ts` / `_execute.ts`, `pilot_build_canonical.ts`, `canonical/dbImport.ts`. |
| **Артефакти** | Не пише в БД/R2 сам; виходи — canonical doc + chunks для importer. |
| **Статус** | **core / prod-critical** |

**Evidence:** `grep "from.*buildCanonical\|import.*buildCanonical"` → importer, pipeline_import_one, pilot_*, dbImport.

---

## 4. validity pipeline (Rada JSON primary)

| Поле | Значення |
|------|----------|
| **Файл/модуль** | `lib/radaValidityResolver.ts`, `canonical/extractValidity.ts`, `commands/backfill-validity.ts`, `commands/regression-validity.ts` |
| **Роль** | **Resolver:** Rada API status → ValidityBundle → ValidityResult. **Extract:** `extractValidityAsync` (primary), `extractValidity` (legacy). **Backfill:** оновлення `validity_status` і т.п. у Supabase; після — repair-consistency для Qdrant. **Regression:** тести validity. |
| **Entry points** | `extractValidityAsync`: `buildCanonical.ts`, `backfill-validity.ts`, `regression-validity.ts`. `radaValidityResolver`: `extractValidity.ts`, `backfill-validity.ts`, `test-latest-validity.ts`, `test-resolver-quick.ts`. CLI: `admin-cli.ts` → `backfill-validity`, `regression-validity`. |
| **Артефакти** | **Supabase:** `legislation_documents` (validity_status, source_status_*, status_note). **Qdrant:** payload синхронізується через `repair-consistency`. |
| **Статус** | **core / prod-critical** (Validity Pipeline V2) |

**Evidence:** `runs/validity_resolver_production_complete.md`, `grep "extractValidityAsync\|radaValidityResolver\|repairConsistency"` у backfill-validity, regression-validity.

---

## 5. verify + write-health

| Поле | Значення |
|------|----------|
| **Файл/модуль** | `commands/verify.ts`, `lib/verifyApplicability.ts` |
| **Роль** | Перевірка консистентності Supabase ↔ Qdrant ↔ R2 (invariants). `--write-health`: оновлення `sync_health` (green/yellow/red/unknown) у `legislation_documents`. |
| **Entry points** | `admin-cli.ts` (verify --nreg / --all, --write-health), `prod-gate-user-set.ts`, `import_diverse_batch.ts`, `import-hard-soak-batch.ts`, `soak-test.ts`, `continue_batch2.ts`. |
| **Артефакти** | **Supabase:** `legislation_documents.sync_health`. **View:** `legislation_documents_ui` (health_badge, health_rank) побудована на основі `sync_health`. |
| **Статус** | **core / prod-critical** |

**Evidence:** `grep "verifyDocument\|verifyAll"`; `PHASE_19_*.md`, `20260129100500_update_legislation_documents_ui_view.sql`.

---

## 6. repair-consistency

| Поле | Значення |
|------|----------|
| **Файл/модуль** | `commands/repair-consistency.ts`, `commands/repair-consistency-all.ts` |
| **Роль** | Вирівнювання Supabase ↔ Qdrant ↔ R2: category, expected_chunks, Qdrant payload (document_type_slug, category, validity_* тощо). |
| **Entry points** | `admin-cli.ts` (repair consistency --nreg / --all), `backfill-validity.ts`, `prod-gate-user-set.ts`, `import_diverse_batch.ts`, `import-hard-soak-batch.ts`, `soak-test.ts`, `continue_batch2.ts`. |
| **Артефакти** | **Supabase:** `legislation_documents`. **Qdrant:** `lexery_legislation_acts`, `lexery_legislation_chunks` (payload update). **R2:** тільки read (canonical). |
| **Статус** | **core / prod-critical** |

**Evidence:** `grep "repairConsistency\|repair-consistency"` → admin-cli, backfill-validity, prod-gate, import_*, soak-test, continue_batch2.

---

## 7. soak-test

| Поле | Значення |
|------|----------|
| **Файл/модуль** | `commands/soak-test.ts` |
| **Роль** | Імпорт списку nreg з файлу → verify → при FAIL опційно repair-consistency → re-verify. |
| **Entry points** | `admin-cli.ts` (soak-test --file, --dry-run, --no-repair). |
| **Артефакти** | Ті самі, що importer + verify + repair: Supabase, R2, Qdrant. |
| **Статус** | **core / prod-critical** (тестова команда, але частина прийнятого пайплайну) |

**Evidence:** `admin-cli.ts` → `runSoakTest`; `soak-test.ts` імпортує `importOne`, `verifyDocument`, `repairConsistency`.

---

## 8. Supabase UX view (legislation_documents_ui)

| Поле | Значення |
|------|----------|
| **Файл/модуль** | SQL view: `supabase/migrations/20260129100500_update_legislation_documents_ui_view.sql` |
| **Роль** | VIEW над `legislation_documents` з `health_badge` (🟢/🟡/🔴/⚪) та `health_rank` для сортування. |
| **Entry points** | Supabase Data Editor / UI; не викликається з TS. |
| **Артефакти** | Тільки read; джерело — `legislation_documents.sync_health`, який оновлює `verify --write-health`. |
| **Статус** | **core / prod-critical** |

**Evidence:** `SECURITY_RLS_NOTES.md`, `PHASE_19_*.md`, `PHASE_6_2_COMPLETE.md`.

---

## 9. Додаткові посилання з доків (скрипти/команди)

З `README.md`, `OPERATIONAL_GUIDE.md`, `CONTEXT_RESTORE_NOTES.md`:

- `config.ts` — конфіг, env.
- `radaClient.ts` — Rada API.
- `lib/qdrantRagClient.ts`, `lib/qdrantAdmin.ts`, `lib/qdrantIds.ts` — Qdrant.
- `lib/r2Admin.ts`, `lib/r2Json.ts`, `canonical/r2Path.ts` — R2.
- `lib/jobProgress.ts` — `legislation_import_jobs`.
- `documentTypes/guessDocumentTypeV2.ts`, `lib/documentTypeEnrichment.ts`, `commands/detect-type-absurdities.ts` — doc types.
- `canonical/parseUnits.ts`, `lib/verifyApplicability.ts` — verify applicability, chunking.

**Архітектура:** `docs/legislation-rag/ARCHITECTURE_AS_IS_TO_BE.md`, `R2_POLICY.md`.

---

*Створено: 2025-01-29 · PROJECT_CONTEXT_RESTORE*
