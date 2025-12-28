# DB Readiness Checkpoint — Готовність до проектування БД

## Огляд

Цей документ підсумовує всю архітектуру та модель даних перед переходом до проектування схеми бази даних Supabase.

**Мета:** Переконатися, що архітектура повністю визначена та готова для імплементації БД.

## Підсумок архітектури

### Що ми будуємо

**Legislation RAG система:**
- Завантаження нормативно-правових актів з rada.gov.ua API
- Нормалізація та AI збагачення даних
- Семантичний та лексичний пошук
- Точні цитування на рівні статей
- On-demand імпорт нових документів

### Джерела даних

**rada.gov.ua API:**
- Стабільний ідентифікатор: `nreg`
- Базові метадані: `nazva`, `datred`
- Структура: масив `stru` (ієрархічна)
- Обмеження: немає API пошуку, нестабільна JSON структура

### Інфраструктура

**Supabase (Legislation RAG проект):**
- Метадані документів
- Embeddings для векторного пошуку
- Індекси для швидкого доступу

**Cloudflare R2:**
- Повний контент документів (canonical JSON)
- Довгострокове зберігання
- Великі дані

## Сутності (Entities)

### 1. Document (Нормативно-правовий акт)

**Визначення:**
Окремий нормативно-правовий акт з rada.gov.ua.

**Атрибути:**
- `rada_nreg` (string, primary key): Унікальний ідентифікатор
- `rada_dokid` (number, optional): Додатковий ідентифікатор
- `title` (string): Назва документа
- `document_type` (string): Тип документа (Закон, Кодекс, Постанова, ...)
- `category` (string): Категорія права (цивільне, кримінальне, ...)
- `law_number` (string, optional): Номер закону
- `rada_datred` (date): Дата редакції з API
- `content_hash` (string): SHA-256 hash контенту
- `previous_hash` (string, optional): Попередній hash
- `imported_at` (timestamp): Час імпорту
- `updated_at` (timestamp): Час останнього оновлення
- `r2_path` (string): Шлях до файлу в R2
- `source_url` (string): URL на rada.gov.ua
- `articles_count` (number): Кількість статей
- `is_active` (boolean): Чи активний документ
- `sync_status` (string): Статус синхронізації

**AI-згенеровані атрибути:**
- `embedding` (vector): Векторне представлення документа (1536 dimensions)
- `keywords` (array): Ключові слова
- `topics` (array, optional): Темы документа

**Зв'язки:**
- 1 Document → N Articles (one-to-many)
- 1 Document → 1 Import Job (optional, для batch імпорту)

### 2. Article (Стаття)

**Визначення:**
Окрема стаття документа, основна одиниця для цитування.

**Атрибути:**
- `id` (uuid, primary key): Унікальний ідентифікатор
- `document_nreg` (string, foreign key): Посилання на документ
- `article_number` (string): Номер статті ("123", "123-1")
- `title` (string): Назва статті ("Стаття 123")
- `content` (text): Текст статті
- `created_at` (timestamp): Час створення

**AI-згенеровані атрибути:**
- `embedding` (vector, optional): Векторне представлення статті (1536 dimensions)
- `keywords` (array, optional): Ключові слова статті

**Зв'язки:**
- N Articles → 1 Document (many-to-one)

**Примітка:**
- Таблиця опціональна (можна витягувати з R2 при потребі)
- Рекомендовано для точного пошуку на рівні статей

### 3. Import Job (Завдання імпорту)

**Визначення:**
Завдання для batch імпорту документів.

**Атрибути:**
- `id` (uuid, primary key): Унікальний ідентифікатор
- `status` (string): Статус (pending, running, completed, failed)
- `total_count` (number): Загальна кількість документів
- `processed_count` (number): Оброблено
- `success_count` (number): Успішно
- `error_count` (number): Помилки
- `started_at` (timestamp, optional): Час початку
- `completed_at` (timestamp, optional): Час завершення
- `error_message` (text, optional): Повідомлення про помилку
- `config` (jsonb, optional): Параметри імпорту
- `progress_data` (jsonb, optional): Детальний прогрес

**Зв'язки:**
- 1 Import Job → N Documents (one-to-many, опціонально)

**Примітка:**
- Використовується для відстеження batch імпортів
- Для on-demand імпорту може бути відсутнім

### 4. Structural Unit (Структурна одиниця)

**Визначення:**
Елемент ієрархічної структури документа (розділ, глава, стаття, частина, пункт).

**Примітка:**
- ⚠️ **НЕ зберігається окремо в БД**
- Зберігається в R2 як частина canonical JSON
- Може бути витягнута з R2 при потребі

## Зв'язки (Relations)

### Ієрархія зв'язків

```
Import Job (опціонально)
    │
    └─→ Document (1)
            │
            └─→ Articles (N)
```

### Детальний опис

**1. Document ↔ Article:**
- **Тип:** One-to-Many
- **Cardinality:** 1 Document → N Articles (0..N)
- **Foreign Key:** `articles.document_nreg` → `documents.rada_nreg`
- **Cascade:** ON DELETE CASCADE (видалення документа видаляє статті)

**2. Import Job ↔ Document:**
- **Тип:** One-to-Many (опціонально)
- **Cardinality:** 1 Import Job → N Documents (0..N)
- **Foreign Key:** Неявний (через `imported_at` timestamp)
- **Примітка:** Зв'язок опціональний, може не існувати для on-demand імпорту

## Query Patterns (Що має бути швидко queryable)

### 1. Векторний пошук документів

**Паттерн:**
```sql
SELECT * FROM legislation_documents
WHERE embedding <=> $1::vector < threshold
  AND category = $2  -- Опціональна фільтрація
ORDER BY embedding <=> $1::vector
LIMIT 10;
```

**Вимоги:**
- ✅ Індекс на `embedding` (IVFFlat для pgvector)
- ✅ Фільтрація за `category` (B-tree індекс)
- ✅ Швидкий ORDER BY за similarity

### 2. Лексичний пошук за keywords

**Паттерн:**
```sql
SELECT * FROM legislation_documents
WHERE keywords @> $1::jsonb  -- JSONB contains
  AND category = $2
LIMIT 10;
```

**Вимоги:**
- ✅ GIN індекс на `keywords` (JSONB)
- ✅ B-tree індекс на `category`

### 3. Full-text search за назвою

**Паттерн:**
```sql
SELECT * FROM legislation_documents
WHERE to_tsvector('ukrainian', title) @@ to_tsquery('ukrainian', $1)
ORDER BY ts_rank(...) DESC
LIMIT 10;
```

**Вимоги:**
- ✅ GIN індекс на `to_tsvector('ukrainian', title)`
- ✅ Підтримка української мови

### 4. Пошук за типом документа

**Паттерн:**
```sql
SELECT * FROM legislation_documents
WHERE document_type = $1
  AND category = $2
ORDER BY rada_datred DESC;
```

**Вимоги:**
- ✅ B-tree індекс на `document_type`
- ✅ B-tree індекс на `category`
- ✅ B-tree індекс на `rada_datred` (для сортування)

### 5. Пошук статей за документом

**Паттерн:**
```sql
SELECT * FROM legislation_articles
WHERE document_nreg = $1
  AND article_number = $2  -- Опціонально для конкретної статті
ORDER BY article_number;
```

**Вимоги:**
- ✅ B-tree індекс на `document_nreg`
- ✅ B-tree індекс на `(document_nreg, article_number)` (UNIQUE constraint)
- ✅ Сортування за номером статті

### 6. Векторний пошук статей

**Паттерн:**
```sql
SELECT * FROM legislation_articles
WHERE document_nreg = ANY($1::text[])  -- Документи з попереднього пошуку
  AND embedding <=> $2::vector < threshold
ORDER BY embedding <=> $2::vector
LIMIT 5;
```

**Вимоги:**
- ✅ IVFFlat індекс на `embedding`
- ✅ B-tree індекс на `document_nreg`

### 7. Перевірка наявності документа

**Паттерн:**
```sql
SELECT rada_nreg, content_hash
FROM legislation_documents
WHERE rada_nreg = $1;
```

**Вимоги:**
- ✅ PRIMARY KEY на `rada_nreg` (автоматичний індекс)
- ✅ Швидкий lookup для idempotency

### 8. Пошук документів за датою

**Паттерн:**
```sql
SELECT * FROM legislation_documents
WHERE rada_datred >= $1
  AND rada_datred <= $2
ORDER BY rada_datred DESC;
```

**Вимоги:**
- ✅ B-tree індекс на `rada_datred`

### 9. Статистика імпорту

**Паттерн:**
```sql
SELECT * FROM legislation_import_jobs
WHERE status = 'running'
ORDER BY started_at DESC
LIMIT 1;
```

**Вимоги:**
- ✅ B-tree індекс на `status`
- ✅ B-tree індекс на `started_at`

## Derived Data (Що може бути derived)

### 1. Articles Count

**Поточне рішення:**
- Зберігаємо `articles_count` в `legislation_documents`

**Альтернатива (derived):**
- Можна рахувати `COUNT(*)` з `legislation_articles WHERE document_nreg = $1`
- Але таблиця `legislation_articles` опціональна

**Рекомендація:**
- ✅ Зберігати `articles_count` для швидкого доступу
- Оновлювати при зміні кількості статей

### 2. Structure (Ієрархічна структура)

**Поточне рішення:**
- Зберігається в R2 як частина canonical JSON

**Derived:**
- Може бути витягнута з R2 при потребі
- Не зберігаємо окрему таблицю в БД

**Рекомендація:**
- ✅ Не зберігати в БД (тільки в R2)

### 3. Full Content

**Поточне рішення:**
- Повний контент в R2

**Derived:**
- Завжди витягується з R2 при потребі
- Не зберігаємо в БД (занадто великий розмір)

**Рекомендація:**
- ✅ Не зберігати в БД (тільки в R2)

### 4. Keywords для статей

**Поточне рішення:**
- Можна зберігати в `legislation_articles.keywords`

**Derived:**
- Може бути витягнуто з R2 при потребі

**Рекомендація:**
- ⚠️ Опціонально зберігати в БД (для швидкого пошуку)

### 5. Summary

**Поточне рішення:**
- Зберігається в R2 (AI enrichment)

**Derived:**
- Не зберігаємо в БД
- Можна витягнути з R2 при потребі

**Рекомендація:**
- ✅ Не зберігати в БД (тільки в R2)

## Індекси (Summary)

### legislation_documents

**Обов'язкові індекси:**
1. PRIMARY KEY на `rada_nreg` (автоматичний)
2. IVFFlat індекс на `embedding` (векторний пошук)
3. GIN індекс на `keywords` (JSONB contains)
4. B-tree індекс на `category` (фільтрація)
5. B-tree індекс на `document_type` (фільтрація)
6. B-tree індекс на `rada_datred` (сортування)
7. GIN індекс на `to_tsvector('ukrainian', title)` (full-text search)

**Опціональні індекси:**
- B-tree індекс на `imported_at` (сортування)
- B-tree індекс на `sync_status` (фільтрація)

### legislation_articles

**Обов'язкові індекси (якщо таблиця існує):**
1. PRIMARY KEY на `id` (UUID)
2. UNIQUE constraint на `(document_nreg, article_number)`
3. B-tree індекс на `document_nreg` (foreign key lookup)
4. B-tree індекс на `article_number` (пошук за номером)
5. IVFFlat індекс на `embedding` (векторний пошук, якщо є)
6. GIN індекс на `keywords` (JSONB contains, якщо є)

### legislation_import_jobs

**Обов'язкові індекси:**
1. PRIMARY KEY на `id` (UUID)
2. B-tree індекс на `status` (фільтрація)
3. B-tree індекс на `started_at` (сортування)

## Constraints (Обмеження)

### legislation_documents

**UNIQUE constraints:**
- `rada_nreg` (PRIMARY KEY)

**CHECK constraints:**
- `content_hash` має бути 64 hex символи
- `sync_status` має бути один з: 'synced', 'pending', 'error'

**NOT NULL constraints:**
- `rada_nreg`
- `title`
- `content_hash`
- `source_url`

### legislation_articles

**UNIQUE constraints:**
- `(document_nreg, article_number)`

**FOREIGN KEY constraints:**
- `document_nreg` REFERENCES `legislation_documents(rada_nreg)` ON DELETE CASCADE

**NOT NULL constraints:**
- `document_nreg`
- `article_number`
- `content`

## Готовність до проектування БД

### ✅ Всі необхідні рішення прийняті

1. **Сутності визначені:**
   - Document, Article, Import Job
   - Структурні одиниці не зберігаються окремо

2. **Зв'язки визначені:**
   - Document ↔ Article (one-to-many)
   - Import Job ↔ Document (one-to-many, опціонально)

3. **Query patterns визначені:**
   - Всі основні паттерни пошуку задокументовані
   - Індекси спроектовані

4. **Derived data визначена:**
   - Чітко визначено що зберігається в БД vs R2

5. **Constraints визначені:**
   - UNIQUE, FOREIGN KEY, CHECK, NOT NULL

### ✅ Архітектура повна

1. **Джерела даних:** rada.gov.ua API (аналіз завершено)
2. **Паіплайн імпорту:** Детально описano
3. **Canonical Data Model:** Повністю визначено
4. **R2 Format:** JSON схема фіксована
5. **Storage Strategy:** Розділення R2 vs Supabase визначено
6. **RAG Retrieval:** Логіка пошуку описана
7. **On-Demand Import:** Механізм визначено

### ✅ Готовність підтверджена

**Архітектура та модель даних готові до проектування БД.**

Всі необхідні рішення прийняті, всі деталі визначені, всі query patterns задокументовані.

## Наступні кроки

**Після цього checkpoint:**

1. ✅ **Проектування SQL схеми:**
   - Створення таблиць
   - Створення індексів
   - Створення constraints
   - Створення RPC функцій

2. ✅ **Імплементація:**
   - Імпортер
   - RAG retrieval
   - On-demand import

3. ✅ **Тестування:**
   - End-to-end тести
   - Performance тести

---

## Фінальне підтвердження

**Архітектура & Data Model READY для DB design** ✅

Всі документи створені, всі рішення прийняті, система готова до імплементації.

