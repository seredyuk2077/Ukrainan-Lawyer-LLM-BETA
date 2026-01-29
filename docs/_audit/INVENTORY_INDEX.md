# INVENTORY INDEX — Legislation DB Infrastructure

**Scope:** `scripts/legislation` · **Evidence:** grep/imports/CLI/docs.  
**СТОП:** після Phase 3 — перевірка індекса; без переміщень/перейменувань до "OK".

---

## A) PROD / CORE (реально використовується)

| Path | Тип | Статус | Хто викликає | Що робить | Доказ | Ризик |
|------|-----|--------|--------------|-----------|-------|-------|
| `admin-cli.ts` | script | PROD | CLI entrypoint | Усі команди add/update/verify/repair/jobs/soak/validity/... | README, OPERATIONAL_GUIDE, phase docs | high |
| `config.ts` | code | PROD | importer, radaClient, lib/* | Конфіг, env | grep imports | medium |
| `radaClient.ts` | code | PROD | importer, buildCanonical, backfill-validity, ... | Rada API | grep | medium |
| `lib/importer.ts` | code | PROD | add, update, add-batch, soak-test, test-kku/kupap/corpus/weird, import-hard-soak, continue_batch2 | canonical→R2→AI→embeddings→Supabase→Qdrant→verify | grep "importOne" | high |
| `lib/supabaseAdmin.ts` | code | PROD | importer, verify, repair-*, commands | Supabase client | grep | high |
| `lib/qdrantRagClient.ts` | code | PROD | importer | Upsert acts/chunks, search | importer imports | high |
| `lib/qdrantAdmin.ts` | code | PROD | verify, repair-consistency, status | countByNreg, collections | verify, repair import | high |
| `lib/qdrantIds.ts` | code | PROD | qdrantRagClient, repair-consistency | Детерміновані UUID | grep | medium |
| `lib/r2Admin.ts` | code | PROD | verify, repair-consistency, importer (r2Client) | R2 client, headObject | grep | medium |
| `lib/r2Json.ts` | code | PROD | verify, repair-consistency, importer | getJsonFromR2 | grep | medium |
| `lib/r2Client.ts` | code | PROD | importer (via r2Upload) | R2 S3 client | r2Upload | low |
| `lib/r2Upload.ts` | code | PROD | importer | uploadCanonicalJsonToR2 | importer | medium |
| `lib/r2Guardrails.ts` | code | PROD | importer | assertCanonicalKeyForWrite | importer | low |
| `lib/aiEnrichment.ts` | code | PROD | importer | AI enrichment, category | importer | medium |
| `lib/documentTypeEnrichment.ts` | code | PROD | buildCanonical, detect-type-absurdities, backfill-doc-types | document_type enrichment, cache | grep | high |
| `lib/jobProgress.ts` | code | PROD | importer | legislation_import_jobs | importer | high |
| `lib/runs.ts` | code | PROD | importer | createRunContext, logLine, writeJson | importer | low |
| `lib/verifyApplicability.ts` | code | PROD | verify | N/A vs FAIL matrix | verify imports | medium |
| `lib/radaValidityResolver.ts` | code | PROD | extractValidity, backfill-validity, test-latest-validity | resolveValidityByNreg, clearValidityCache | grep | high |
| `canonical/buildCanonical.ts` | code | PROD | importer, pipeline_import_one, pilot_*, dbImport | Canonical JSON, extractValidityAsync | grep | high |
| `canonical/extractValidity.ts` | code | PROD | buildCanonical, backfill-validity, regression-validity | extractValidityAsync, ValidityResult | grep | high |
| `canonical/parseUnits.ts` | code | PROD | buildCanonical | Content units, chunking guard | buildCanonical | medium |
| `canonical/chunking.ts` | code | PROD | buildCanonical | generateRagChunks | buildCanonical | medium |
| `canonical/r2Path.ts` | code | PROD | importer, buildCanonical | generateR2Key, storage_category | grep | medium |
| `canonical/embeddings.ts` | code | PROD | importer | generateEmbedding, generateEmbeddingsBatch | importer | medium |
| `canonical/actGrouping.ts` | code | PROD | buildCanonical (act_group) | act_group logic | buildCanonical | low |
| `canonical/contentUnits.ts` | code | PROD | chunking, parseUnits | Unit types | grep | low |
| `documentTypes/documentTypes.ts` | code | PROD | guessDocumentTypeV2, enrichment, repair-* | Taxonomy, DocumentTypeSlug | grep | high |
| `documentTypes/guessDocumentTypeV2.ts` | code | PROD | documentTypeEnrichment, detect-type-absurdities | Heuristics doc type | grep | high |
| `taxonomy/taxonomy.ts` | code | PROD | importer, verify, repair-* | category enum, normalize | grep | medium |
| `commands/add.ts` | code | PROD | admin-cli | add --nreg | admin-cli | high |
| `commands/update.ts` | code | PROD | admin-cli | update --nreg | admin-cli | high |
| `commands/remove.ts` | code | PROD | admin-cli | remove --nreg | admin-cli | high |
| `commands/inspect.ts` | code | PROD | admin-cli | inspect --nreg | admin-cli | medium |
| `commands/add-batch.ts` | code | PROD | admin-cli | add-batch --file | admin-cli | medium |
| `commands/status.ts` | code | PROD | admin-cli | status | admin-cli | medium |
| `commands/verify.ts` | code | PROD | admin-cli, prod-gate, import_diverse_batch, import-hard-soak, soak-test, continue_batch2 | verify --nreg/--all, --write-health | grep | high |
| `commands/repair-consistency.ts` | code | PROD | admin-cli, backfill-validity, prod-gate, import_diverse_batch, import-hard-soak, soak-test, continue_batch2, repair-consistency-all | repair consistency --nreg/--all | grep | high |
| `commands/repair-consistency-all.ts` | code | PROD | admin-cli (repair consistency --all) | Loop repairConsistency | admin-cli | medium |
| `commands/backfill-validity.ts` | code | PROD | admin-cli | backfill validity_status | admin-cli | high |
| `commands/regression-validity.ts` | code | PROD | admin-cli | regression-validity | admin-cli | medium |
| `commands/soak-test.ts` | code | PROD | admin-cli | soak-test --file | admin-cli | high |
| `commands/backfill-document-types.ts` | code | PROD | admin-cli | backfill-document-types | admin-cli | medium |
| `commands/detect-type-absurdities.ts` | code | PROD | admin-cli | detect-type-absurdities | admin-cli | medium |
| `commands/jobs.ts` | code | PROD | admin-cli | jobs list/inspect/resume | admin-cli | medium |
| `commands/jobs-reconcile.ts` | code | PROD | admin-cli (jobs reconcile) | Stuck jobs → failed | admin-cli | low |
| `commands/search.ts` | code | PROD | admin-cli | search --query | admin-cli | medium |
| `commands/purge-all.ts` | code | PROD | admin-cli | purge-all | admin-cli | high |
| `commands/prod-gate-user-set.ts` | code | PROD | admin-cli | prod-gate-user-set | admin-cli | medium |
| `commands/import-hard-soak-batch.ts` | code | PROD | admin-cli | import-hard-soak | admin-cli | medium |
| `commands/import_diverse_batch.ts` | code | PROD | admin-cli | import-diverse-batch | admin-cli | medium |
| `utils/nreg.ts` | code | PROD | canonical, lib, commands | nreg helpers | grep | low |

---

## B) TESTS (класифіковані по етапах)

### TEST MATRIX

| Test name / file | Етап | Статус | Як запускати | Останній коміт |
|------------------|------|--------|--------------|----------------|
| `test-kku` | import, resume | актуальний | `admin-cli test-kku` | — |
| `test-kupap` | import | актуальний | `admin-cli test-kupap` | — |
| `test-weird-docs` | import | актуальний | `admin-cli test-weird-docs` | — |
| `test-corpus` | import, batch | актуальний | `admin-cli test-corpus --file test/corpus_nregs.txt --report` | — |
| `soak-test` | import, verify, repair | актуальний | `admin-cli soak-test [--file ...] [--dry-run]` | 5309a29 (verify deps) |
| `verify` (targeted/all) | verify, health | актуальний | `admin-cli verify --nreg \<nreg\>` / `--all [--write-health]` | 5309a29 |
| `regression-validity` | validity | актуальний | `admin-cli regression-validity` | — |
| `test-latest-validity` | validity | актуальний | `admin-cli test-latest-validity [--limit 50]` | — |
| `doc-type-regression` | doc types | актуальний | `admin-cli doc-type-regression` | — |
| `test-document-types-regression` | doc types | актуальний | `admin-cli test-doc-types-regression` | — |
| `test-validation-mismatches` | doc types | актуальний | `admin-cli test-validation-mismatches` | — |
| `mre-parser-integrity` | parser | актуальний | `admin-cli mre-parser-integrity` | — |
| `collect-soak-nregs` | soak prep | актуальний | `admin-cli collect-soak-nregs` | — |
| `test/vr_speaker_order.test.ts` | unit (doc type) | актуальний | `pnpm tsx test/vr_speaker_order.test.ts` (або test runner) | 9a03f18 |
| `test/extractLawNumber.test.ts` | unit | актуальний | `pnpm tsx test/extractLawNumber.test.ts` | — |
| `test/actGrouping.test.ts` | unit | актуальний | `pnpm tsx test/actGrouping.test.ts` | — |
| `test/sanitizeHtml.test.ts` | unit | актуальний | `pnpm tsx test/sanitizeHtml.test.ts` | — |
| `test/test_qdrant_ids.ts` | unit | актуальний | `pnpm tsx test/test_qdrant_ids.ts` | MIGRATION_COMPLETE |
| `test/kind-extractor-test.ts` | unit | актуальний | `pnpm tsx test/kind-extractor-test.ts` | — |
| `test/collect_soak_nregs.ts` | helper | актуальний | через `admin-cli collect-soak-nregs` або directly | PHASE_20B |
| `test/run-benchmark.ts` | retrieval | можливо застарілий | `pnpm tsx test/run-benchmark.ts` | MIGRATION_PLAN |
| `test-resolver-quick.ts` | validity | актуальний | `pnpm tsx test-resolver-quick.ts` | validity_resolver_production_complete |
| `test_verify_qdrant.ts` | qdrant | актуальний | `pnpm tsx test_verify_qdrant.ts` | — |

### Тестові дані (test/)

| Path | Тип | Примітка |
|------|-----|----------|
| `test/corpus_nregs.txt` | data | corpus test |
| `test/soak_nregs.txt` | data | soak default |
| `test/hard_soak_nregs.txt` | data | import-hard-soak default |
| `test/hard_batch_50.txt` | data | Gate A / PHASE 0–2 (7d) |
| `test/hard_stream_200_candidates.txt` | data | diversity |
| `test/prod_gate_user_gold_set.txt` | data | prod-gate-user-set default |
| `test/parser_integrity_set.txt` | data | audit-parser-integrity |
| `test/golden_diversity_set.json` | data | collect-diverse-candidates output |
| `test/doc_type_golden_set.json` | data | doc-type-regression |
| `test/fixtures/*` | data | unit test fixtures (e.g. stru_samples.json) |
| `test/*.report.md`, `test/*.meta.json` | report | генерація тестами |

**Git 7d explicit paths (у DOC/history):** `GATE_A_COMPLETE.md`, `GATE_A_FINAL.md`, `PHASE_3_4_5_COMPLETE.md`, `PHASE_3_6_COMPLETE.md`, `PHASE_3_6_FINAL.md`, `PHASE_3_VR_SPEAKER_ORDER_COMPLETE.md`, `PHASE_3_VR_SPEAKER_ORDER_FIX.md`, `PHASE_4_5_COMPLETE.md` — усі в секції DOC / history_by_commit.

---

## C) DOCS (документація, актуальність)

### DOC INDEX

| Doc file | Про що | Коміт/етап | Актуальність | Зберігати |
|----------|--------|------------|--------------|-----------|
| `README.md` | Скрипти, admin-cli, структура | 2026-01-21 | актуальна | так |
| `OPERATIONAL_GUIDE.md` | Команди, jobs, resume, repair | 2026-01-21 | актуальна | так |
| `CONTEXT_RESTORE_NOTES.md` | System map, invariants, readiness | 2026-01-27 | актуальна | так |
| `SECURITY_RLS_NOTES.md` | RLS, views | — | актуальна | так |
| `SCHEMA_MAP.md` | legislation_documents, jobs | — | частково | так |
| `VERSIONING_POLICY.md` | CURRENT VERSION ONLY | — | актуальна | так |
| `REFACTOR_PLAN.md`, `REFACTOR_STATUS.md` | Рефакторинг | — | історична | архів |
| `PHASE_*` (багато) | Phase evidence, fixes | 74ea353–cc43a22 | історична по фазах | архів / history_by_commit |
| `AUDIT_GATE_A_100.md`, `GATE_A_*` | Gate A audit | 6b4e570–cc43a22 | історична | архів |
| `PROD_READINESS_PROGRESS.md` | Baseline, HARD 50 | 09227fd–9b3d610 | історична | архів |
| `runs/*.md` | Validity, audit, reports | різні | історична / довідка | архів |
| `runs/audit/*.md` | Audit tables, parser integrity | — | довідка | архів |
| `test/batches_plan_200.md`, `hard_stream_coverage.md` | Плани, покриття | — | частково | архів |
| `docs/legislation-rag/*` | Архітектура, R2, ingestion | — | довідка | так |

---

## D) LEGACY / DEPRECATED

| Path | Тип | Статус | Хто викликає | Примітка | Доказ |
|------|-----|--------|--------------|----------|-------|
| `docIndex.ts` | code | LEGACY | find_nreg, pilot_fetch | README: "Legacy discovery", "deprecated" | README |
| `find_nreg.ts` | script | LEGACY | — | README: "legacy"; рекомендовано cli_lookup | README |
| `check_readiness.ts` | script | LEGACY? | — | status → commands/status.ts; окремий check_readiness не в CLI | PROGRESS_REPORT, grep |
| `pilot_fetch.ts`, `pilot_fetch_show.ts` | script | LEGACY | — | Pilot/test fetch; основний flow — admin-cli add | README "pilot" |
| `pilot_import_constitution.ts` | script | LEGACY | — | Pilot import | README |
| `pilot_import_constitution_execute.ts` | script | LEGACY | — | Pilot | — |
| `pilot_build_canonical.ts` | script | LEGACY | pilot_import_constitution | Canonical build pilot | — |
| `pipeline_import_one.ts` | script | LEGACY | — | Standalone import; importer used via add | buildCanonical import |
| `pilot_import_full.ts` | script | LEGACY | — | Pilot full import | — |
| `utils/rawFetch.ts` | code | LEGACY | pilot_fetch only | Raw fetch; radaClient does not use | grep | low |

---

## E) TRASH / TEMP / ONEOFF

| Path | Тип | Статус | Примітка | Доказ |
|------|-----|--------|----------|-------|
| `plan_batches_200.ts` | script | TRASH/ONEOFF | Планування батчів | — |
| `generate_candidates_v2.ts`, `generate_candidates_v2_fast.ts` | script | TRASH/ONEOFF | Збір кандидатів; замінені collect-diverse-* в CLI | admin-cli collect-diverse-candidates |
| `continue_batch2.ts` | script | ONEOFF | Batch continue; імпортує importer, verify, repair | grep; можливо замінити на CLI batch |
| `audit_script.ts` | script | ONEOFF | Gate A audit (cc43a22) | COMMITS_LAST_7_DAYS |
| `r2_cleanup_legal_cases_bucket.ts` | script | ONEOFF | Cleanup bucket за --confirm | docs legislation-rag |
| `r2_verify_bucket_separation.ts` | script | ONEOFF | Перевірка розділення бакетів | docs |
| `r2_verify_and_fix.ts` | script | ONEOFF | R2 verify+fix по nreg | docs, state_snapshot |
| `r2_repair_document.ts` | script | ONEOFF | R2 repair по nreg | docs |
| `r2_upload_canonical.ts` | script | ONEOFF | R2 upload canonical; importer робить upload | docs; importer uses r2Upload |

**Примітка:** `r2_*` і `setup_qdrant_rag` можуть бути корисними утилітами (діагностика, міграції). Їх краще не видаляти; при реорганізації — у **oneoff** / **adapters** за потребою.

---

## Підсумок (статуси)

| Статус | Орієнтовна кількість |
|--------|----------------------|
| **PROD** | ~55 (core + commands + lib + canonical + taxonomy + utils) |
| **TEST** | ~25 (команди + test/*.ts + тестові дані) |
| **DOC** | 80+ (PHASE_*, runs, audit, README, OPERATIONAL_GUIDE, тощо) |
| **LEGACY** | ~10 (docIndex, find_nreg, pilot_*, pipeline_import_one, check_readiness) |
| **TRASH/ONEOFF** | ~10 (plan_batches, generate_candidates_*, continue_batch2, audit_script, r2_*) |
| **UNKNOWN** | 0 (усі класифіковано попередньо) |

---

## Додаткові зауваження

1. **Documentation List DB/** — окреме дерево (Act Catalog Resolver API, Full Import Script, Qdrant Migration). Не входить у основний prod-потік admin-cli → importer → verify → repair. Залишаємо поза реорганізацією кореня `scripts/legislation` на цьому етапі.
2. **580-VIII "Про Національну поліцію":** nreg для E2E — слід узгодити (напр. формат `580-VIII` або `580/98-вр` тощо) перед Phase 6.
3. **Compat stubs:** при переміщенні зберігати тонкі реекспорти з позначкою DEPRECATED, щоб не ламати імпорти.

---

*Створено: 2025-01-29 · INVENTORY_INDEX · STOP для перевірки*
