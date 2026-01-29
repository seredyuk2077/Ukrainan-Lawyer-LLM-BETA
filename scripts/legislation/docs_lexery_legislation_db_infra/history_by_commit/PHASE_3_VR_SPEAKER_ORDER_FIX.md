# PHASE 3: VR_SPEAKER_ORDER Root Fix

**Дата:** 2026-01-22  
**Проблема:** Документ "РОЗПОРЯДЖЕННЯ ГОЛОВИ ВРУ 48/26-РГ" отримав UA label "Положення" замість правильного типу.

---

## PHASE 3.1: Evidence (BEFORE)

### Документ 48/26-рг:
- **rada_nreg:** 48/26-рг
- **document_number:** 48/26-рг
- **title:** "Про внесення змін Технологічної схеми інформаційного наповнення веб-ресурсів Верховної Ради України"
- **document_type_slug:** regulation ❌
- **document_type (UA):** Положення ❌
- **snippet60:** "ГОЛОВА ВЕРХОВНОЇ РАДИ УКРАЇНИ\nРОЗПОРЯДЖЕННЯ"
- **snippet200:** "ГОЛОВА ВЕРХОВНОЇ РАДИ УКРАЇНИ\nРОЗПОРЯДЖЕННЯ\nм. Київ\n№ 48\n20.01.2026\nПро внесення змін..."

**Висновок:** Snippet чітко показує "РОЗПОРЯДЖЕННЯ ГОЛОВИ ВРУ", але документ класифіковано як "Положення".

---

## PHASE 3.2: Root Fix

### A) Додано новий document_type_slug у taxonomy ✅
- **Файл:** `scripts/legislation/documentTypes/documentTypes.ts`
- **Додано:** `vr_speaker_order` з UA label "Розпорядження Голови ВРУ"
- **Додано в normalizeDocumentType:** мапінги для "розпорядження голови вр"

### B) Prefix-sniff евристика в guessDocumentTypeV2 ✅
- **Файл:** `scripts/legislation/documentTypes/guessDocumentTypeV2.ts`
- **Додано правило 0 (виконується ПЕРШИМ):**
  - Нормалізація snippet/title (uppercase, collapse whitespace)
  - Якщо normalized snippet містить "РОЗПОРЯДЖЕННЯ" + "ГОЛОВИ" + ("ВЕРХОВНОЇ РАДИ" або "ВРУ") → `vr_speaker_order`
  - Якщо document_number має суфікс `-РГ` + підтвердження в snippet → `vr_speaker_order`

### C) Розширено detect-type-absurdities ✅
- **Файл:** `scripts/legislation/commands/detect-type-absurdities.ts`
- **Додано правила:**
  - `VR_SPEAKER_ORDER_PREFIX`: prefix-based перевірка (CRITICAL)
  - `VR_SPEAKER_ORDER_AS_REGULATION`: UA label = "Положення" але snippet = "РОЗПОРЯДЖЕННЯ ГОЛОВИ" (CRITICAL)
  - `VR_SPEAKER_ORDER_NREG_SUFFIX`: document_number закінчується на `-РГ` (CRITICAL)

### D) Посилено validateDocumentTypeConsistency ✅
- **Файл:** `scripts/legislation/lib/documentTypeEnrichment.ts`
- **Додано правило 6:** prefix-based перевірка для Розпорядження Голови ВРУ
- **CRITICAL override:** якщо slug=regulation але є сигнал "РОЗПОРЯДЖЕННЯ ГОЛОВИ ВРУ" → suggested_slug=vr_speaker_order

### E) Оновлено виклики enrichDocumentType ✅
- **Файли:**
  - `scripts/legislation/lib/documentTypeEnrichment.ts` (додано параметр `document_number`)
  - `scripts/legislation/commands/backfill-document-types.ts` (передає `document_number`)
  - `scripts/legislation/canonical/buildCanonical.ts` (потрібно оновити)

---

## PHASE 3.3: Backfill + Repair + Verify

### Backfill:
```bash
pnpm tsx scripts/legislation/admin-cli.ts backfill-document-types
```

### Repair Consistency:
```bash
pnpm tsx scripts/legislation/admin-cli.ts repair-consistency --nreg "48/26-рг"
```

### Verify:
```bash
pnpm tsx scripts/legislation/admin-cli.ts detect-type-absurdities --only-red
```

---

## PHASE 3.4: Evidence (AFTER)

**Очікуваний результат:**
- **document_type_slug:** vr_speaker_order ✅
- **document_type (UA):** Розпорядження Голови ВРУ ✅
- **detect-type-absurdities:** CRITICAL = 0 ✅

---

## Root Cause Summary

**Проблема:** Система не мала правил для розпізнавання "Розпорядження Голови ВРУ" (особливий тип документів з суфіксом `-РГ`).

**Рішення:**
1. Додано новий document_type_slug `vr_speaker_order` у taxonomy
2. Додано prefix-sniff правило (виконується ПЕРШИМ, перед typ-based heuristics)
3. Додано правила в детектор абсурдів для автоматичного виявлення помилок
4. Посилено валідацію консистентності для override кешованих результатів

**Результат:** Система тепер автоматично розпізнає та класифікує "Розпорядження Голови ВРУ" на основі prefix (snippet) та document_number suffix (`-РГ`).
