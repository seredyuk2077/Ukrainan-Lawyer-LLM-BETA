# Schema Audit — legislation_documents

**Дата:** 2026-01-21  
**Статус:** 🔴 ПРОБЛЕМИ ВИЯВЛЕНО

---

## C1: Schema Reality Check

### Поточна схема (40 колонок)

| Колонка | Тип | Nullable | Статус | Використання | Заповнюється |
|---------|-----|----------|--------|--------------|--------------|
| **MUST-HAVE CORE** | | | | | |
| `rada_nreg` | VARCHAR | NO | ✅ MUST | PK, всі файли | ✅ 100% |
| `rada_dokid` | INTEGER | YES | ✅ OPTIONAL | IDs, importer.ts | ✅ Якщо є |
| `title` | VARCHAR | NO | ✅ MUST | Всі файли | ✅ 100% |
| `r2_key` | TEXT | NO | ✅ MUST | R2 pointer, importer.ts | ✅ 100% |
| `source_url` | VARCHAR | NO | ✅ MUST | buildCanonical.ts | ✅ 100% |
| `content_hash` | VARCHAR | NO | ✅ MUST | Dedup, importer.ts | ✅ 100% |
| `previous_hash` | VARCHAR | YES | ✅ OPTIONAL | Versioning, importer.ts | ✅ Якщо є |
| `rada_datred` | DATE | NO | ✅ MUST | buildCanonical.ts | ✅ 100% |
| **TYPES & CATEGORIES** | | | | | |
| `document_type` | VARCHAR | YES | ⚠️ DUPLICATE | UA label, buildCanonical.ts | ✅ 100% |
| `document_type_slug` | TEXT | YES | ✅ MUST | EN slug, importer.ts | ❌ 5/8 (62%) |
| `category` | VARCHAR | YES | ⚠️ CONFUSION | Використовується як slug, importer.ts | ✅ 100% |
| `storage_category` | TEXT | YES | ✅ MUST | R2 folder, importer.ts | ✅ 100% |
| **NUMBERS** | | | | | |
| `document_number` | TEXT | YES | ✅ MUST | Універсальний номер, importer.ts | ❌ 5/8 (62%) |
| `law_number` | VARCHAR | YES | ✅ OPTIONAL | Тільки для законів, extractLawNumber.ts | ✅ Якщо є |
| **CHUNKS & INDEXING** | | | | | |
| `expected_chunks` | INTEGER | YES | ✅ MUST | importer.ts | ✅ 100% |
| `indexed_chunks` | INTEGER | YES | ✅ MUST | importer.ts | ✅ 100% |
| `qdrant_status` | VARCHAR | YES | ✅ MUST | importer.ts | ✅ 100% |
| `sync_status` | VARCHAR | YES | ✅ MUST | importer.ts | ✅ 100% |
| **ACT GROUPS** | | | | | |
| `act_is_part` | BOOLEAN | YES | ✅ MUST | actGrouping.ts, importer.ts | ✅ 100% |
| `act_group_key` | TEXT | YES | ✅ MUST | NULL для одиночних, importer.ts | ✅ 2/8 (25%) |
| `act_part_label` | TEXT | YES | ✅ OPTIONAL | actGrouping.ts | ✅ Якщо multi-part |
| `act_group_title` | TEXT | YES | ⚠️ UNUSED | actGrouping.ts | ❌ Не використовується |
| **HEALTH/OPS** | | | | | |
| `legal_status` | TEXT | YES | ⚠️ NOT FILLED | Міграція є, але не заповнюється | ❌ 0/8 (0%) |
| `sync_health` | TEXT | YES | ⚠️ NOT FILLED | Міграція є, але не заповнюється | ❌ 0/8 (0%) |
| `sync_issue` | TEXT | YES | ⚠️ NOT FILLED | Міграція є, але не заповнюється | ❌ 0/8 (0%) |
| **LEGACY/UNUSED** | | | | | |
| `articles_count` | INTEGER | YES | ⚠️ LEGACY | Можливо не використовується | ❓ |
| `chunks_count` | INTEGER | YES | ⚠️ DUPLICATE | Дублює expected_chunks? | ❓ |
| `is_active` | BOOLEAN | YES | ⚠️ UNUSED | Завжди true? | ❓ |
| `auto_update` | BOOLEAN | YES | ⚠️ UNUSED | Не використовується? | ❓ |
| `indexed_content_hash` | TEXT | YES | ⚠️ UNUSED | Не використовується? | ❓ |
| `last_checked_at` | TIMESTAMP | YES | ⚠️ UNUSED | Не використовується? | ❓ |
| `last_sync_error` | TEXT | YES | ⚠️ UNUSED | Не використовується? | ❓ |
| `imported_at` | TIMESTAMP | NO | ✅ MUST | buildCanonical.ts | ✅ 100% |
| `updated_at` | TIMESTAMP | NO | ✅ MUST | buildCanonical.ts | ✅ 100% |
| `summary` | TEXT | YES | ✅ OPTIONAL | AI enrichment, importer.ts | ✅ Якщо є |
| `keywords` | JSONB | YES | ✅ OPTIONAL | AI enrichment, importer.ts | ✅ Якщо є |
| `topics` | JSONB | YES | ✅ OPTIONAL | AI enrichment, importer.ts | ✅ Якщо є |
| `aliases` | JSONB | YES | ✅ OPTIONAL | AI enrichment, importer.ts | ✅ Якщо є |
| `qdrant_indexed_at` | TIMESTAMP | YES | ⚠️ UNUSED | Не використовується? | ❓ |

---

## Проблеми виявлені

### 🔴 КРИТИЧНІ

1. **NULL в must-have полях:**
   - `document_type_slug`: 3/8 документів (2341-14, 254к/96-вр, 3543-12)
   - `document_number`: 3/8 документів (2341-14, 254к/96-вр, 3543-12)

2. **Дублювання полів:**
   - `document_type` (UA) + `document_type_slug` (EN) — обидва потрібні, але мають бути консистентні
   - `category` використовується як slug (добре), але немає окремого `category_slug`
   - `chunks_count` vs `expected_chunks` — дублювання?

3. **Незаповнені поля:**
   - `legal_status`: 0/8 (0%)
   - `sync_health`: 0/8 (0%)
   - `sync_issue`: 0/8 (0%)

4. **Невикористані поля:**
   - `act_group_title`: не використовується в коді
   - `articles_count`: можливо legacy
   - `chunks_count`: можливо дублює expected_chunks
   - `is_active`: завжди true?
   - `auto_update`: не використовується?
   - `indexed_content_hash`: не використовується?
   - `last_checked_at`: не використовується?
   - `last_sync_error`: не використовується?
   - `qdrant_indexed_at`: не використовується?

---

## План виправлення

### Крок 1: Backfill must-have полів
- Заповнити `document_type_slug` для всіх документів
- Заповнити `document_number` для всіх документів
- Перевірити консистентність `category` (має бути EN slug)

### Крок 2: Виправити repair команди
- Додати `.select()` та перевірку результатів
- Логувати before→after

### Крок 3: Вирішити дублювання
- `category` = `category_slug` (використовується як slug, це OK)
- `document_type` + `document_type_slug` = обидва потрібні (UA label + EN slug)

### Крок 4: Видалити/позначити unused поля
- Позначити deprecated поля в документації
- Або видалити якщо точно не потрібні

### Крок 5: Заповнити health/ops поля
- Або заповнити логікою
- Або видалити якщо не потрібні

---

## Definition of Done

Для тестових документів:
- ✅ `document_type_slug` NOT NULL
- ✅ `document_number` NOT NULL  
- ✅ `category` = EN slug (не UA)
- ✅ `storage_category` NOT NULL
- ✅ `act_group_key` = NULL для одиночних
- ✅ `indexed_chunks` == `expected_chunks`
- ✅ Qdrant points == `indexed_chunks`
- ✅ R2 canonical exists
