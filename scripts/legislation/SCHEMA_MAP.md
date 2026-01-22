# Schema Map — Legislation RAG

**Дата:** 2026-01-21  
**Статус:** ACTIVE

---

## Таблиця: `legislation_documents`

**Primary Key:** `rada_nreg` (VARCHAR, NOT NULL)  
**Total Columns:** 40

### CORE (Must-Have)

| Колонка | Тип | Nullable | Використання | % NULL | Статус |
|---------|-----|----------|--------------|--------|--------|
| `rada_nreg` | VARCHAR | NO | PK, всі файли | 0% | ✅ CORE |
| `title` | VARCHAR | NO | Всі файли | 0% | ✅ CORE |
| `r2_key` | TEXT | NO | R2 pointer, `importer.ts:400+` | 0% | ✅ CORE |
| `source_url` | VARCHAR | NO | `buildCanonical.ts` | 0% | ✅ CORE |
| `content_hash` | VARCHAR | NO | Dedup, `importer.ts:200+` | 0% | ✅ CORE |
| `rada_datred` | DATE | NO | `buildCanonical.ts` | 0% | ✅ CORE |
| `document_type_slug` | TEXT | YES | EN slug, `importer.ts:450+`, `verify.ts` | 0% | ✅ CORE |
| `category` | VARCHAR | YES | EN taxonomy slug, `importer.ts:450+`, `verify.ts` | 0% | ✅ CORE |
| `storage_category` | TEXT | YES | R2 folder, `importer.ts:450+`, `r2Path.ts` | 0% | ✅ CORE |
| `document_number` | TEXT | YES | Універсальний номер, `importer.ts:450+`, `verify.ts` | 0% | ✅ CORE |
| `expected_chunks` | INTEGER | YES | `importer.ts:500+`, `verify.ts` | 0% | ✅ CORE |
| `indexed_chunks` | INTEGER | YES | `importer.ts:500+`, `verify.ts` | 0% | ✅ CORE |
| `qdrant_status` | VARCHAR | YES | `importer.ts:550+`, `verify.ts` | 0% | ✅ CORE |
| `sync_status` | VARCHAR | YES | `importer.ts:550+`, `verify.ts` | 0% | ✅ CORE |
| `imported_at` | TIMESTAMP | NO | `importer.ts:400+` | 0% | ✅ CORE |
| `updated_at` | TIMESTAMP | NO | `importer.ts:400+` | 0% | ✅ CORE |

### OPTIONAL (Conditional)

| Колонка | Тип | Nullable | Використання | % NULL | Статус |
|---------|-----|----------|--------------|--------|--------|
| `rada_dokid` | INTEGER | YES | IDs, `importer.ts:60` | ~50% | ✅ OPTIONAL |
| `previous_hash` | VARCHAR | YES | Versioning, `importer.ts:66` | ~50% | ✅ OPTIONAL |
| `document_type` | VARCHAR | YES | UA label, `buildCanonical.ts`, `repair-document-type-consistency.ts` | 0% | ✅ OPTIONAL |
| `law_number` | VARCHAR | YES | Тільки для законів, `extractLawNumber.ts` | ~50% | ✅ OPTIONAL |
| `act_is_part` | BOOLEAN | YES | `actGrouping.ts`, `importer.ts:450+` | 0% | ✅ OPTIONAL |
| `act_group_key` | TEXT | YES | NULL для одиночних, `actGrouping.ts`, `importer.ts:450+` | ~75% | ✅ OPTIONAL |
| `act_part_label` | TEXT | YES | `actGrouping.ts`, `importer.ts:450+` | ~75% | ✅ OPTIONAL |
| `summary` | TEXT | YES | AI enrichment, `importer.ts:300+` | ~0% | ✅ OPTIONAL |
| `keywords` | JSONB | YES | AI enrichment, `importer.ts:300+` | ~0% | ✅ OPTIONAL |
| `topics` | JSONB | YES | AI enrichment, `importer.ts:300+` | ~0% | ✅ OPTIONAL |
| `aliases` | JSONB | YES | AI enrichment, `importer.ts:300+` | ~0% | ✅ OPTIONAL |

### DEPRECATED / UNUSED

| Колонка | Тип | Nullable | Причина | Статус |
|---------|-----|----------|---------|--------|
| `act_group_title` | TEXT | YES | Не використовується в коді | ⚠️ DEPRECATED |
| `articles_count` | INTEGER | YES | Legacy, можливо дублює expected_chunks | ⚠️ DEPRECATED |
| `chunks_count` | INTEGER | YES | Дублює expected_chunks | ⚠️ DEPRECATED |
| `is_active` | BOOLEAN | YES | Завжди true? | ⚠️ DEPRECATED |
| `auto_update` | BOOLEAN | YES | Не використовується | ⚠️ DEPRECATED |
| `indexed_content_hash` | TEXT | YES | Не використовується | ⚠️ DEPRECATED |
| `last_checked_at` | TIMESTAMP | YES | Не використовується | ⚠️ DEPRECATED |
| `last_sync_error` | TEXT | YES | Не використовується | ⚠️ DEPRECATED |
| `qdrant_indexed_at` | TIMESTAMP | YES | Не використовується | ⚠️ DEPRECATED |

### NOT FILLED (Future)

| Колонка | Тип | Nullable | Причина | Статус |
|---------|-----|----------|---------|--------|
| `legal_status` | TEXT | YES | Міграція є, але не заповнюється | ⚠️ NOT FILLED |
| `sync_health` | TEXT | YES | Міграція є, але не заповнюється | ⚠️ NOT FILLED |
| `sync_issue` | TEXT | YES | Міграція є, але не заповнюється | ⚠️ NOT FILLED |

---

## Таблиця: `legislation_import_jobs`

**Primary Key:** `id` (UUID, NOT NULL)  
**Total Columns:** 12

### CORE

| Колонка | Тип | Nullable | Використання | Статус |
|---------|-----|----------|--------------|--------|
| `id` | UUID | NO | PK | ✅ CORE |
| `status` | VARCHAR | NO | `jobProgress.ts` | ✅ CORE |
| `created_at` | TIMESTAMP | YES | Автоматично | ✅ CORE |

### OPTIONAL

| Колонка | Тип | Nullable | Використання | Статус |
|---------|-----|----------|--------------|--------|
| `total_count` | INTEGER | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `processed_count` | INTEGER | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `success_count` | INTEGER | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `error_count` | INTEGER | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `started_at` | TIMESTAMP | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `completed_at` | TIMESTAMP | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `error_message` | TEXT | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `config` | JSONB | YES | `jobProgress.ts` | ✅ OPTIONAL |
| `progress_data` | JSONB | YES | `jobProgress.ts` | ✅ OPTIONAL |

---

## Qdrant Collections

### `lexery_legislation_acts`

**Payload Schema (MUST):**
- `rada_nreg` (string) — PK filter
- `content_hash` (string) — versioning
- `title` (string)
- `category` (string) — EN taxonomy slug
- `document_type` (string) — UA label
- `document_type_slug` (string) — EN slug (PHASE 14)
- `rada_datred` (string)
- `source_url` (string)
- `r2_key` (string)
- `summary` (string)
- `keywords` (string[])
- `topics` (string[])
- `aliases` (string[])
- `act_group_key` (string | null) — PHASE 5
- `act_part_label` (string | null) — PHASE 5
- `previous_hash` (string | null)

**Point ID:** `deterministicUuidFromString("${nreg}|${content_hash}")`  
**Expected Count:** 1 per document (current version only)

### `lexery_legislation_chunks`

**Payload Schema (MUST):**
- `rada_nreg` (string) — PK filter
- `content_hash` (string) — versioning
- `chunk_index` (number) — порядковий номер
- `article_number` (string | null)
- `token_count` (number | null)
- `r2_key` (string)
- `json_path` (string) — path в canonical JSON
- `category` (string) — EN taxonomy slug
- `document_type` (string) — UA label
- `document_type_slug` (string) — EN slug (PHASE 14)
- `rada_datred` (string)
- `title` (string)
- `source_url` (string)
- `previous_hash` (string | null)
- `act_group_key` (string | null) — PHASE 5
- `act_part_label` (string | null) — PHASE 5

**Point ID:** `deterministicUuidFromString("${nreg}|${content_hash}|${chunk_index}")`  
**Expected Count:** `expected_chunks` per document (current version only)

---

## Правила

### Заборона нових колонок

**До створення SCHEMA_MAP:** Дозволено додавати колонки  
**Після створення SCHEMA_MAP:** Нові колонки тільки після явного погодження

### Deprecated поля

- Не використовувати в новому коді
- Не видаляти без міграції
- Позначати в документації як DEPRECATED

### Not Filled поля

- Або заповнити логікою
- Або видалити якщо не потрібні
- Не залишати "на майбутнє" без плану

---

**Ця мапа відповідає поточному стану схеми (2026-01-21).** ✅
