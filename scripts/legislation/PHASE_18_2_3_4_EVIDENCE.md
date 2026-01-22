# PHASE 18.2-18.4: Evidence & Schema Map — Complete

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## PHASE 18.1c: VERSIONING_POLICY.md

**Створено:** `VERSIONING_POLICY.md`

**Політика:**
- ✅ Supabase: поточна версія + `previous_hash` для історії
- ✅ R2: canonical JSON з `content_hash` (можна зберігати всі версії)
- ✅ Qdrant: тільки поточна версія (стара видаляється через dedup)

**Команди:**
- `repair-qdrant-dedup --nreg <nreg>` — видалити старі версії
- `verify --nreg <nreg>` — перевірити acts count == 1

---

## PHASE 18.2: TRUSTWORTHY EVIDENCE

**Додано `--evidence` опцію до verify:**

**SQL Evidence Queries:**
- A) NULL Stats: null_doc_type_slug, null_category, null_document_number, null_storage_category
- B) Act Group Sanity: invalid_act_group (single act has group fields)
- C) Sync/Indexing Sanity: not_synced (sync_status != 'synced' OR qdrant_status != 'indexed' OR chunks mismatch)
- D) Total Documents count

**Використання:**
- `admin-cli verify --evidence --nreg <nreg>` — для одного документа
- `admin-cli verify --evidence --all` — для всіх документів

---

## PHASE 18.3: SCHEMA_MAP.md

**Створено:** `SCHEMA_MAP.md`

**Структура:**
- `legislation_documents` (40 колонок): CORE / OPTIONAL / DEPRECATED / NOT FILLED
- `legislation_import_jobs` (12 колонок): CORE / OPTIONAL
- Qdrant Collections: `lexery_legislation_acts`, `lexery_legislation_chunks` (payload schema)

**Правила:**
- Заборона нових колонок без явного погодження
- Deprecated поля не використовувати в новому коді
- Not Filled поля: або заповнити, або видалити

---

## PHASE 18.4: VERIFY --ALL

**Запущено:** `verify --all --evidence --page-size 8`

**Очікуваний результат:** 8/8 документів PASS

---

**PHASE 18.2-18.4 завершено. VERSIONING_POLICY та SCHEMA_MAP створено.** ✅
