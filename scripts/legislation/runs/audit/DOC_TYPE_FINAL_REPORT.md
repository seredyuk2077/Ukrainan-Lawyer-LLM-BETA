# Document Type Fix — Final Report (Updated: 2026-01-26)

**Дата:** 2026-01-26  
**Статус:** ✅ **MAJOR PROGRESS** (targeted fixes працюють)

---

## BEFORE/AFTER

### Декрети КМУ
- **BEFORE:** 13-93, 35-93, 7-93 → `instruction` (Інструкція)
- **AFTER:** 13-93, 35-93, 7-93 → `cmu_decree` (Декрет Кабінету Міністрів України) ✅

### EU Law
- **BEFORE:** 
  - 984_011-01, 984_011-12 → `international_treaty` (Міжнародний договір)
  - 984_011-07, 984_006-03 → `regulation` (Положення)
- **AFTER:**
  - 984_011-01, 984_011-12 → `eu_directive` (Директива Європейського парламенту) ✅
  - 984_011-07, 984_006-03 → `eu_regulation` (Регламент Європейського парламенту) ✅

### НКРЕКП
- **BEFORE:** v0310874-18 → `cmu_resolution` (Постанова КМУ)
- **AFTER:** v0310874-18 → `nerc_resolution` (Постанова НКРЕКП) ✅

---

## Root Cause Fixes

### PHASE 15: KIND-FIRST Logic для z**** Minister Orders (z0572-09)

**Проблема:** z0572-09 класифікувався як `cmu_order` замість `minister_order`, бо в тексті була згадка "Кабінету Міністрів України" як посилання на інший документ.

**Root Fix:**
1. **KIND-FIRST утиліти** (`kindExtractor.ts`):
   - `extractKindFromPrefix()` — визначає вид акта (НАКАЗ, ПОСТАНОВА, тощо) з префіксу
   - `extractIssuerFromPrefix()` — визначає issuer (орган) тільки з блоку ПЕРЕД "НАКАЗ" для НАКАЗ документів
   
2. **KIND-FIRST gate** в `guessDocumentTypeV2.ts`:
   - Виконується ПЕРЕД suffix rules
   - Якщо `kind == NAKAZ` → НЕ МОЖНА повертати `cmu_order` або `cmu_resolution`
   - Для z**** + НАКАЗ + issuer=MINISTRY/COMMITTEE → `minister_order`
   
3. **Cache version bump** (`doc_type_v4`) для інвалідації старих кешованих результатів

**Результат:**
- z0572-09: `vr_resolution` → `minister_order` ✅
- Verify: PASS: 22 / FAIL: 0 ✅
- Qdrant payload синхронізовано ✅

**Evidence:** `runs/audit/Z0572_09_EVIDENCE.md`

## Root Cause Fixes (попередні)

### 1. Taxonomy Extension ✅
- Додано `cmu_decree` — "Декрет Кабінету Міністрів України"
- Додано `eu_directive` — "Директива Європейського парламенту"
- Додано `eu_regulation` — "Регламент Європейського парламенту"
- Додано `nerc_resolution` — "Постанова НКРЕКП"

### 2. Signal Extractor ✅
- Створено `extractIssuerSignals()` — витягує issuer з snippet/title/summary
- Створено `extractActKindSignals()` — витягує act kind
- Нормалізація верхнього тексту з правильним прибиранням розрядки

### 3. Heuristics Enhancement ✅
- Додано snippet-first правила для декретів КМУ (з урахуванням розрядки)
- Додано правила для EU law (nreg pattern + title/snippet)
- Додано правила для НКРЕКП та інших регуляторів
- Виправлено дефолт на cmu_resolution (перевірка issuer перед дефолтом)

### 4. Validator Enhancement ✅
- Додано перевірки issuer mismatch
- Додано перевірки EU law mismatch
- Додано перевірки decree mismatch
- Додано перевірки НКРЕКП mismatch

### 5. Audit Enhancement ✅
- Розширено `audit-documents-v2` для issuer/kind signals
- Додано predicted_slug, mismatch_flags, severity
- Масовий аудит 190 документів виконано

---

## Масовий аудит Results

### Статистика (190 документів)
- **CRITICAL:** 12 документів
- **WARN:** 4 документи
- **OK:** 174 документи

### CRITICAL Issues
1. **Issuer Mismatch (cmu_resolution для не-КМУ):** 7 документів
   - Приклади: 18-2026-п, 22-2026-п, 35-2026-п, 36-2026-п, 44-2026-п, 45-2026-п, 46-2026-п
   - Root cause: Дефолт на cmu_resolution для typ=2 без перевірки issuer
   - Fix: Виправлено в guessDocumentTypeV2

2. **Issuer Mismatch (vr_resolution для не-ВРУ):** 5 документів
   - Приклади: 4762-20, 4763-20, 4765-20, 4766-20, z0572-09 ✅ (виправлено через KIND-FIRST logic)
   - Root cause: Дефолт на vr_resolution для typ=2 без перевірки issuer
   - Fix: Виправлено в guessDocumentTypeV2

### WARN Issues
1. **EU Law Mismatch:** 4 документи
   - Приклади: 984_011-01, 984_011-12, 984_011-07, 984_006-03
   - Fix: Виправлено через targeted backfill

---

## Targeted Backfill Results

### Виконано
- ✅ 13-93 → cmu_decree
- ✅ 35-93 → cmu_decree
- ✅ 7-93 → cmu_decree
- ✅ 984_011-01 → eu_directive
- ✅ 984_011-12 → eu_directive
- ✅ 984_011-07 → eu_regulation
- ✅ 984_006-03 → eu_regulation
- ✅ v0310874-18 → nerc_resolution

---

## Regression Test Results

### Golden Set (13 документів)
- **Passed:** 12/13 (92%)
- **Failed:** 1/13 (8%)

### Failed Test
- `64/2022`: DB=presidential_decree, expected=vr_resolution
  - Примітка: Потрібно перевірити вручну - можливо це дійсно presidential_decree

---

## Змінені файли коду

1. **`scripts/legislation/documentTypes/documentTypes.ts`**
   - Додано нові taxonomy slugs (cmu_decree, eu_directive, eu_regulation, nerc_resolution)

2. **`scripts/legislation/lib/signalExtractor.ts`** (новий)
   - Issuer/ActKind signal extractor з правильним прибиранням розрядки

3. **`scripts/legislation/documentTypes/guessDocumentTypeV2.ts`**
   - Додано snippet-first правила для декретів, EU law, НКРЕКП
   - Виправлено дефолт на cmu_resolution (перевірка issuer)

4. **`scripts/legislation/lib/documentTypeEnrichment.ts`**
   - Додано валідацію для декретів, EU law, НКРЕКП
   - Додано перевірки issuer mismatch

5. **`scripts/legislation/commands/audit-documents-v2.ts`**
   - Розширено для issuer/kind signals
   - Додано predicted_slug, mismatch_flags, severity

6. **`scripts/legislation/commands/targeted-doc-type-backfill.ts`** (новий)
   - Targeted backfill для відомих кейсів

7. **`scripts/legislation/commands/doc-type-regression.ts`** (новий)
   - Regression test для golden set

8. **`scripts/legislation/test/doc_type_golden_set.json`** (новий)
   - Golden regression set

---

## Наступні кроки

1. ⏳ Запустити масовий backfill для CRITICAL документів (12 документів)
2. ⏳ Запустити `repair consistency` для синхронізації Qdrant payloads
3. ⏳ Запустити `verify --all --write-health`
4. ⏳ Перевірити `64/2022` вручну (можливо це дійсно presidential_decree)

---

## PROD READY

**Статус:** ⚠️ **NEEDS MASS BACKFILL** (для CRITICAL документів з issuer mismatch)

**Обґрунтування:**
1. ✅ Taxonomy extension завершено
2. ✅ Heuristics enhancement завершено (додано перевірку snippet перед довірянням organs)
3. ✅ Validator enhancement завершено
4. ✅ Targeted backfill працює правильно (8/8 відомих кейсів виправлено)
5. ✅ Regression test: 12/13 passed (92%)
6. ⏳ Потрібно масовий backfill для CRITICAL документів з issuer mismatch (12 документів)
7. ⏳ Потрібно синхронізувати Qdrant payloads через `repair consistency`

**Після масового backfill → PROD READY = YES**

**Команди для завершення:**
```bash
# Масовий backfill для CRITICAL
pnpm tsx scripts/legislation/admin-cli.ts backfill-document-types --all

# Синхронізація Qdrant payloads
pnpm tsx scripts/legislation/admin-cli.ts repair consistency --all

# Перевірка
pnpm tsx scripts/legislation/admin-cli.ts verify --all --write-health
pnpm tsx scripts/legislation/admin-cli.ts detect-type-absurdities
pnpm tsx scripts/legislation/admin-cli.ts doc-type-regression
```

---

---

## PHASE 15.5: Масові виправлення для dokid batch + постанови КМУ/ВРУ

### Проблема
Користувач надав список dokid документів з проблемами класифікації, особливо постанови КМУ/ВРУ, які насправді є постановами міністерств/інших органів.

### Виявлені проблеми
1. **10 документів з `vr_resolution`**, які насправді є `minister_order` (z**** pattern + НАКАЗ)
2. **1 документ з `vr_resolution`**, який насправді є `minister_order` (z0426-11 - Державна податкова адміністрація)
3. **2 документи з `cmu_resolution`**, які насправді є інші типи:
   - `950-2007-п`: валідатор перевизначав на `presidential_decree` (виправлено)
   - `v0002500-26`: має бути `nbu_resolution` (виправлено)

### Root Fixes

#### 1. `extractIssuerFromPrefix` для SERVICE/AGENCY
- Додано перевірку для "АДМІНІСТРАЦІЯ" → SERVICE
- Тепер "ДЕРЖАВНА ПОДАТКОВА АДМІНІСТРАЦІЯ" правильно визначається як SERVICE

#### 2. Правило для typ=9 покращено
- Додано перевірку SERVICE/AGENCY/INSPECTION
- Тепер накази від служб/адміністрацій правильно класифікуються як `minister_order`

#### 3. Правило для typ=2 додано НБУ
- Додано перевірку НБУ ПЕРЕД КМУ/ВРУ
- Тепер постанови НБУ правильно класифікуються як `nbu_resolution`

#### 4. Валідатор виправлено
- Додано виняток для постанов КМУ/ВРУ, які містять згадку про указ президента як посилання
- Валідатор тепер не перевизначає постанови КМУ/ВРУ на `presidential_decree`

### Backfill Results
- ✅ 10 z**** документів: vr_resolution → minister_order
- ✅ z0426-11: vr_resolution → minister_order
- ✅ 950-2007-п: cmu_resolution → cmu_resolution (виправлено валідатор)
- ✅ v0002500-26: cmu_resolution → nbu_resolution

### Масовий аудит постанов
- **Команда:** `audit-resolutions`
- **Результати:** 59 документів перевірено, 0 mismatches ✅

### Фінальна перевірка
- ✅ Всі 15 документів з dokid batch: 0 mismatches
- ✅ Масовий аудит постанов: 0 mismatches
- ✅ Cache version: `doc_type_v9`

**Оновлено:** 2026-01-26
