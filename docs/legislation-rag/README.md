# Legislation RAG — Документація архітектури

Ця папка містить повну документацію архітектури системи Legislation RAG.

## 📚 Структура документації

### 1. [Огляд системи](./01_overview.md)
Що таке Legislation RAG, як воно відрізняється від поточної реалізації, як пов'язано з Supreme Court RAG.

**Ключові теми:**
- Архітектурні принципи
- Відмінності від прототипу
- Інтеграція з Supreme Court RAG

### 2. [Джерела даних](./02_data_sources.md)
Детальний аналіз rada.gov.ua API: що ми довіряємо, що нормалізуємо, що збагачуємо.

**Ключові теми:**
- Стабільні ідентифікатори (`nreg`, `dokid`)
- Структура даних (`stru` масив)
- Обмеження API
- Наша нормалізація

### 3. [Паіплайн імпорту](./03_ingestion_pipeline.md)
Крок за кроком: як дані проходять від rada.gov.ua до готового для RAG стану.

**Ключові теми:**
- Завантаження з API
- Парсинг та нормалізація
- AI класифікація
- Генерація embeddings
- Збереження в R2 та Supabase

### 4. [Стратегія зберігання](./04_storage_strategy.md)
Що зберігається де: Supabase для метаданих та embeddings, R2 для повного контенту.

**Ключові теми:**
- Структура таблиць Supabase
- Структура папок R2
- Версійність через content hash
- Naming conventions

### 5. [RAG Retrieval](./05_rag_retrieval.md)
Як працює пошук: гібридний пошук (семантичний + лексичний), точні цитування.

**Ключові теми:**
- Семантичний пошук (векторний)
- Лексичний пошук (keywords, full-text)
- Гібридний підхід
- Пошук на рівні статей
- Форматування контексту для LLM

### 6. [On-Demand Import](./06_on_demand_import.md)
Динамічне додавання нових документів під час роботи системи.

**Ключові теми:**
- Коли потрібен on-demand import
- AI рішення про необхідність імпорту
- Синхронний vs асинхронний режим
- Захист від зловживань
- Інтеграція в RAG flow

### 7. [Дизайн імпортера](./07_importer_design.md)
Детальний дизайн bulk імпортера для 2k-5k документів.

**Ключові теми:**
- Input sources та batching strategy
- Rate limiting та retry logic
- Idempotency та progress tracking
- Failure recovery
- AI виклики в імпортері

### 8. [Canonical Data Model](./08_canonical_data_model.md)
Концептуальна модель даних, незалежна від БД.

**Ключові теми:**
- Act, Structural Unit, Article
- RAG Chunk та AI Metadata
- Ідентифікатори та версійність
- Content hashing strategy

### 9. [R2 Canonical Format](./09_r2_format.md)
Стандартизований JSON формат для зберігання в Cloudflare R2.

**Ключові теми:**
- Структура папок та naming conventions
- JSON schema v1.0
- Версійність формату
- Backward compatibility
- Re-parsing strategy

### 10. [DB Readiness Checkpoint](./10_db_readiness.md)
Підсумок архітектури перед проектуванням БД.

**Ключові теми:**
- Сутності та зв'язки
- Query patterns та індекси
- Derived data
- Підтвердження готовності

### 11. [State Snapshot](./state_snapshot.md)
Фактичний стан Supabase DB та Cloudflare R2 (проміжний етап).

**Ключові теми:**
- Поточні таблиці та row counts
- Embeddings тип/розмірність
- R2 файли та розміри (verified by script)
- Статус імпорту Конституції

## 🎯 Як читати документацію

### Для архітекторів:
1. Почніть з [Огляду](./01_overview.md)
2. Прочитайте [Джерела даних](./02_data_sources.md)
3. Перегляньте [Canonical Data Model](./08_canonical_data_model.md)
4. Ознайомтесь з [DB Readiness Checkpoint](./10_db_readiness.md)

### Для розробників:
1. Прочитайте всі документи послідовно
2. Особлива увага на [Паіплайн імпорту](./03_ingestion_pipeline.md)
3. Зрозумійте [Дизайн імпортера](./07_importer_design.md)
4. Вивчіть [RAG Retrieval](./05_rag_retrieval.md) для інтеграції
5. Ознайомтесь з [R2 Format](./09_r2_format.md) для зберігання

### Для тестувальників:
1. [Паіплайн імпорту](./03_ingestion_pipeline.md) — що тестувати
2. [RAG Retrieval](./05_rag_retrieval.md) — як перевірити пошук
3. [On-Demand Import](./06_on_demand_import.md) — edge cases
4. [Дизайн імпортера](./07_importer_design.md) — failure scenarios

## 📊 Статус документації

### Phase 1: Архітектурна документація
- ✅ [01_overview.md](./01_overview.md) — Завершено
- ✅ [02_data_sources.md](./02_data_sources.md) — Завершено
- ✅ [03_ingestion_pipeline.md](./03_ingestion_pipeline.md) — Завершено
- ✅ [04_storage_strategy.md](./04_storage_strategy.md) — Завершено
- ✅ [05_rag_retrieval.md](./05_rag_retrieval.md) — Завершено
- ✅ [06_on_demand_import.md](./06_on_demand_import.md) — Завершено

### Phase 2: Планування та дизайн
- ✅ [07_importer_design.md](./07_importer_design.md) — Завершено
- ✅ [08_canonical_data_model.md](./08_canonical_data_model.md) — Завершено
- ✅ [09_r2_format.md](./09_r2_format.md) — Завершено
- ✅ [10_db_readiness.md](./10_db_readiness.md) — Завершено

### Phase 3: Реалізація та тестування
- ✅ [11_gap_analysis_and_required_changes.md](./11_gap_analysis_and_required_changes.md) — Завершено
- ✅ [12_pilot_import_constitution_report.md](./12_pilot_import_constitution_report.md) — Завершено
- ✅ [13_r2_upload_implementation_report.md](./13_r2_upload_implementation_report.md) — Завершено
- ✅ [state_snapshot.md](./state_snapshot.md) — Поточний стан (2025-01-10)

## 🔗 Пов'язані документи

- [RADA_API_ANALYSIS.md](../RADA_API_ANALYSIS.md) — Детальний аналіз rada.gov.ua API
- [RADA_API_DOCUMENTATION.md](../RADA_API_DOCUMENTATION.md) — Документація API
- [supreme_court_rag.md](../supreme_court_rag.md) — Архітектура Supreme Court RAG (концептуальна референція)

## 🚀 Наступні кроки

**PLANNING & ARCHITECTURE PHASE завершено** ✅

Тепер система готова до:
1. **Проектування SQL схеми Supabase**
2. **Імплементації імпортера**
3. **Імплементації RAG retrieval**
4. **Інтеграції в Edge Function**

---

**Дата створення:** 2025-01-10  
**Останнє оновлення:** 2025-01-10  
**Статус:** Planning & Architecture Phase завершено ✅

**Готовність до DB design:** ✅ **READY**

