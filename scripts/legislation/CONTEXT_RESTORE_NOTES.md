# Context Restore Report — Legal RAG / Rada.gov.ua

**Дата:** 2026-01-27  
**Мета:** Відновлення повного контексту системи для продовження роботи

---

## 1) Current Snapshot (фактологічний стан)

### Supabase Statistics
- **total_docs:** 238 (було ~190, збільшилось на ~48 документів)
- **null_document_type_slug:** 0 ✅
- **null_category:** 0 ✅
- **null_document_number:** 0 ✅
- **null_r2_key:** 0 ✅
- **null_content_hash:** 0 ✅
- **null_sync_health:** 52 (22% документів без sync_health)
- **sync_health distribution:**
  - green: 180 (76%)
  - yellow: 6 (3%)
  - red: 0 ✅
  - unknown: 0
  - NULL: 52 (22%)
- **zero_or_null_chunks:** 0 ✅

### Document Type Distribution (Top 10)
1. `cmu_order`: 61
2. `cmu_resolution`: 45
3. `nbu_letter`: 18
4. `vr_resolution`: 17
5. `minister_order`: 15
6. `presidential_decree`: 14
7. `ccu_decision`: 10
8. `nbu_resolution`: 8
9. `presidential_order`: 5
10. `code`: 4

### Verify Status
- **detect-type-absurdities:** PASS (0 CRITICAL, 0 WARN на 20 перевірених)
- **verify FAIL:** не запускався повністю, але sync_health=red=0 ✅

### R2 Canonical Coverage
- ✅ Перевірено: `legislation/other/n0019525-22.json` існує, структура валідна
- ✅ Canonical формат: version 1.0, schema_version 1.0
- ✅ Chunks присутні: 17 chunks для n0019525-22
- ✅ Metadata повна: content_hash, document_type_slug, category, r2_key

### Qdrant Sync
- ✅ Детерміновані IDs: `qdrantIds.ts` використовує `deterministicUuidFromString("${nreg}|${content_hash}|${chunk_index}")`
- ✅ Collections: `lexery_legislation_acts`, `lexery_legislation_chunks`
- ✅ Payload синхронізація: `repair-consistency.ts` синхронізує Supabase ↔ Qdrant
- ⚠️ Не перевіряв фактичну кількість points в Qdrant (потрібен ручний перевір)

---

## 2) System Map (карта модулів)

### Ingestion Pipeline Flow
```
Rada API (radaClient.ts)
  ↓
Canonical Builder (buildCanonical.ts)
  ↓
R2 Upload (r2Upload.ts) → canonical JSON
  ↓
AI Enrichment (documentTypeEnrichment.ts) → document_type_slug, category
  ↓
Embeddings (embeddings.ts) → vectors
  ↓
Supabase Upsert (importer.ts) → legislation_documents
  ↓
Qdrant Upsert (qdrantRagClient.ts) → lexery_legislation_acts, lexery_legislation_chunks
  ↓
Verify (verify.ts) → sync_health
```

### Ключові файли та відповідальність

#### Entry Point
- **`admin-cli.ts`** — головний CLI з усіма командами (add, update, verify, repair, detect-type-absurdities, тощо)

#### Ingestion Core
- **`lib/importer.ts`** — головний імпортер: `importOne()` — canonical → R2 → AI → embeddings → Supabase → Qdrant → verify
- **`canonical/buildCanonical.ts`** — побудова canonical JSON з raw Rada API даних
- **`canonical/parseUnits.ts`** — парсинг content units (articles/points/chapters) з stru масиву
- **`canonical/chunking.ts`** — генерація chunks з units
- **`canonical/r2Path.ts`** — генерація R2 keys за storage_category

#### Document Type System
- **`documentTypes/guessDocumentTypeV2.ts`** — heuristics-first класифікація (KIND-FIRST logic, prefix-sniff)
- **`documentTypes/documentTypes.ts`** — taxonomy з DocumentTypeSlug enum (30+ типів)
- **`lib/documentTypeEnrichment.ts`** — AI fallback + caching (R2 cache: `legislation/ai_cache/document_type/{fingerprint}.json`)
- **`lib/kindExtractor.ts`** — витягування DocumentKind та DocumentIssuer з prefix (для KIND-FIRST gate)

#### Verification & Repair
- **`commands/verify.ts`** — перевірка консистентності Supabase ↔ Qdrant ↔ R2 (PHASE 18: Invariants V1)
- **`commands/repair-consistency.ts`** — виправлення невідповідностей між Supabase/Qdrant/R2
- **`commands/detect-type-absurdities.ts`** — системний детектор абсурдних класифікацій (10+ правил)
- **`lib/verifyApplicability.ts`** — матриця застосовності verify checks (N/A vs ERROR)

#### Qdrant Integration
- **`lib/qdrantRagClient.ts`** — Qdrant RAG client (upsertChunks, upsertAct, search)
- **`lib/qdrantIds.ts`** — детерміновані UUID IDs: `deterministicUuidFromString("${nreg}|${content_hash}|${chunk_index}")`
- **`lib/qdrantAdmin.ts`** — admin helpers (countByNreg, deleteByNreg)

#### Rada API Client
- **`radaClient.ts`** — клієнт для rada.gov.ua API (fetchJson, fetchTxt, token management, rate limiting)

#### Job Tracking
- **`lib/jobProgress.ts`** — трекінг імпорту через `legislation_import_jobs` (stages, progress_data, resume)

---

## 3) Recent Changes (5 днів)

### Git Commits (2026-01-22 → 2026-01-27)

**Ключові напрямки змін:**

1. **PHASE 4-5 Complete (2026-01-23):**
   - `cc43a22` — health_red=0 + audit 40 docs
   - `6b4e570` — Gate A complete (100 documents + evidence)

2. **PHASE 3.6-3.7 Verify Hardening (2026-01-23):**
   - `5309a29` — verify chunk_index перевірка (0 не є falsy)
   - `22bfb96` — verify фільтрує тільки CURRENT версію (content_hash)
   - `de67fa2` — verify FAIL breakdown + reason codes + NA status
   - `a110ed5` — verify applicability + chunks=0 root fix

3. **PHASE 3.4-3.5 Enrichment Fixes (2026-01-23):**
   - `c688b02` — enrichment root fix + CRITICAL=0
   - `65b3613` — виправлено дублікат оголошення lowerSummary/combinedText

4. **PHASE 3 VR_SPEAKER_ORDER Fix (2026-01-23):**
   - `afe875a` — VR_SPEAKER_ORDER виправлено у Supabase + Qdrant
   - `05b4aee` — VR_SPEAKER_ORDER detection + cache version bump

5. **PHASE 2.5-3.0 Hard Soak (2026-01-22):**
   - `78c05ed` — hard soak collector + batch import with control loops
   - `cde9997` — fix false positive CCU_DECISION_NOT_CCU detector bug

6. **Document Type V2 Backfill (2026-01-22):**
   - `13de67b` — document type v2 backfill + qdrant sync + ui na-vs-error
   - `0bf69ce` — strict document type validation + safe backfill
   - `b81eadb` — prioritize CEC resolution over CMU + enforce semantic validator
   - `08cc702` — root-cause fix for absurd document_type classifications (RNBO/NBU/CEC/President)

### Найчастіше змінювані файли
- `commands/verify.ts` — verify logic, applicability matrix, reason codes
- `commands/detect-type-absurdities.ts` — правила детекції абсурдностей
- `lib/documentTypeEnrichment.ts` — AI fallback, cache version bumps
- `documentTypes/guessDocumentTypeV2.ts` — heuristics rules, KIND-FIRST logic
- `lib/importer.ts` — sync_health writing, verify integration

### Потенційно ризикові зміни
1. **Cache version bumps:** `documentTypeEnrichment.ts` — cache version `doc_type_v15` (може потребувати re-cache для старих документів)
2. **Verify applicability matrix:** нові N/A правила можуть приховати реальні проблеми
3. **Qdrant content_hash filtering:** verify тепер фільтрує тільки CURRENT версію (може пропустити старі версії якщо є дублікати)

---

## 4) Known Invariants / Gates

### STOP RULES (як використовуємо verify/detector)

1. **detect-type-absurdities:**
   - CRITICAL findings → не імпортувати до виправлення
   - Правила: RNBO_AS_LAW, PRESIDENTIAL_DECREE_AS_RNBO, CCU_DECISION_NOT_CCU, тощо

2. **verify --write-health:**
   - FAIL → sync_health = 'red'
   - WARN → sync_health = 'yellow'
   - PASS → sync_health = 'green'
   - N/A → sync_health = 'unknown' (або залишається NULL)

### Інваріанти (вже реалізовані)

1. **chunk_index check:**
   - `verify.ts` перевіряє що chunk_index починається з 0 і без пропусків
   - Фільтрує тільки CURRENT версію (content_hash)

2. **expected_chunks logic:**
   - `expected_chunks` має відповідати кількості chunks в canonical JSON
   - `indexed_chunks` має дорівнювати `expected_chunks` (для indexable документів)
   - N/A якщо txtLength < 400 символів (через `hasEnoughTextForChunks`)

3. **Qdrant content_hash filtering:**
   - `verify.ts` фільтрує points тільки з поточним `content_hash` (не старі версії)
   - `repair-consistency.ts` синхронізує payload (category, document_type_slug) між Supabase ↔ Qdrant

4. **document_type_slug NOT NULL:**
   - Інваріант: всі документи мають `document_type_slug` (0 NULL в БД)
   - Валідація через `guessDocumentTypeV2` + `documentTypeEnrichment` (heuristics + AI fallback)

5. **sync_health constraint:**
   - Може бути NULL (52 документи), але не має бути 'red' (0 red в БД) ✅
   - Default 'unknown' виправлявся раніше, але зараз залишається NULL для нових документів

6. **Qdrant IDs determinism:**
   - Act ID: `deterministicUuidFromString("${nreg}|${content_hash}")`
   - Chunk ID: `deterministicUuidFromString("${nreg}|${content_hash}|${chunk_index}")`
   - Забезпечує idempotent upsert (без дублікатів)

7. **R2 canonical structure:**
   - Обов'язкові поля: version, schema_version, metadata (rada_nreg, content_hash, r2_key), content (chunks)
   - `content_hash` — SHA-256 canonical JSON (без ai_enrichment)

---

## 5) Readiness (готовність)

### Що виглядає стабільно ✅

1. **Core ingestion pipeline:**
   - `importOne()` працює end-to-end (Rada → R2 → Supabase → Qdrant)
   - Job tracking + resume працює
   - No-empty-index policy (0 документів з zero_or_null_chunks)

2. **Document type classification:**
   - `guessDocumentTypeV2` + `documentTypeEnrichment` працює стабільно
   - 0 NULL document_type_slug
   - 0 CRITICAL findings в detect-type-absurdities (на 20 перевірених)

3. **Data quality:**
   - 0 NULL в core полях (document_type_slug, category, document_number, r2_key, content_hash)
   - 0 sync_health='red'
   - 76% sync_health='green'

4. **Canonical format:**
   - R2 canonical JSON структура валідна
   - Chunks генеруються коректно (перевірено на n0019525-22: 17 chunks)

5. **Qdrant integration:**
   - Детерміновані IDs забезпечують idempotent upsert
   - `repair-consistency.ts` синхронізує payload

### Що треба робити далі (без реалізації)

1. **sync_health NULL:**
   - 52 документи (22%) без sync_health
   - Запустити `verify --all --write-health` для заповнення

2. **Qdrant sync verification:**
   - Перевірити фактичну кількість points в Qdrant vs `expected_chunks` в Supabase
   - Можливо запустити `repair-consistency --all` для синхронізації payload

3. **Cache invalidation (якщо потрібно):**
   - Якщо змінився `documentTypeEnrichment.ts` cache version → можливо потрібен re-cache для старих документів
   - Але зараз cache version `doc_type_v15` — перевірити чи всі документи мають актуальний cache

4. **Verify full run:**
   - Запустити `verify --all` для всіх 238 документів
   - Перевірити що немає прихованих проблем (особливо для документів з sync_health=NULL)

5. **Document type distribution:**
   - Перевірити чи всі 30+ типів з taxonomy використовуються коректно
   - Особливо рідкісні типи (constitution: 1, vr_speaker_order: 1, тощо)

---

## Додаткові нотатки

### Файли документації (знайдені в репо)
- `README.md` — основна документація
- `SCHEMA_MAP.md` — мапа схеми БД (legislation_documents, legislation_import_jobs, Qdrant collections)
- `VERSIONING_POLICY.md` — політика версіонування (CURRENT VERSION ONLY для Qdrant)
- `FINAL_SUMMARY.md` — підсумок phases 1-7
- `OPERATIONAL_GUIDE.md` — операційний гайд (команди, workflows)
- `CONTEXT_RESTORE_NOTES.md` — цей файл

### Ключові константи
- **Qdrant Collections:** `lexery_legislation_acts`, `lexery_legislation_chunks`
- **R2 Bucket:** `legal-court-decisions` (з .env)
- **R2 Canonical Prefix:** `legislation/{storage_category}/{encoded_nreg}.json`
- **R2 AI Cache Prefix:** `legislation/ai_cache/document_type/{fingerprint}.json`
- **Document Type Cache Version:** `doc_type_v15` (в `documentTypeEnrichment.ts`)

---

**Система готова до продовження роботи.** ✅  
**Основні ризики:** sync_health NULL (52 документи), можливі старі версії в Qdrant (потрібна перевірка).
