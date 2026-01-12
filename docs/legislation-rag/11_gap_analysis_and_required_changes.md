# Gap Analysis — Аналіз розбіжностей та план змін

## Огляд

Цей документ фіксує критичні розбіжності між поточною реалізацією, документацією та цільовою архітектурою Legislation RAG v2.
Основна мета — перехід від зберігання тексту в БД до векторного пошуку чанків (chunks) з контентом в R2.

**Статус:** КРИТИЧНІ ЗМІНИ НЕОБХІДНІ
**Цільова архітектура:** Supabase (Metadata + Vectors) + R2 (Canonical Content)

## 1. Поточний стан vs Цільова архітектура

### Таблиця розбіжностей

| Характеристика | Поточний стан / Документація | Цільова архітектура (ВИМОГА) | Статус |
|---|---|---|---|
| **Модель зберігання** | Таблиця `legislation_articles` зберігає повний текст (`content` text). | **Текст в БД заборонений.** Текст живе тільки в JSON в R2. | 🔴 CRITICAL |
| **Одиниця пошуку** | "Стаття" (Article) — логічна одиниця. | "Чанк" (Chunk) — семантична одиниця (~512-1024 токенів). | 🔴 CRITICAL |
| **Векторний пошук** | Відсутній у схемі та скриптах. | Обов'язкове поле `embedding` vector(1536) у таблиці чанків. | 🔴 CRITICAL |
| **Retrieval Flow** | `SELECT * FROM articles` | Vector Search → Отримання ID → Завантаження JSON з R2. | 🔴 CRITICAL |
| **Масштабування** | Ліміт ~2k документів через обмеження розміру БД (500MB). | Масштабування до 50k+ документів (мільйони чанків) завдяки R2. | 🔴 CRITICAL |

## 2. Необхідні зміни в БД (Schema Changes)

### 2.1. Видалення концепції `legislation_articles`

Таблиця `legislation_articles` у поточному вигляді (з текстом) не підходить для RAG на великих обсягах даних. Вона має бути замінена на таблицю для машинної обробки.

### 2.2. Нова сутність: `legislation_chunks`

Створюється нова таблиця (або модифікується існуюча), яка слугує виключно індексом для пошуку.

**Структура таблиці:**

```sql
create table public.legislation_chunks (
  id uuid primary key default gen_random_uuid(),
  
  -- Прив'язка до документа
  document_nreg varchar references public.legislation_documents(rada_nreg) on delete cascade not null,
  
  -- Вказівники на контент (Retrieval Pointers)
  r2_key text not null,                     -- Шлях до файлу в R2 (напр. "civil/435-15.json")
  json_path text not null,                  -- Шлях всередині JSON (напр. "articles[5].content")
  chunk_index integer not null,             -- Порядковий номер для сортування
  
  -- Векторний пошук
  embedding vector(1536) not null,          -- OpenAI text-embedding-3-small
  
  -- Метадані для фільтрації (Без тексту!)
  article_number varchar,                   -- Номер статті (для цитування)
  token_count integer,                      -- Розмір чанку в токенах
  
  -- Системні поля
  created_at timestamptz default now()
);

-- Індекси
create index on legislation_chunks using ivfflat (embedding vector_cosine_ops);
create index on legislation_chunks (document_nreg);
```

### 2.3. Оновлення `legislation_documents`

- **Видалити:** Індекси повнотекстового пошуку, якщо вони базуються на контенті в БД.
- **Додати:** Обов'язковість поля `r2_key`.
- **Змінити:** Логіку `articles_count` на `chunks_count` (або підтримувати обидва для статистики).

## 3. Необхідні зміни в логіці (Logic Changes)

### 3.1. Пайплайн імпорту (Importer Pipeline)

**Поточний алгоритм:**
1. Fetch API → Build Canonical → Insert DB (Text).

**Новий алгоритм:**
1. **Fetch API:** Отримання даних.
2. **Build Canonical:** Створення повного JSON.
3. **Chunking:** Розбиття тексту на семантичні чанки (overlap 10-20%).
4. **Embedding:** Генерація векторів через OpenAI API.
5. **R2 Upload:** Завантаження повного JSON в R2.
6. **DB Insert:** 
   - Метадані → `legislation_documents`
   - Вектори та посилання → `legislation_chunks`

### 3.2. Логіка пошуку (Retrieval Flow)

**Новий флоу:**
1. **User Query** → Генерація embedding.
2. **Vector Search** → Пошук у `legislation_chunks`.
3. **Get Pointers** → Отримання списку `(r2_key, json_path, distance)`.
4. **Fetch Content** → Завантаження тексту з R2 (паралельно або з кешу).
5. **Context Construction** → Формування контексту для LLM.

## 4. Обмеження та масштабування

### 4.1. Ліміт Supabase (500MB)

- Один вектор (1536 float) ≈ 6KB.
- Метадані чанку ≈ 0.5KB.
- Всього на чанк ≈ 6.5KB.
- **Ємність:** ~75,000 чанків на 500MB (без урахування індексів).
- **Висновок:** Для пілотного запуску (основні кодекси) цього достатньо. Для повної бази (50k+ документів) знадобиться партиціонування або окремий векторний кластер.

### 4.2. Чому текст в R2?

Зберігання тексту (середній акт 50-100KB) в БД моментально вичерпає ліміт. R2 забезпечує дешеве, безлімітне зберігання канонічних даних.

## 5. План виконання (Next Steps)

### Фаза 1: Міграція БД
- Створення міграції для заміни `legislation_articles` на `legislation_chunks`.
- Додавання векторного розширення (якщо відсутнє).

### Фаза 2: Оновлення імпортера
- Реалізація завантаження в R2 (`R2Client`).
- Реалізація чанкінгу та генерації ембеддінгів.
- Оновлення скрипта `pilot_import_constitution.ts`.

### Фаза 3: Інтеграція RAG
- Реалізація сервісу пошуку (`Retriever`), що працює з R2.
