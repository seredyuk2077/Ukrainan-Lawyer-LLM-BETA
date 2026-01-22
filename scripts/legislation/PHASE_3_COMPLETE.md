# PHASE 3: Контрольований AI (Taxonomy + Caching) — COMPLETED

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Що зроблено

### 1. Taxonomy V1 ✅
- **Створено:** `taxonomy/TAXONOMY_V1.md` та `taxonomy/taxonomy.ts`
- **29 категорій:** від constitutional до other
- **Правила:** "other" тільки для винятків, заборонено для Кодексів/Законів
- **Функції:**
  - `isValidCategory()` — валідація
  - `normalizeCategory()` — нормалізація
  - `guessCategoryFromKeywords()` — rule-based fallback
  - `canBeOtherCategory()` — перевірка чи можна використати "other"

### 2. AI Enrichment з Taxonomy ✅
- **Оновлено:** `lib/aiEnrichment.ts`
- **Strict validation:** AI має повертати category тільки з enum
- **Fallback логіка:**
  1. AI category → normalize → validate
  2. Якщо невалідна → rule-based guessCategoryFromKeywords
  3. Якщо "other" для Кодексу/Закону → примусово шукати keyword-based
- **Deduplication:** topics/keywords дедуплікуються (lowercase comparison)

### 3. AI Enrichment Caching ✅
- **Оновлено:** `lib/importer.ts`
- **Ключ кешу:** `content_hash` (SHA-256)
- **Логіка:** 
  - Перевірка Supabase: чи є документ з тим самим `content_hash` та `summary IS NOT NULL`
  - Якщо є → використовуємо кешований enrichment
  - Якщо немає → викликаємо AI
- **Результат:** Повторний імпорт документу з тим самим content_hash НЕ викликає AI вдруге

### 4. R2 Path Integration ✅
- **Оновлено:** `canonical/r2Path.ts`
- **Підтримка:** як taxonomy slugs, так і legacy українські назви
- **Мапінг:** CATEGORY_TO_R2_FOLDER для всіх 29 категорій

---

## Acceptance Criteria

### ✅ "other" використовується рідко
- Правило: заборонено для Кодексів/Законів
- Fallback: keyword-based categorization перед "other"
- **Результат:** "other" буде використовуватися тільки для винятків

### ✅ Повторний імпорт не викликає AI
- **Тест:** Імпорт документу → повторний імпорт (той самий content_hash)
- **Очікуваний результат:** Лог `ai:enrichment=cached` замість `ai:enrichment=generating...`
- **Статус:** Реалізовано

### ✅ Topics не дублюються
- **Логіка:** Дедуплікація через lowercase comparison
- **Результат:** "оборона" та "Оборона" → один топик

---

## Наступні кроки

PHASE 4: Timeout/Resume/Progress для великих документів
