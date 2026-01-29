# Evidence Report — Schema Fix & Invariants

**Дата:** 2026-01-21  
**Статус:** ✅ ВИПРАВЛЕНО + EVIDENCE ПРЕДСТАВЛЕНО

---

## C1: Schema Audit Results

### Must-Have Fields Status

| Field | Total Docs | Has Value | Missing | Status |
|-------|------------|-----------|---------|--------|
| `document_type_slug` | 8 | 8 | 0 | ✅ 100% |
| `document_number` | 8 | 8 | 0 | ✅ 100% |
| `category` | 8 | 8 | 0 | ✅ 100% |
| `storage_category` | 8 | 8 | 0 | ✅ 100% |

**SQL Evidence:**
```sql
SELECT 
  COUNT(*) as total,
  COUNT(document_type_slug) as has_doc_type_slug,
  COUNT(document_number) as has_document_number,
  COUNT(category) as has_category,
  COUNT(storage_category) as has_storage_category
FROM legislation_documents;
-- Result: total=8, has_doc_type_slug=8, has_document_number=8, has_category=8, has_storage_category=8
```

---

## C2: Test Documents — Final State

### SQL Evidence (підтверджено через MCP)

| NREG | Document Type Slug | Document Number | Category | Storage Category | Act Group Key | Expected Chunks | Indexed Chunks | Qdrant Status |
|------|-------------------|-----------------|----------|------------------|---------------|-----------------|----------------|---------------|
| 2341-14 | **code** | **2341-III** | criminal | criminal | NULL | 943 | 943 | indexed |
| 254к/96-вр | **constitution** | **254к/96-вр** | constitutional | constitutional | NULL | 172 | 172 | indexed |
| 57-95-п | **cmu_resolution** | **57-95-п** | border_migration | other | NULL | 69 | 69 | indexed |
| 80731-10 | **code** | **8073-X** | administrative_offenses | administrative | **кодекс-україни-про-адміністративні-правопорушення-03bf457103ce4485** | 795 | 795 | error* |
| 80732-10 | **code** | **8073-X** | administrative_offenses | administrative | **кодекс-україни-про-адміністративні-правопорушення-03bf457103ce4485** | 242 | 242 | indexed |
| 995_153 | **convention** | **995_153** | international_eu | other | NULL | 170 | 170 | indexed |
| nb07d710-25 | **ccu_opinion** | **nb07d710-25** | constitutional | administrative | NULL | 14 | 14 | indexed |

*Примітка: 80731-10 має qdrant_status='error', але indexed_chunks=795, що означає що chunks є в Qdrant.

---

## C3: Invariant Checks

### ✅ Supabase Invariants

**1. Must-have fields NOT NULL:**
```sql
SELECT COUNT(*) FROM legislation_documents
WHERE document_type_slug IS NULL 
   OR document_number IS NULL
   OR category IS NULL
   OR storage_category IS NULL;
-- Result: 0 (PASS)
```

**2. Act group sanity:**
```sql
SELECT COUNT(*) FROM legislation_documents
WHERE (act_is_part = false OR act_is_part IS NULL)
  AND (act_group_key IS NOT NULL OR act_part_label IS NOT NULL);
-- Result: 0 (PASS)
```

**3. Document type slug validity:**
- ✅ Женевська конвенція: `convention` (не "Документ")
- ✅ Окрема думка: `ccu_opinion` (не "Кодекс")
- ✅ КУпАП: `code` (правильно)
- ✅ Постанова: `cmu_resolution` (правильно)

**4. Category validity (EN slugs):**
- ✅ Всі categories = EN taxonomy slugs (не UA)
- ✅ Немає "інше" для важливих документів

**5. Chunks consistency:**
```sql
SELECT rada_nreg, expected_chunks, indexed_chunks
FROM legislation_documents
WHERE expected_chunks != indexed_chunks;
-- Result: 0 rows (PASS)
```

### ✅ Cross-Store Invariants

**1. R2 canonical exists:**
- ✅ Всі документи мають `r2_key` NOT NULL
- ✅ `storage_category` витягнуто з `r2_key`

**2. Qdrant points count:**
- ⏳ Потрібно перевірити через verify команду

**3. Act group consistency:**
- ✅ 80731-10 та 80732-10 мають однаковий `act_group_key`
- ✅ Одиночні акти мають `act_group_key = NULL`

---

## C4: Repair Commands — Fixed

### Виправлення

1. **repair-doc-types.ts:**
   - ✅ Додано `.select()` для отримання оновлених даних
   - ✅ Перевірка `updateData !== null`
   - ✅ Перевірка що значення справді змінилось
   - ✅ Логування before→after

2. **repair-numbers.ts:**
   - ✅ Аналогічні перевірки
   - ✅ Логування before→after

### Evidence з repair команд

**2341-14:**
```
Old: document_type="Кодекс", slug=null
New: slug=code (high, heuristics)
→ Updated Supabase: document_type_slug=code
```

**2341-14 (numbers):**
```
Old: document_number=null
New: document_number=2341-III
→ Updated: document_number=2341-III
```

---

## C5: Definition of Done — Status

### Тестові документи

| Критерій | 2341-14 | 254к/96-вр | 57-95-п | 80731-10 | 80732-10 | 995_153 | nb07d710-25 | Status |
|----------|---------|------------|---------|----------|----------|---------|-------------|--------|
| document_type_slug заповнений | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| document_type_slug логічний | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| category_slug заповнений (EN) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| document_number заповнений | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| act_group_key правильний | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| indexed_chunks == expected_chunks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| qdrant_status = indexed | ✅ | ✅ | ✅ | ⚠️ error* | ✅ | ✅ | ✅ | ⚠️ |
| sync_status = synced | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

*80731-10 має qdrant_status='error', але indexed_chunks=795, що означає що chunks є в Qdrant. Потрібно перевірити через verify.

---

## Проблеми що лишились

1. ⚠️ **80731-10 qdrant_status='error'** — потрібно перевірити через verify
2. ⚠️ **legal_status, sync_health, sync_issue** — не заповнені (0/8). Потрібно або заповнити логікою, або видалити якщо не потрібні.

---

## Наступні кроки

1. Перевірити 80731-10 через verify команду
2. Вирішити що робити з legal_status/sync_health/sync_issue (заповнити або видалити)
3. Перевірити Qdrant points count для всіх тестових документів
