# Document Type Field Matrix — N/A vs ERROR

**Дата:** 2026-01-22  
**Мета:** Визначити які поля required/optional/not-applicable для кожного типу документа

---

## Матриця застосовності полів

### law_number

| Document Type Slug | Required | Not Applicable | Правило |
|-------------------|----------|----------------|---------|
| `law` | ✅ | ❌ | Закон має мати law_number |
| `code` | ✅ | ❌ | Кодекс має мати law_number |
| `constitution` | ❌ | ✅ | Конституція не має law_number |
| `cmu_resolution` | ⚠️ | ❌ | Постанова КМУ може мати law_number (якщо про затвердження закону) |
| `vr_resolution` | ⚠️ | ❌ | Постанова ВР може мати law_number |
| `presidential_decree` | ⚠️ | ❌ | Указ може мати law_number |
| `presidential_order` | ❌ | ✅ | Розпоряження Президента не має law_number |
| `minister_order` | ❌ | ✅ | Наказ не має law_number |
| `regulation` | ❌ | ✅ | Положення не має law_number |
| `rules` | ❌ | ✅ | Правила не мають law_number |
| `instruction` | ❌ | ✅ | Інструкція не має law_number |
| `convention` | ❌ | ✅ | Конвенція не має law_number |
| `international_treaty` | ❌ | ✅ | Міжнародний договір не має law_number |
| `protocol` | ❌ | ✅ | Протокол не має law_number |
| `ccu_opinion` | ❌ | ✅ | Окрема думка КСУ не має law_number |
| `ccu_decision` | ❌ | ✅ | Рішення КСУ не має law_number |
| `court_opinion` | ❌ | ✅ | Окрема думка судді не має law_number |
| `other` | ❌ | ✅ | Інше не має law_number |

**Правила для UI:**
- **Required (law, code):** Якщо NULL → показувати "🔴 ERROR(NULL)"
- **Optional (cmu_resolution, vr_resolution, presidential_decree):** Якщо NULL → показувати "—" (N/A)
- **Not Applicable (convention, ccu_opinion, etc):** Завжди показувати "—" (N/A), навіть якщо law_number є

---

## Реалізація в VIEW

### law_number_ui

```sql
CASE
  -- Not Applicable: convention, ccu_opinion, ccu_decision, court_opinion, presidential_order, minister_order, regulation, rules, instruction, international_treaty, protocol, other
  WHEN document_type_slug IN ('convention', 'ccu_opinion', 'ccu_decision', 'court_opinion', 'presidential_order', 'minister_order', 'regulation', 'rules', 'instruction', 'international_treaty', 'protocol', 'other') THEN '—'
  -- Required: law, code
  WHEN document_type_slug IN ('law', 'code') THEN 
    CASE 
      WHEN law_number IS NULL THEN '🔴 ERROR(NULL)'
      ELSE law_number::text
    END
  -- Optional: cmu_resolution, vr_resolution, presidential_decree, constitution
  WHEN document_type_slug IN ('cmu_resolution', 'vr_resolution', 'presidential_decree', 'constitution') THEN 
    COALESCE(law_number::text, '—')
  -- Fallback
  ELSE COALESCE(law_number::text, '—')
END AS law_number_ui
```

---

## document_type (UA label)

**Required для ВСІХ документів** (якщо document_type_slug не NULL):
- Якщо `document_type_slug IS NOT NULL` і `document_type IS NULL` → ERROR(NULL)
- Якщо `document_type_slug IS NULL` → document_type може бути NULL (unknown)

**Правило:** document_type має відповідати document_type_slug через taxonomy.

---

## document_type_slug

**Required для ВСІХ документів:**
- Якщо NULL → ERROR(NULL) (впливає на health)

---

## category

**Required для ВСІХ документів:**
- Якщо NULL → ERROR(NULL) (впливає на health)

---

## document_number

**Required для ВСІХ документів:**
- Якщо NULL → ERROR(NULL) (впливає на health)

---

## storage_category

**Required для ВСІХ документів:**
- Якщо NULL → ERROR(NULL) (впливає на health)

---

## Приклади

### Convention (law_number не застосовне)
- `law_number_ui` = "—" (N/A)
- `document_type` = "Конвенція" (required)
- `document_type_slug` = "convention" (required)

### CCU Opinion (law_number не застосовне)
- `law_number_ui` = "—" (N/A)
- `document_type` = "Окрема думка судді КСУ" (required)
- `document_type_slug` = "ccu_opinion" (required)

### Law без law_number (ERROR)
- `law_number_ui` = "🔴 ERROR(NULL)"
- `document_type` = "Закон" (required)
- `document_type_slug` = "law" (required)

### CMU Resolution з law_number (optional)
- `law_number_ui` = law_number або "—" (якщо NULL)
- `document_type` = "Постанова КМУ" (required)
- `document_type_slug` = "cmu_resolution" (required)
