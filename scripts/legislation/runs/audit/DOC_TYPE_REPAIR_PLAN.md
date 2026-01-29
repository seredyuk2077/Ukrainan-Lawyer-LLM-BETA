# Document Type Repair Plan

**Дата:** 2026-01-26  
**Статус:** В процесі виправлення

---

## CRITICAL Issues (з масового аудиту)

### Статистика
- **CRITICAL:** 12 документів
- **WARN:** 4 документи
- **OK:** 174 документи

### Групування по root-cause

#### 1. Issuer Mismatch (cmu_resolution для не-КМУ)
- **Кількість:** 7 документів
- **Приклади:** 18-2026-п, 22-2026-п, 35-2026-п, 36-2026-п, 44-2026-п, 45-2026-п, 46-2026-п
- **Root cause:** Дефолт на cmu_resolution для typ=2 без перевірки issuer
- **Fix:** Виправлено в guessDocumentTypeV2 (перевірка issuer перед дефолтом)

#### 2. Issuer Mismatch (vr_resolution для не-ВРУ)
- **Кількість:** 5 документів
- **Приклади:** 4762-20, 4763-20, 4765-20, 4766-20, z0572-09
- **Root cause:** Дефолт на vr_resolution для typ=2 без перевірки issuer
- **Fix:** Виправлено в guessDocumentTypeV2 (перевірка issuer перед дефолтом)

#### 3. EU Law Mismatch
- **Кількість:** 4 документи (WARN)
- **Приклади:** 984_011-01, 984_011-12, 984_011-07, 984_006-03
- **Root cause:** Відсутність окремих slugs для EU law
- **Fix:** Додано eu_directive та eu_regulation в taxonomy + heuristics

#### 4. Decree Mismatch
- **Кількість:** 3 документи
- **Приклади:** 13-93, 35-93, 7-93
- **Root cause:** Відсутність правил для розпізнавання "Д Е К Р Е Т" з розрядкою
- **Fix:** Додано cmu_decree в taxonomy + heuristics з правильним прибиранням розрядки

#### 5. НКРЕКП Mismatch
- **Кількість:** 1 документ
- **Приклади:** v0310874-18
- **Root cause:** Дефолт на cmu_resolution для постанов без перевірки issuer
- **Fix:** Додано nerc_resolution в taxonomy + heuristics

---

## План виправлення

### Етап 1: Taxonomy Extension ✅
- ✅ Додано `cmu_decree`
- ✅ Додано `eu_directive`
- ✅ Додано `eu_regulation`
- ✅ Додано `nerc_resolution`

### Етап 2: Heuristics Enhancement ✅
- ✅ Додано snippet-first правила для декретів КМУ
- ✅ Додано правила для EU law
- ✅ Додано правила для НКРЕКП
- ✅ Виправлено дефолт на cmu_resolution (перевірка issuer)

### Етап 3: Validator Enhancement ✅
- ✅ Додано перевірки issuer mismatch
- ✅ Додано перевірки EU law mismatch
- ✅ Додано перевірки decree mismatch

### Етап 4: Targeted Backfill (в процесі)
- ✅ Створено команду `targeted-doc-type-backfill`
- ⏳ Запустити для відомих кейсів
- ⏳ Запустити `repair-consistency` для синхронізації Qdrant payloads

### Етап 5: Масовий Backfill
- ⏳ Запустити `backfill-document-types --all` для CRITICAL
- ⏳ Запустити `repair-consistency --all`
- ⏳ Запустити `verify --all --write-health`

### Етап 6: Regression Testing
- ✅ Створено golden regression set
- ✅ Створено команду `doc-type-regression`
- ⏳ Перевірити 0 FAIL

---

**Оновлено:** 2026-01-26
