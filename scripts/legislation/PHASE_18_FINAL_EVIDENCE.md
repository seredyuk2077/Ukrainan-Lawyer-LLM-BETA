# PHASE 18: Final Production Hardening — Complete Evidence

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## PHASE 18.1c: VERSIONING_POLICY.md

**Файл:** `VERSIONING_POLICY.md`

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

**SQL Evidence Queries (виконано через MCP):**

### A) NULL Stats
```sql
SELECT
  COUNT(*) FILTER (WHERE document_type_slug IS NULL) as null_doc_type_slug,
  COUNT(*) FILTER (WHERE category IS NULL) as null_category,
  COUNT(*) FILTER (WHERE document_number IS NULL) as null_document_number,
  COUNT(*) FILTER (WHERE storage_category IS NULL) as null_storage_category,
  COUNT(*) as total_docs
FROM legislation_documents;
```

**Результат:**
- `null_doc_type_slug`: **0**
- `null_category`: **0**
- `null_document_number`: **0**
- `null_storage_category`: **0**
- `total_docs`: **8**

### B) Act Group Sanity
```sql
SELECT COUNT(*) as invalid_act_group
FROM legislation_documents
WHERE act_is_part = false AND (act_group_key IS NOT NULL OR act_part_label IS NOT NULL);
```

**Результат:**
- `invalid_act_group`: **0**

### C) Sync/Indexing Sanity
```sql
SELECT COUNT(*) as not_synced
FROM legislation_documents
WHERE sync_status != 'synced' OR qdrant_status != 'indexed' OR expected_chunks != indexed_chunks;
```

**Результат:**
- `not_synced`: **0**

---

## PHASE 18.3: SCHEMA_MAP.md

**Файл:** `SCHEMA_MAP.md`

**Структура:**
- `legislation_documents` (40 колонок): CORE (16) / OPTIONAL (11) / DEPRECATED (9) / NOT FILLED (3)
- `legislation_import_jobs` (12 колонок): CORE (3) / OPTIONAL (9)
- Qdrant Collections: payload schema для `lexery_legislation_acts` та `lexery_legislation_chunks`

**Правила:**
- ✅ Заборона нових колонок без явного погодження
- ✅ Deprecated поля не використовувати в новому коді
- ✅ Not Filled поля: або заповнити, або видалити

---

## PHASE 18.4: VERIFY --ALL

**Запущено:** `verify --all --evidence --page-size 8`

**Результат:**

### Verify Summary
- **Total:** 8
- **PASS:** 8
- **FAIL:** 0

### SQL Evidence (підтверджено через CLI)
- **A) NULL Stats (total=8):**
  - `null_doc_type_slug`: 0
  - `null_category`: 0
  - `null_document_number`: 0
  - `null_storage_category`: 0

- **B) Act Group Sanity:**
  - `invalid_act_group`: 0

- **C) Sync/Indexing Sanity:**
  - `not_synced`: 0

- **D) Total Documents:** 8

---

## Фінальна перевірка — 8 тестових документів

| NREG | PASS | FAIL | Status |
|------|------|------|--------|
| 2341-14 | 22 | 0 | ✅ All checks passed! |
| 254к/96-вр | 22 | 0 | ✅ All checks passed! |
| 3543-12 | 22 | 0 | ✅ All checks passed! |
| 57-95-п | 22 | 0 | ✅ All checks passed! |
| 80731-10 | 22 | 0 | ✅ All checks passed! |
| 80732-10 | 22 | 0 | ✅ All checks passed! |
| 995_153 | 22 | 0 | ✅ All checks passed! |
| nb07d710-25 | 22 | 0 | ✅ All checks passed! |

**Результат:** 8/8 документів PASS ✅

---

## Definition of Done — PASS

✅ **VERSIONING_POLICY.md існує** і відповідає dedup діям  
✅ **SCHEMA_MAP.md існує** і показує CORE/OPTIONAL/DEPRECATED  
✅ **verify --all дає 0 FAIL** (8/8 PASS)  
✅ **Не додано нових колонок** "на всякий випадок"  
✅ **Acts count mismatch = 0** (8/8 мають acts=1)  
✅ **SQL Evidence підтверджено** (цифри, не слова)

---

**PHASE 18 завершено. Всі 8 тестових документів PASS. Evidence підтверджено цифрами.** ✅
