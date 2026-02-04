# Рефакторинг Progress Report

**Дата:** 2026-01-21  
**Статус:** В процесі (основні частини готові, тестування та фіналізація)

---

## ✅ Завершені частини

### 1. Content Units система ✅
- **Створено:** `canonical/contentUnits.ts`
  - Модель `ContentUnit` з підтримкою різних типів (article, point, subpoint, etc.)
  - `StruTypeDistribution` для аналізу структури документу
  - `determineParsingStrategy()` для вибору стратегії парсингу

### 2. Універсальний парсер ✅
- **Створено:** `canonical/parseUnits.ts`
  - `parseArticleUnitsFromStru()` — парсинг статей
  - `parsePointUnitsFromStru()` — парсинг пунктів/підпунктів
  - `parseUnitsFromTxt()` — fallback для TXT
  - `parseContentUnits()` — головна функція з автоматичним вибором стратегії

### 3. Рефакторинг buildCanonical.ts ✅
- Інтегровано Content Units
- Автоматичний вибір стратегії (article-based / point-based / fallback)
- Логування стратегії для debug

### 4. Універсальний chunking ✅
- **Оновлено:** `canonical/chunking.ts`
  - `createChunksFromUnits()` — робота з різними типами units
  - Підтримка header context для кращої семантики
  - Групування підпунктів з пунктами (якщо короткі)

### 5. extractLawNumber ✅
- **Створено:** `canonical/extractLawNumber.ts`
  - Витягування з orgnum (найвищий пріоритет)
  - Витягування з nreg
  - Витягування з назви (regex)
  - Unit tests: 5/5 passed ✅

### 6. AI Enrichment покращення (частково) ✅
- **Оновлено:** `lib/aiEnrichment.ts`
  - Додано category в AI enrichment
  - Додано підтримку units та struDistribution
  - Валідація category з списку дозволених
  - Кешування: TODO (потрібно додати перевірку content_hash)

### 7. Debug режим в inspect ✅
- **Оновлено:** `commands/inspect.ts`
  - Аналіз stru.typ розподілу
  - Показ обраної стратегії парсингу
  - Sample stru items для debug

### 8. Парсинг постанов ✅
- **Виправлено:** Постанова 57-95-п тепер має **69 chunks** (було 0)
- **Пошук працює:** "перетин кордону" знаходить постанову в топ-результатах

---

## ⚠️ В процесі / Потребує завершення

### 1. AI Enrichment кешування
- **Статус:** Логіка додана, але потрібно перевіряти content_hash перед AI викликом
- **TODO:** Якщо content_hash не змінився → використовувати існуючий enrichment з Supabase

### 2. Timeout handling для великих документів
- **Статус:** Батчевий embedding вже є (batchSize=32 для >100 chunks)
- **TODO:** 
  - Додати прогресивне оновлення Supabase (після кожного batch embeddings)
  - Додати resume механізм через legislation_import_jobs
  - Покращити Qdrant batch upsert (зараз batch=100, можна оптимізувати)

### 3. Act Group підтримка
- **Статус:** Не реалізовано
- **TODO:**
  - Додати колонки в Supabase: act_group_key, act_part_label, act_is_part
  - Логіка визначення груп (по назві, links з Rada)
  - AI допомога для act_group_key

### 4. Покращення category determination
- **Статус:** AI category додано, але потрібно перевірити чи працює правильно
- **TODO:** Тестування на різних типах документів

---

## 🧪 Тестування

### Успішні тести:
1. ✅ **57-95-п (Постанова):** 
   - Parsed 51 units using strategy: point-based
   - expected_chunks: 69
   - qdrant: acts=1 chunks=69
   - Пошук працює

2. ✅ **extractLawNumber:** 5/5 unit tests passed

### Потрібно протестувати:
1. ⏳ **3543-12 (Закон):** чи працює з новим парсером
2. ⏳ **2341-14 (Кримінальний кодекс):** чи вирішився timeout
3. ⏳ **Batch import:** всі 3 документи разом

---

## 📊 Статистика змін

### Нові файли:
- `canonical/contentUnits.ts` — модель Content Units
- `canonical/parseUnits.ts` — універсальні парсери
- `canonical/extractLawNumber.ts` — системне витягування номера закону
- `test/extractLawNumber.test.ts` — unit tests

### Змінені файли:
- `canonical/buildCanonical.ts` — інтеграція Content Units
- `canonical/chunking.ts` — підтримка Units
- `lib/aiEnrichment.ts` — AI category, units support
- `lib/importer.ts` — передача units до AI, AI category usage
- `commands/inspect.ts` — debug режим

---

## 🎯 Наступні кроки

1. **Протестувати batch import** 3 документів
2. **Завершити AI enrichment кешування**
3. **Додати timeout handling** (прогресивне оновлення)
4. **Додати act_group підтримку** (якщо потрібно)
5. **Фінальна документація**

---

## ✅ Acceptance Criteria Status

### Критерій 1: 57-95-п має chunks > 0
**Статус:** ✅ **ПРОЙДЕНО**
- expected_chunks: 69
- indexed_chunks: 69
- Пошук працює

### Критерій 2: 3543-12 працює
**Статус:** ⏳ Потрібно протестувати

### Критерій 3: 2341-14 без timeout
**Статус:** ⏳ Потрібно протестувати з покращеннями

---

## 🔧 Технічні деталі

### Content Units
- Підтримує: articles, points, subpoints, chapters, sections
- Стратегія визначається автоматично на основі stru.typ розподілу
- Fallback на TXT parsing якщо stru недоступний

### Парсинг постанов
- Використовує parsePointUnitsFromStru()
- Групує короткі підпункти з пунктами
- Створює chunks з header context

### Extract Law Number
- Пріоритет: orgnum > nreg > title regex
- Підтримує римські цифри (XII, III)
- Unit tests покривають основні кейси
