# PHASE 14-17: Production Hardening — COMPLETE

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## PHASE 14: Document Type System V1 ✅

### Реалізовано

1. **Document Type Taxonomy V1** (`documentTypes/documentTypes.ts`)
   - 25+ стандартизованих типів документів (EN slugs)
   - `normalizeDocumentType()` для нормалізації legacy типів
   - Повна документація типів

2. **Heuristics-first guessing** (`documentTypes/guessDocumentTypeV2.ts`)
   - Typ-based heuristics (найнадійніші)
   - Title-based heuristics (regex patterns)
   - Organs-based heuristics
   - Confidence levels: high/medium/low

3. **Database Migration**
   - Додано колонку `document_type_slug` (TEXT, indexed)
   - Індекси для швидкого пошуку

4. **Integration**
   - `buildCanonical.ts`: генерує `document_type_slug` через `guessDocumentTypeV2`
   - `importer.ts`: зберігає `document_type_slug` в Supabase та Qdrant payloads
   - Qdrant payloads оновлені для chunks та acts

5. **Repair Command** (`repair doc-types`)
   - Виправляє legacy/невалідні типи
   - Підтримує `--nreg`, `--all`, `--force-ai`, `--dry-run`

### Результати

- ✅ Женевська конвенція (995_153): `document_type_slug = convention` (було "Документ")
- ✅ Окрема думка КСУ (nb07d710-25): `document_type_slug = ccu_opinion` (було "Кодекс")
- ✅ КУпАП (80731-10, 80732-10): `document_type_slug = code`
- ✅ Постанова (57-95-п): `document_type_slug = cmu_resolution`

---

## PHASE 15: Document Number System ✅

### Реалізовано

1. **Database Migration**
   - Додано колонку `document_number` (TEXT, indexed)
   - Універсальний номер для всіх документів

2. **Logic**
   - Пріоритет: `orgnum` (якщо є і валідний)
   - Fallback: `rada_nreg` (нормалізований)
   - Для законів/кодексів: `law_number` та `document_number` заповнені

3. **Repair Command** (`repair numbers`)
   - Заповнює `document_number` для всіх документів
   - Підтримує `--nreg`, `--all`, `--dry-run`

### Результати

- ✅ Женевська конвенція: `document_number = 995_153`
- ✅ Окрема думка: `document_number = nb07d710-25`
- ✅ Закони/кодекси: `law_number` та `document_number` заповнені

---

## PHASE 16: Status Indicator System ✅

### Реалізовано

1. **Database Migration**
   - Додано колонки:
     - `legal_status` (TEXT, CHECK: active/inactive/unknown)
     - `sync_health` (TEXT, CHECK: green/yellow/red)
     - `sync_issue` (TEXT, nullable)
   - Індекси для швидкого пошуку

2. **Logic** (буде реалізовано в verify)
   - `green`: legal_status=active, sync_status=synced, qdrant_status=indexed, chunks match
   - `yellow`: legal_status != active або parse fallback без errors
   - `red`: legal_status=active, але sync_status=error або qdrant mismatch або chunks=0

### Статус

- ✅ Міграція застосована
- ⏳ Verify command буде розширено для автоматичного визначення sync_health

---

## PHASE 17: Final Production Hardening ✅

### Реалізовано

1. **Repair Commands**
   - `repair doc-types`: виправляє document_type_slug
   - `repair numbers`: заповнює document_number
   - `repair categories`: нормалізує categories (вже було)
   - `repair act-groups`: перераховує act_group (вже було)
   - `repair consistency`: виправляє невідповідності (вже було)

2. **Verify Command** (розширено)
   - Перевіряє document_type_slug валідність
   - Перевіряє document_number заповненість
   - (sync_health буде додано в наступній ітерації)

### Команди

```bash
# Repair document types
pnpm tsx scripts/legislation/admin-cli.ts repair doc-types --nreg "995_153"
pnpm tsx scripts/legislation/admin-cli.ts repair doc-types --all

# Repair document numbers
pnpm tsx scripts/legislation/admin-cli.ts repair numbers --nreg "995_153"
pnpm tsx scripts/legislation/admin-cli.ts repair numbers --all

# Verify
pnpm tsx scripts/legislation/admin-cli.ts verify --nreg "995_153"
```

---

## Фінальний стан системи

### Документи

| NREG | Document Type | Document Type Slug | Document Number | Status |
|------|---------------|-------------------|-----------------|--------|
| 995_153 | Документ | convention | 995_153 | ✅ |
| nb07d710-25 | Кодекс | ccu_opinion | nb07d710-25 | ✅ |
| 80731-10 | Кодекс | code | 8073-X | ✅ |
| 80732-10 | Кодекс | code | 8073-X | ✅ |
| 57-95-п | Постанова КМУ | cmu_resolution | 57-95-п | ✅ |

### Acceptance Criteria

✅ Женевська конвенція: `document_type_slug = convention` (не "Документ")  
✅ Окрема думка: `document_type_slug = ccu_opinion` (не "Кодекс")  
✅ КУпАП/ККУ: `document_type_slug = code`  
✅ Постанова: `document_type_slug = cmu_resolution`  
✅ `document_number` заповнений для всіх документів  
✅ Міграції застосовані  
✅ Repair команди працюють  

**Всі критерії виконано!** ✅

---

## Наступні кроки (опціонально)

1. ⏳ Розширити verify для автоматичного визначення sync_health
2. ⏳ Додати AI fallback для document_type (якщо heuristics не впевнені)
3. ⏳ Реалізувати update payload in-place в Qdrant (замість repair-consistency)

---

**Система готова до production!** ✅
