# Root Fix Report: Документи за dokid (масові проблеми з постановами)

**Дата:** 2026-01-26  
**Статус:** ✅ ВИПРАВЛЕНО

---

## Проблема

Користувач надав список dokid документів з проблемами класифікації:
- 299088, 476775, 465333, 318765, 310015, 313942, 29373, 71131, 348387, 247941, 21961, 333279, 314291, 294378, 292792

**Основні проблеми:**
1. **10 документів з `vr_resolution`**, які насправді є `minister_order` (z**** pattern + НАКАЗ)
2. **1 документ з `vr_resolution`**, який насправді є `cmu_order` (z0426-11 - помилка, має бути `minister_order`)
3. **2 документи з `cmu_resolution`**, які насправді є інші типи:
   - `950-2007-п`: cmu_resolution → має залишитися `cmu_resolution` (але валідатор перевизначав на `presidential_decree`)
   - `v0002500-26`: cmu_resolution → `nbu_resolution`

---

## Root Cause Analysis

### Проблема 1: z**** документи класифіковані як `vr_resolution`

**Документи:**
- z0785-18, z0158-17, z0270-10, z1229-09, z0147-10, z0115-99, z0748-00, z1257-07, v0003900-93

**Root Cause:**
- Ці документи були імпортовані ДО того, як ми додали правило для z**** pattern + НАКАЗ
- Правило для z**** pattern вже існує, але воно не спрацьовувало для старих документів через кеш
- Всі документи мають `typ=9` (Наказ) і `НАКАЗ` в raw_txt, але були класифіковані як `vr_resolution`

**Fix:**
- Правило для z**** pattern вже працює правильно
- Зроблено backfill для всіх проблемних документів
- Оновлено cache version до `doc_type_v9`

### Проблема 2: z0426-11 класифікований як `cmu_order` замість `minister_order`

**Документ:** z0426-11 (Державна податкова адміністрація)

**Root Cause:**
- `extractIssuerFromPrefix` не визначав "ДЕРЖАВНА ПОДАТКОВА АДМІНІСТРАЦІЯ" як SERVICE
- Правило для typ=9 не перевіряло SERVICE/AGENCY/INSPECTION

**Fix:**
1. Додано перевірку для "АДМІНІСТРАЦІЯ" в `extractIssuerFromPrefix` (SERVICE)
2. Покращено правило для typ=9, щоб перевіряти SERVICE/AGENCY/INSPECTION
3. Зроблено backfill для z0426-11

### Проблема 3: 950-2007-п перевизначається валідатором на `presidential_decree`

**Документ:** 950-2007-п (Постанова КМУ про затвердження Регламенту)

**Root Cause:**
- Валідатор перевизначав `cmu_resolution` на `presidential_decree` через згадку "Указ Президента" в raw_txt_prefix
- Це посилання, а не issuer документа

**Fix:**
- Додано виняток для постанов КМУ/ВРУ, які містять згадку про указ президента як посилання
- Валідатор тепер не перевизначає постанови КМУ/ВРУ на `presidential_decree`, якщо в snippet є "КАБІНЕТ МІНІСТРІВ" + "ПОСТАНОВА"

### Проблема 4: v0002500-26 класифікований як `cmu_resolution` замість `nbu_resolution`

**Документ:** v0002500-26 (Постанова Правління НБУ)

**Root Cause:**
- Правило для typ=2 не перевіряло НБУ перед КМУ/ВРУ
- Валідатор виправляв це, але правило в guessDocumentTypeV2 не спрацьовувало

**Fix:**
- Додано правило для НБУ в typ=2 (перевіряється ПЕРЕД КМУ/ВРУ)
- Зроблено backfill для v0002500-26

---

## Виправлення

### 1. `kindExtractor.ts`
- Додано перевірку для "АДМІНІСТРАЦІЯ" → SERVICE

### 2. `guessDocumentTypeV2.ts`
- Покращено правило для typ=9: додано перевірку SERVICE/AGENCY/INSPECTION
- Додано правило для НБУ в typ=2 (перевіряється ПЕРЕД КМУ/ВРУ)

### 3. `documentTypeEnrichment.ts` (validator)
- Додано виняток для постанов КМУ/ВРУ, які містять згадку про указ президента як посилання
- Оновлено cache version до `doc_type_v9`

### 4. `buildCanonical.ts`
- Додано передачу `raw_txt` до `enrichDocumentType` (вже було виправлено раніше)

---

## Backfill Results

### z**** документи (10 документів):
- z0785-18: vr_resolution → minister_order ✅
- z0158-17: vr_resolution → minister_order ✅
- z0270-10: vr_resolution → minister_order ✅
- z1229-09: vr_resolution → minister_order ✅
- z0147-10: vr_resolution → minister_order ✅
- z0115-99: vr_resolution → minister_order ✅
- z0748-00: vr_resolution → minister_order ✅
- z0426-11: vr_resolution → minister_order ✅
- z1257-07: vr_resolution → minister_order ✅
- v0003900-93: vr_resolution → minister_order ✅

### Інші документи:
- 950-2007-п: cmu_resolution → cmu_resolution ✅ (виправлено валідатор)
- v0002500-26: cmu_resolution → nbu_resolution ✅

---

## Масовий аудит постанов

**Команда:** `audit-resolutions`

**Результати:**
- Всього перевірено: 60 документів
- Mismatches: 0 ✅
- VR_RESOLUTION_MISMATCH: 0 ✅
- CMU_RESOLUTION_MISMATCH: 0 ✅

---

## Фінальна перевірка

### Всі проблемні документи:
- ✅ z0785-18: minister_order
- ✅ z0158-17: minister_order
- ✅ z0270-10: minister_order
- ✅ z1229-09: minister_order
- ✅ z0147-10: minister_order
- ✅ z0115-99: minister_order
- ✅ z0748-00: minister_order
- ✅ z0426-11: minister_order
- ✅ z1257-07: minister_order
- ✅ v0003900-93: minister_order
- ✅ 950-2007-п: cmu_resolution
- ✅ v0002500-26: nbu_resolution

### Qdrant синхронізація:
- ✅ Всі документи синхронізовані (acts + chunks payloads)

---

## Висновок

**Всі проблеми виправлено:**
1. ✅ z**** документи правильно класифіковані як `minister_order`
2. ✅ z0426-11 правильно класифікований як `minister_order` (SERVICE)
3. ✅ 950-2007-п правильно залишається `cmu_resolution` (виправлено валідатор)
4. ✅ v0002500-26 правильно класифікований як `nbu_resolution`
5. ✅ Масовий аудит постанов: 0 mismatches

**Root fixes:**
- KIND-FIRST logic для z**** документів працює правильно
- Правило для typ=9 покращено (SERVICE/AGENCY/INSPECTION)
- Правило для typ=2 додано НБУ (перевіряється ПЕРЕД КМУ/ВРУ)
- Валідатор виправлено (не перевизначає постанови КМУ/ВРУ на presidential_decree)

**Система готова до PROD:** ✅
