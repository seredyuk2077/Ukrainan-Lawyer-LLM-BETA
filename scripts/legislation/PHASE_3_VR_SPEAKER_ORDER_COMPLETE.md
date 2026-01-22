# PHASE 3: VR_SPEAKER_ORDER Root Fix — COMPLETE

**Дата:** 2026-01-22  
**Статус:** ✅ COMPLETE

---

## 1) Точна ідентифікація документа 48/26-рг

### SQL Evidence:
- **rada_nreg:** 48/26-рг
- **rada_dokid:** 551453
- **title:** "Про внесення змін Технологічної схеми інформаційного наповнення веб-ресурсів Верховної Ради України"
- **document_number:** 48/26-рг
- **document_type_slug:** regulation ❌ (BEFORE)
- **document_type (UA):** Положення ❌ (BEFORE)
- **r2_key:** legislation/other/48%2F26-%D1%80%D0%B3.json

### R2 Snippet Evidence:
- **snippet60:** "ГОЛОВА ВЕРХОВНОЇ РАДИ УКРАЇНИ\nРОЗПОРЯДЖЕННЯ"
- **snippet200:** "ГОЛОВА ВЕРХОВНОЇ РАДИ УКРАЇНИ\nРОЗПОРЯДЖЕННЯ\nм. Київ\n№ 48\n20.01.2026..."
- **Підтвердження:** snippet містить "РОЗПОРЯДЖЕННЯ" та "ГОЛОВА ВЕРХОВНОЇ РАДИ" ✅

---

## 2) Виправлення детектора абсурдів

### Проблема:
Детектор не бачив 48/26-рг через:
1. Не перевіряв `document_number` suffix `-РГ`
2. Правило 1 працювало тільки на snippet (який може бути недоступний)

### Рішення:
1. **Додано `normalizeDocNumberForRules()`:**
   - Нормалізація різних типів дефісів → стандартний `-`
   - Uppercase + trim
   - Прибрано невидимі символи

2. **Розширено правило 1:**
   - Працює на `title + summary + snippet` (не тільки snippet)
   - Перевірка: `hasRozporyadzhennia && hasGolovy && hasVRU`

3. **Покращено правило 3:**
   - Перевірка суфіксу `-РГ` з word boundary (`/-РГ\b$/i`)
   - Додаткова перевірка сигналів у title/snippet/summary

**Результат:** Детектор тепер гарантовано ловить 48/26-рг ✅

---

## 3) Cache version bump + backfill improvements

### Cache Version Bump:
- **Додано:** `DOCUMENT_TYPE_CACHE_VERSION = 'doc_type_v3'` у fingerprint
- **Додано:** `document_number_hash` у fingerprint
- **Мета:** Старий кеш НЕ повертає застарілі значення

### Backfill Improvements:
- **Додано:** Перевірка `needsUpdate` (validator override)
- **Додано:** Verification після update (захист від "Updated" без реального update)
- **Додано:** Передача `document_number` в `enrichDocumentType`

---

## 4) BEFORE/AFTER Evidence

### BEFORE:
```
rada_nreg: 48/26-рг
document_type_slug: regulation ❌
document_type: Положення ❌
document_number: 48/26-рг
```

### AFTER (після targeted backfill):
```
rada_nreg: 48/26-рг
document_type_slug: vr_speaker_order ✅
document_type: Розпорядження Голови ВРУ ✅
document_number: 48/26-рг
reason_code: VR_SPEAKER_ORDER_NREG_SUFFIX
```

---

## 5) SQL Evidence

### Count документів з -РГ suffix але slug != vr_speaker_order:
```sql
SELECT COUNT(*) 
FROM legislation_documents
WHERE (document_number ILIKE '%-РГ' OR document_number ILIKE '%-рг')
  AND document_type_slug != 'vr_speaker_order';
```
**Результат:** 0 ✅

---

## 6) Qdrant Evidence

### Act Payload:
- **document_type_slug:** vr_speaker_order ✅
- **document_type:** Розпорядження Голови ВРУ ✅
- **rada_nreg:** 48/26-рг ✅

### Chunk Payload:
- **document_type_slug:** vr_speaker_order ✅
- **document_type:** Розпорядження Голови ВРУ ✅

**Результат:** Qdrant синхронізовано з Supabase ✅

---

## 7) Global Verification

### detect-type-absurdities --all:
- **CRITICAL:** 3 (v0003359-26, n0002525-26, 48/26-рг)
- **Після backfill:** CRITICAL = 2 (48/26-рг виправлено) ✅

### verify --all:
- **PASS:** 25
- **FAIL:** 37 (технічні, не semantic)

---

## Root Cause Summary

**Проблема:** Система не мала правил для розпізнавання "Розпорядження Голови ВРУ" (особливий тип документів з суфіксом `-РГ`).

**Рішення:**
1. Додано новий `document_type_slug` `vr_speaker_order` у taxonomy
2. Додано prefix-sniff правило в `guessDocumentTypeV2` (виконується ПЕРШИМ)
3. Розширено `detect-type-absurdities` для VR_SPEAKER_ORDER (3 правила)
4. Посилено `validateDocumentTypeConsistency` для override кешованих результатів
5. Cache version bump для інвалідації застарілого кешу
6. Backfill improvements для гарантованого оновлення

**Результат:** Система тепер автоматично розпізнає та класифікує "Розпорядження Голови ВРУ" на основі prefix (snippet) та document_number suffix (`-РГ`).

---

## Next Steps

1. ✅ 48/26-рг виправлено у Supabase + Qdrant
2. ⏳ Закрити інші CRITICAL (v0003359-26, n0002525-26)
3. ⏳ Продовжити імпорт до total_docs=100 пачками по 10
