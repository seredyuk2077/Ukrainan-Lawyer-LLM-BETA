# Document Type Fix Plan

**Дата:** 2026-01-26  
**Мета:** Виправити неправильні document_type класифікації (декрети КМУ, EU law, регулятори)

---

## Current State

### Відомі проблемні кейси

#### 1. Декрети КМУ (13-93, 35-93, 7-93)
- **Поточний стан:** визначаються як "інструкція"
- **Очікування:** `cmu_decree` + "Декрет Кабінету Міністрів України"
- **Root cause:** відсутність правил для розпізнавання "Д Е К Р Е Т" з розрядкою

#### 2. EU Law (984_011-xx, 984_006-xx)
- **Поточний стан:** неправильні UA labels ("Положення" замість "Регламент Європейського парламенту")
- **Очікування:** `eu_directive` / `eu_regulation` + правильні UA labels
- **Root cause:** відсутність окремих slugs для EU law

#### 3. Регулятор НКРЕКП (dokid=474053)
- **Поточний стан:** "Постанова КМУ"
- **Очікування:** `nerc_resolution` + "Постанова НКРЕКП"
- **Root cause:** дефолт на cmu_resolution для всіх постанов

#### 4. Масова проблема "постанова/рішення не того органу"
- **Проблема:** cmu_resolution для не-КМУ, vr_resolution для не-ВРУ
- **Root cause:** відсутність issuer detection

---

## Що вважаємо "правильним doc type"

1. **Slug** — з whitelist taxonomy (не "вигадування")
2. **UA label** — з taxonomy (не генерація вручну)
3. **Issuer** — правильний орган (КМУ/ВРУ/Президент/КСУ/НКРЕКП/ЄС/тощо)
4. **Act kind** — правильний вид акта (декрет/постанова/рішення/наказ/директива/регламент)

---

## Наявні інструменти

1. **audit-documents-v2** — повний аудит з evidence
2. **detect-type-absurdities** — детектор абсурдних класифікацій
3. **verify --write-health** — перевірка інваріантів
4. **backfill-document-types** — масовий backfill
5. **repair-consistency** — синхронізація Qdrant payloads

---

## План виправлення

### Етап 1: Taxonomy Extension
- [ ] Додати `cmu_decree` — "Декрет Кабінету Міністрів України"
- [ ] Додати `eu_directive` — "Директива Європейського парламенту"
- [ ] Додати `eu_regulation` — "Регламент Європейського парламенту"
- [ ] Додати `nerc_resolution` — "Постанова НКРЕКП"

### Етап 2: Signal Extractor
- [ ] Створити `extractIssuerSignals()` — витягує issuer з snippet/title/summary
- [ ] Створити `extractActKindSignals()` — витягує act kind (декрет/постанова/тощо)
- [ ] Нормалізація верхнього тексту (прибрати розрядку, пробіли)

### Етап 3: Heuristics Enhancement
- [ ] Додати snippet-first правила для декретів КМУ
- [ ] Додати правила для EU law (nreg pattern + title/snippet)
- [ ] Додати правила для НКРЕКП та інших регуляторів
- [ ] Виправити дефолт на cmu_resolution (перевіряти issuer)

### Етап 4: Validator Enhancement
- [ ] Додати перевірки issuer mismatch
- [ ] Додати перевірки EU law mismatch
- [ ] Додати перевірки decree mismatch

### Етап 5: Audit & Backfill
- [ ] Розширити audit-documents-v2 для issuer/kind signals
- [ ] Масовий аудит 190 документів
- [ ] Targeted backfill для відомих кейсів
- [ ] Масовий backfill для CRITICAL

### Етап 6: Regression Testing
- [ ] Створити golden regression set
- [ ] Створити команду `doc-type-regression`
- [ ] Перевірити 0 FAIL

---

**Оновлено:** 2026-01-26
