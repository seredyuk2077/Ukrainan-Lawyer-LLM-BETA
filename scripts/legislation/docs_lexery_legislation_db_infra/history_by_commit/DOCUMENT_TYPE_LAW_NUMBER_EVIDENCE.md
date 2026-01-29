# Document Type & Law Number — Evidence Report

**Дата:** 2026-01-21  
**Статус:** ✅ ВСЕ ВИПРАВЛЕНО

---

## Проблема виявлена

1. **995_153:** `document_type='Документ'` але `document_type_slug='convention'` — неконсистентно
2. **nb07d710-25:** `document_type='Кодекс'` але `document_type_slug='ccu_opinion'` — неконсистентно

---

## Виправлення

### SQL Update (виконано через MCP)

```sql
UPDATE legislation_documents
SET document_type = CASE document_type_slug
  WHEN 'convention' THEN 'Конвенція'
  WHEN 'ccu_opinion' THEN 'Окрема думка судді КСУ'
  ...
END
WHERE document_type_slug IS NOT NULL
  AND document_type != correct_value;
```

**Результат:**
- ✅ 995_153: `document_type` оновлено з "Документ" на "Конвенція"
- ✅ nb07d710-25: `document_type` оновлено з "Кодекс" на "Окрема думка судді КСУ"

---

## Фінальна перевірка — SQL Evidence

### Test Documents — Final State

| NREG | Document Type | Document Type Slug | Consistency | Law Number | Law Number Check |
|------|---------------|-------------------|-------------|------------|------------------|
| 2341-14 | Кодекс | code | ✅ OK | 2341-III | ✅ OK |
| 254к/96-вр | Конституція | constitution | ✅ OK | NULL | ✅ OK |
| 57-95-п | Постанова КМУ | cmu_resolution | ✅ OK | 57-95-п | ✅ OK |
| 80731-10 | Кодекс | code | ✅ OK | 8073-X | ✅ OK |
| 80732-10 | Кодекс | code | ✅ OK | 8073-X | ✅ OK |
| 995_153 | **Конвенція** | convention | ✅ OK | NULL | ✅ OK |
| nb07d710-25 | **Окрема думка судді КСУ** | ccu_opinion | ✅ OK | NULL | ✅ OK |

**SQL Query:**
```sql
SELECT 
  rada_nreg, document_type, document_type_slug, law_number,
  CASE 
    WHEN (document_type_slug = 'convention' AND document_type != 'Конвенція') THEN 'INCONSISTENT'
    WHEN (document_type_slug = 'ccu_opinion' AND document_type != 'Окрема думка судді КСУ') THEN 'INCONSISTENT'
    ...
    ELSE 'OK'
  END as consistency_check,
  CASE 
    WHEN document_type_slug IN ('law', 'code', 'cmu_resolution') 
         AND law_number IS NULL THEN 'SHOULD_HAVE law_number'
    WHEN document_type_slug IN ('convention', 'ccu_opinion') 
         AND law_number IS NOT NULL THEN 'SHOULD_NOT_HAVE law_number'
    ELSE 'OK'
  END as law_number_check
FROM legislation_documents
WHERE rada_nreg IN (...);
```

**Result:** Всі документи: `consistency_check='OK'`, `law_number_check='OK'` ✅

---

## Статистика (всі документи)

**SQL Evidence:**
```sql
SELECT 
  COUNT(*) as total,
  COUNT(CASE WHEN document_type IS NULL THEN 1 END) as missing_document_type,
  COUNT(CASE WHEN document_type_slug IS NULL THEN 1 END) as missing_document_type_slug,
  COUNT(CASE 
    WHEN document_type_slug = 'convention' AND document_type != 'Конвенція' THEN 1
    WHEN document_type_slug = 'ccu_opinion' AND document_type != 'Окрема думка судді КСУ' THEN 1
    ...
  END) as inconsistent_count
FROM legislation_documents;
```

**Result:**
- Total: 8
- missing_document_type: **0** ✅
- missing_document_type_slug: **0** ✅
- inconsistent_count: **0** ✅

**Law Number Check:**
```sql
SELECT 
  COUNT(CASE 
    WHEN document_type_slug IN ('law', 'code', 'cmu_resolution') 
         AND law_number IS NULL THEN 1
  END) as missing_law_number_for_laws,
  COUNT(CASE 
    WHEN document_type_slug IN ('convention', 'ccu_opinion') 
         AND law_number IS NOT NULL THEN 1
  END) as unexpected_law_number
FROM legislation_documents;
```

**Result:**
- missing_law_number_for_laws: **0** ✅
- unexpected_law_number: **0** ✅

---

## Висновок

### ✅ Document Type
- ✅ Всі документи мають `document_type` (8/8)
- ✅ Всі документи мають `document_type_slug` (8/8)
- ✅ `document_type` консистентний з `document_type_slug` (0 inconsistent)
- ✅ Source of truth: `document_type_slug` (EN), `document_type` = UA label з taxonomy

### ✅ Law Number
- ✅ Для законів/кодексів/постанов: `law_number` заповнений
- ✅ Для конвенцій/окремих думок: `law_number` = NULL (правильно)
- ✅ `document_number` заповнений для всіх (універсальний номер)

---

## Repair Command

Створено `repair doc-type-consistency` для майбутнього використання:
```bash
pnpm tsx scripts/legislation/admin-cli.ts repair doc-type-consistency --all
```

**ВСЕ ВИПРАВЛЕНО. EVIDENCE ПРЕДСТАВЛЕНО.** ✅
