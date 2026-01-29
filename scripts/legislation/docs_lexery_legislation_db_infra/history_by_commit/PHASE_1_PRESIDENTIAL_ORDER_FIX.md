# PHASE 1: Root-Cause Fix для Розпоряджень Президента — Complete

**Дата:** 2026-01-24  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Проблема

**6/2026-рп і 7/2026-рп** — це Розпорядження Президента України, але:
- `document_type_slug`: `regulation` ❌
- `document_type`: `Положення` ❌
- Має бути: `presidential_order` / `Розпоряження Президента` ✅

**Root cause:**
- В `guessDocumentTypeV2` було правило для `-РГ` (Розпорядження Голови ВРУ), але НЕ було правила для `-РП` (Розпорядження Президента)
- Prefix-sniff не перевіряв "РОЗПОРЯДЖЕННЯ ПРЕЗИДЕНТА" на початку snippet
- Валідатор не мав правила для президентських розпоряджень
- Детектор не мав CRITICAL правила для `-РП` suffix

---

## Виправлення

### 1. guessDocumentTypeV2

**Додано правила (ПЕРЕД typ-based):**
- Правило 2: Prefix-sniff для "РОЗПОРЯДЖЕННЯ ПРЕЗИДЕНТА" → `presidential_order`
- Правило 3: Suffix check `-РП` → `presidential_order` (достатній сам по собі, навіть без snippet)

### 2. validateDocumentTypeConsistency

**Додано правило 4.5:**
- Якщо snippet/summary/title містить "РОЗПОРЯДЖЕННЯ ПРЕЗИДЕНТА", але slug != `presidential_order` → CRITICAL
- Suggested_slug override для кешованих результатів

### 3. detect-type-absurdities

**Додано правила:**
- `PRESIDENTIAL_ORDER_AS_REGULATION`: CRITICAL якщо "розпорядження президента" але slug = regulation/law/code
- `PRESIDENTIAL_ORDER_NREG_SUFFIX`: CRITICAL якщо document_number має `-РП` але slug != `presidential_order`

### 4. repair-doc-types

**Оновлено:**
- Використовує `enrichDocumentType` замість `guessDocumentTypeV2` (з валідацією)
- Передає `snippet`, `summary`, `document_number` з R2 canonical

---

## Evidence (AFTER)

### Supabase

| nreg | document_type_slug | document_type | sync_health |
|------|-------------------|---------------|-------------|
| 6/2026-рп | presidential_order ✅ | Розпоряження Президента ✅ | green ✅ |
| 7/2026-рп | presidential_order ✅ | Розпоряження Президента ✅ | green ✅ |

### Verify Results

- **6/2026-рп:** PASS: 23 / FAIL: 0 ✅
- **7/2026-рп:** PASS: 23 / FAIL: 0 ✅

### Qdrant Payloads

- **6/2026-рп:** Оновлено 3 chunks + 1 act payloads (document_type_slug, document_type) ✅
- **7/2026-рп:** Оновлено payloads ✅

### SQL Evidence

```sql
SELECT COUNT(*) FROM legislation_documents 
WHERE document_number LIKE '%-РП' 
AND document_type_slug != 'presidential_order';
-- Result: 0 ✅
```

### detect-type-absurdities

- **6/2026-рп:** Не знайдено в CRITICAL findings ✅
- **7/2026-рп:** Не знайдено в CRITICAL findings ✅
- **CRITICAL total:** 3 (інші документи: 57/2026, 60/2026, 66/2026)

---

## Результат

✅ **6/2026-рп і 7/2026-рп виправлено системно**  
✅ **Правила додано в heuristics, validator, detector**  
✅ **Qdrant payloads синхронізовано**  
✅ **verify PASS для обох документів**  
✅ **SQL invariant: count("-РП" AND slug!=presidential_order) = 0**

---

**Наступний крок:** Виправити інші 3 CRITICAL findings (57/2026, 60/2026, 66/2026) або продовжити PHASE 2 (diversity scoring)
