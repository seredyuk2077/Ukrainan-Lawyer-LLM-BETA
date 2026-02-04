# PHASE 3.4-3.5: Root Fix Enrichment + Close CRITICAL to 0 — COMPLETE

**Дата:** 2026-01-22  
**Статус:** ✅ COMPLETE

---

## PHASE 3.4: Root Fix для enrichDocumentType

### Проблема:
- `enrichDocumentType` інколи повертав неправильний slug (regulation замість vr_speaker_order)
- `guessDocumentTypeV2` не перевіряв summary для ЦВК/РНБО
- Правило -РГ suffix потребувало snippet, але snippet може бути недоступний

### Рішення:

#### 1. Виправлено "ГОЛОВА" vs "ГОЛОВИ"
- **Файли:** `guessDocumentTypeV2.ts`, `detect-type-absurdities.ts`, `documentTypeEnrichment.ts`
- **Зміна:** Перевірка обох варіантів (`ГОЛОВА` однина та `ГОЛОВИ` множина)
- **Результат:** Prefix-sniff працює коректно для "ГОЛОВА ВЕРХОВНОЇ РАДИ"

#### 2. Додано summary у guessDocumentTypeV2
- **Файл:** `guessDocumentTypeV2.ts`
- **Зміна:** Додано параметр `summary` та перевірка summary для ЦВК/РНБО
- **Результат:** ЦВК/РНБО в summary тепер ловиться автоматично

#### 3. Правило -РГ suffix працює без snippet
- **Файл:** `guessDocumentTypeV2.ts`
- **Зміна:** Правило 2 (nreg suffix) працює навіть якщо snippet/summary пусті
- **Результат:** TEST #1 PASS ✅

#### 4. Пріоритет РНБО перед typ=1
- **Файл:** `guessDocumentTypeV2.ts`
- **Зміна:** Перевірка РНБО в summary ПЕРЕД typ=1 (щоб не повертати 'law' для РНБО)
- **Результат:** TEST #3 PASS ✅

#### 5. Unit Tests
- **Файл:** `test/vr_speaker_order.test.ts`
- **Тести:**
  - TEST #1: document_number = "48/26-РГ", snippet пустий → vr_speaker_order ✅
  - TEST #2: snippet починається з "РОЗПОРЯДЖЕННЯ ГОЛОВИ ВРУ" → vr_speaker_order ✅
  - TEST #3: prefix-sniff з snippet "ГОЛОВА" (однина) → vr_speaker_order ✅
  - TEST #4: nreg suffix -РГ без snippet → vr_speaker_order ✅

---

## PHASE 3.5: Close CRITICAL to 0

### Документи:

#### v0003359-26 (CEC_AS_CMU)
- **BEFORE:**
  - document_type_slug: cmu_resolution ❌
  - document_type: Постанова КМУ ❌
  - summary_prefix: "Постанова Центральної виборчої комісії..."
- **AFTER:**
  - document_type_slug: cec_resolution ✅
  - document_type: Постанова ЦВК ✅
  - reason_code: CEC_AS_CMU

#### n0002525-26 (RNBO_AS_LAW)
- **BEFORE:**
  - document_type_slug: law ❌
  - document_type: Закон ❌
  - summary_prefix: "Рішення Ради національної безпеки..."
- **AFTER:**
  - document_type_slug: rnbo_decision ✅
  - document_type: Рішення РНБО ✅
  - reason_code: RNBO_AS_LAW

### SQL Evidence:

#### A) Count(ЦВК сигнал AND slug != cec_resolution):
```sql
SELECT COUNT(*) 
FROM legislation_documents
WHERE (summary ILIKE '%ЦВК%' OR summary ILIKE '%Центральна виборча%' OR title ILIKE '%ЦВК%')
  AND document_type_slug != 'cec_resolution';
```
**Результат:** 0 ✅

#### B) Count(РНБО сигнал AND slug != rnbo_decision):
```sql
SELECT COUNT(*) 
FROM legislation_documents
WHERE (summary ILIKE '%РНБО%' OR summary ILIKE '%Рада національної безпеки%' OR title ILIKE '%РНБО%')
  AND document_type_slug != 'rnbo_decision'
  AND document_type_slug != 'presidential_decree';
```
**Результат:** 0 ✅

#### C) Count(document_type_slug IS NULL):
```sql
SELECT COUNT(*) FROM legislation_documents WHERE document_type_slug IS NULL;
```
**Результат:** 0 ✅

#### D) detect-type-absurdities --all:
- **CRITICAL:** 0 ✅
- **WARN:** 0 ✅

---

## PHASE 3.6: Verify FAIL Analysis

### Поточний стан:
- **PASS:** 25
- **FAIL:** 37 (технічні, не semantic)

### Топ причини FAIL (потрібно детальний аналіз):
- NULL Stats (total=62)
- Інші технічні перевірки

**Note:** Детальний розбір FAIL причин буде в наступному кроці.

---

## Root Cause Summary

### enrichDocumentType Bug:
**Проблема:** 
1. "ГОЛОВА" (однина) не ловилась правилом "ГОЛОВИ" (множина)
2. summary не передавався в guessDocumentTypeV2
3. Правило -РГ потребувало snippet
4. typ=1 мав вищий пріоритет за РНБО в summary

**Рішення:**
1. Додано перевірку обох варіантів ("ГОЛОВА" та "ГОЛОВИ")
2. Додано summary параметр у guessDocumentTypeV2
3. Правило -РГ працює навіть без snippet
4. РНБО перевірка ПЕРЕД typ=1

**Результат:** Unit tests PASS, enrichment працює коректно ✅

### CRITICAL = 0:
**Проблема:** v0003359-26 та n0002525-26 мали неправильні slug через те, що summary не перевірявся.

**Рішення:**
1. Додано перевірку summary для ЦВК/РНБО
2. Force update через SQL (emergency fix)
3. Repair consistency для Qdrant
4. SQL evidence підтверджує 0 помилок

**Результат:** CRITICAL = 0 ✅

---

## Next Steps

1. ✅ enrichDocumentType bug виправлено
2. ✅ CRITICAL = 0
3. ⏳ PHASE 3.6: Детальний розбір verify FAIL (37)
4. ⏳ PHASE 3.7: Імпорт HARD 50 до total_docs=100
