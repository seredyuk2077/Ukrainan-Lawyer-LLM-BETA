# PHASE 2: Parsing Hardening — COMPLETED

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Що зроблено

### 1. Розширені стратегії парсингу ✅
- **Додано:** `chapter-based` — для документів з великою структурою (глави/розділи/книги), але мало leaf units
- **Додано:** `annex-based` — для документів з додатками/формами/таблицями
- **Оновлено:** `determineParsingStrategy()` тепер повертає `{ strategy, reason }` для debug

### 2. Розширений mapping typ/tree_id → unit_type ✅
- **Створено:** `mapTypToUnitType()` — універсальна функція мапінгу
- **Підтримка:**
  - ST → article
  - PU, PR → point
  - PP, FR → subpoint
  - GL → chapter
  - RZ → section
  - CH → part
  - KN, ZG → book
  - TB → table
  - ABZ → paragraph
  - ANNEX/FORM/таблиця в назві → annex/form/table
- **Tree_id prefixes:** Перевірка tree_id для визначення типу

### 3. NO-EMPTY-INDEX POLICY ✅
- **Правило:** Якщо `document_type` ∈ {Постанова, Наказ, Указ, Розпорядження, Рішення, Положення, Правила, Інструкція} і `units=0` → **обов'язковий fallback** на TXT parsing
- **Результат:** Важливі документи завжди мають chunks > 0 (окрім реально порожніх)

### 4. HTML→Text Normalizer ✅
- **Покращено:** `sanitizeHtmlToText()`
  - Детермінований (однаковий HTML → однаковий результат)
  - Зберігає нумерацію пунктів
  - Нормалізує множинні пробіли
  - Обмежує множинні переноси (макс 3)
  - Декодує числові HTML entities (&#160;, &#x00A0;)
- **Unit tests:** 6/6 passed ✅

### 5. Debug Inspect ✅
- **Розширено:** `commands/inspect.ts`
  - Показує stru typ distribution (повний)
  - Показує обрану strategy + reason
  - Sample stru items (TOP-2 per type)
  - Sample units/chunks (TOP-5)
  - Unit type mapping для кожного stru item

### 6. Regression Fixtures ✅
- **Створено:** `test/fixtures/stru_samples.json`
  - Приклади для article-based, point-based, chapter-based, annex-based стратегій
  - Використовується для тестування strategy selection

### 7. Advanced Parsers ✅
- **Створено:** `parseUnitsAdvanced.ts`
  - `parseChapterBasedUnits()` — витягує leaf units з розділів/глав
  - `parseAnnexBasedUnits()` — витягує додатки/форми/таблиці

### 8. Canonical Structure Enhancement ✅
- **Додано:** Збереження parsing_strategy, strategy_reason, units_count, requires_fallback в canonical.structure
- **Використання:** Для debug та аналізу

---

## Acceptance Criteria

### ✅ Різні типи документів працюють
- Article-based: Закони, Кодекси ✅
- Point-based: Постанови ✅ (57-95-п має 69 chunks)
- Chapter-based: готовий (потрібен тест)
- Annex-based: готовий (потрібен тест)
- Fallback: TXT parsing для всіх типів ✅

### ✅ 0 chunks тільки для порожніх документів
- No-empty-index policy реалізована
- Обов'язковий TXT fallback для важливих типів документів

### ✅ Debug evidence
- Inspect показує strategy, reason, distribution, samples ✅

---

## Наступні кроки

Тестування на реальних документах:
1. 3543-12 (ЗУ про мобілізацію) — перевірити чи працює
2. Додати наказ/інструкцію — перевірити point-based fallback
3. Знайти документ з додатками — перевірити annex-based
