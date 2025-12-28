# Стратегія зберігання — Supabase vs R2

## Принцип розділення

**Supabase (PostgreSQL):**
- Метадані та індекси
- Embeddings для пошуку
- Невеликі структуровані дані

**Cloudflare R2:**
- Повний контент документів
- Canonical JSON формат
- Великі текстові дані

## Що зберігається в Supabase

### Таблиця `legislation_documents`

**Призначення:** Метадані документів та embeddings для пошуку.

**Структура:**

```sql
legislation_documents (
  -- Ідентифікатори
  rada_nreg VARCHAR(100) PRIMARY KEY,  -- nreg з API (стабільний ідентифікатор)
  rada_dokid INTEGER,                  -- dokid з API (optional)
  
  -- Базові метадані
  title VARCHAR(500) NOT NULL,         -- Назва документа
  document_type VARCHAR(100),          -- "Закон України", "Кодекс", "Постанова", ...
  category VARCHAR(100),               -- "цивільне", "кримінальне", "трудове", ...
  law_number VARCHAR(100),             -- Номер закону (якщо є)
  
  -- Дати
  rada_datred DATE,                    -- Дата редакції з API (YYYY-MM-DD)
  imported_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Версійність
  content_hash VARCHAR(64),            -- SHA-256 hash контенту
  previous_hash VARCHAR(64),           -- Попередній hash (для визначення змін)
  
  -- Пошук
  embedding vector(1536),              -- OpenAI text-embedding-3-small
  keywords JSONB DEFAULT '[]',         -- Масив ключових слів
  
  -- Зв'язок з R2
  r2_path TEXT,                        -- Шлях до файлу в R2
  source_url VARCHAR(1000),            -- https://data.rada.gov.ua/laws/show/{nreg}
  
  -- Статистика
  articles_count INTEGER DEFAULT 0,    -- Кількість статей в документі
  
  -- Статус
  is_active BOOLEAN DEFAULT true,      -- Чи активний документ
  sync_status VARCHAR(50) DEFAULT 'synced'  -- 'synced', 'pending', 'error'
)
```

**Індекси:**

```sql
-- Для векторного пошуку
CREATE INDEX ON legislation_documents USING ivfflat (embedding vector_cosine_ops);

-- Для категорій та типів
CREATE INDEX ON legislation_documents (category);
CREATE INDEX ON legislation_documents (document_type);

-- Для дат
CREATE INDEX ON legislation_documents (rada_datred);
CREATE INDEX ON legislation_documents (imported_at);

-- Для ключових слів (GIN індекс для JSONB)
CREATE INDEX ON legislation_documents USING GIN (keywords);

-- Для full-text search (якщо потрібно)
CREATE INDEX ON legislation_documents USING gin (to_tsvector('ukrainian', title));
```

### Таблиця `legislation_articles` (опціонально)

**Призначення:** Статті для точного пошуку на рівні статей.

**Структура:**

```sql
legislation_articles (
  -- Ідентифікатори
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_nreg VARCHAR(100) REFERENCES legislation_documents(rada_nreg) ON DELETE CASCADE,
  
  -- Метадані статті
  article_number VARCHAR(50) NOT NULL,  -- "123", "123-1"
  title VARCHAR(500),                   -- "Стаття 123"
  content TEXT NOT NULL,                -- Текст статті
  
  -- Пошук
  embedding vector(1536),               -- Embedding статті
  keywords JSONB DEFAULT '[]',          -- Ключові слова статті
  
  -- Метадані
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Індекси для швидкого пошуку
  UNIQUE(document_nreg, article_number)
)
```

**Індекси:**

```sql
-- Для векторного пошуку
CREATE INDEX ON legislation_articles USING ivfflat (embedding vector_cosine_ops);

-- Для документа
CREATE INDEX ON legislation_articles (document_nreg);

-- Для номерів статей
CREATE INDEX ON legislation_articles (article_number);

-- Для ключових слів
CREATE INDEX ON legislation_articles USING GIN (keywords);
```

### Таблиця `legislation_import_jobs` (для batch імпорту)

**Призначення:** Відстеження прогресу batch імпортів.

**Структура:**

```sql
legislation_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Статус
  status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
  
  -- Прогрес
  total_count INTEGER,                   -- Загальна кількість документів
  processed_count INTEGER DEFAULT 0,     -- Оброблено
  success_count INTEGER DEFAULT 0,       -- Успішно
  error_count INTEGER DEFAULT 0,         -- Помилки
  
  -- Метадані
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  
  -- Конфігурація
  config JSONB,                          -- Параметри імпорту
  progress_data JSONB                    -- Детальний прогрес (список оброблених nreg)
)
```

## Що зберігається в Cloudflare R2

### Структура папок

```
legislation/
  ├── {category}/           # За категорією права
  │   ├── {nreg}.json
  │   └── ...
  │
  ├── {document_type}/      # За типом документа (альтернатива)
  │   ├── {nreg}.json
  │   └── ...
  │
  └── raw/                  # Raw JSON з API (опціонально)
      ├── {nreg}.json
      └── ...
```

**Рекомендована структура:** За категорією права (цивільне, кримінальне, трудове тощо).

**Приклад:**
```
legislation/
  ├── civil/
  │   ├── 435-15.json
  │   ├── 1234-2023.json
  │   └── ...
  ├── criminal/
  │   ├── 2341-14.json
  │   └── ...
  └── labor/
      ├── 123-2024.json
      └── ...
```

### Формат файлу в R2

**Назва файлу:** `{nreg}.json`

**Canonical JSON структура:**

```json
{
  // Ідентифікатори
  "rada_nreg": "435-15",
  "rada_dokid": 12345,
  
  // Базові метадані
  "title": "Цивільний кодекс України",
  "document_type": "Кодекс",
  "category": "цивільне",
  "law_number": "435-IV",
  
  // Дати
  "rada_datred": "2024-01-15",
  "imported_at": "2025-01-10T12:00:00Z",
  "updated_at": "2025-01-10T12:00:00Z",
  
  // Версійність
  "content_hash": "a1b2c3d4e5f6...",
  
  // Структура
  "articles": [
    {
      "number": "123",
      "title": "Стаття 123",
      "content": "Текст статті...",
      "parts": [
        {
          "number": "1",
          "content": "Частина 1..."
        }
      ]
    }
  ],
  
  // Ієрархічна структура (опціонально)
  "structure": {
    "type": "section",
    "title": "Розділ I",
    "children": [
      {
        "type": "chapter",
        "title": "Глава 1",
        "children": [...]
      }
    ]
  },
  
  // Raw дані
  "raw_content_json": {
    // Повний JSON з API rada.gov.ua
  },
  
  // AI збагачення
  "keywords": ["договір", "купівля", "продаж"],
  "topics": ["цивільне право", "договірне право"],
  
  // Посилання
  "source_url": "https://data.rada.gov.ua/laws/show/435-15"
}
```

### Content-Type та метадані

- **Content-Type:** `application/json`
- **Cache-Control:** `public, max-age=86400` (1 день)
- **Метадані:**
  - `nreg`: значення `rada_nreg`
  - `category`: категорія права
  - `document_type`: тип документа
  - `content_hash`: hash контенту

## Версійність та content hash

### Стратегія hash

**Алгоритм:** SHA-256

**Що хешується:**
1. Створюємо canonical representation:
   ```json
   {
     "title": "...",
     "articles": [
       {
         "number": "123",
         "content": "..."
       }
     ],
     "structure": {...}
   }
   ```
2. Нормалізуємо:
   - Сортуємо масиви
   - Прибираємо зайві пробіли
   - Детермінований JSON (без пробілів між полями)
3. Генеруємо hash: SHA-256 → hex string (64 символи)

**Використання:**
- Перед збереженням: генерація `content_hash`
- Перед оновленням: порівняння з `previous_hash`
- Якщо hash змінився → оновлюємо документ
- Якщо hash не змінився → skip (документ не змінився)

### Відстеження змін

1. **При імпорті:**
   - Генеруємо `content_hash`
   - Перевіряємо чи існує документ з таким `rada_nreg`
   - Якщо існує:
     - Порівнюємо `content_hash` з `previous_hash` в БД
     - Якщо різні → оновлюємо (новий контент)
     - Якщо однакові → skip (документ не змінився)

2. **При оновленні:**
   - Зберігаємо старий `content_hash` в `previous_hash`
   - Оновлюємо `content_hash` на новий
   - Оновлюємо `updated_at`

## Naming Conventions

### Supabase таблиці

- Префікс: `legislation_`
- Назви: `snake_case`
- Приклади:
  - `legislation_documents`
  - `legislation_articles`
  - `legislation_import_jobs`

### R2 файли

- **Bucket:** `legislation` (або `legal-documents`)
- **Path pattern:** `{category}/{nreg}.json`
- **Приклад:** `legislation/civil/435-15.json`
- **Альтернатива:** `{document_type}/{nreg}.json`

**Рекомендація:** Використовувати категорію права (цивільне, кримінальне тощо) замість типу документа, бо:
- Менше папок (10 категорій vs багато типів)
- Логічне групування для юристів
- Легше знайти документи

### Поля в БД

- **Ідентифікатори з API:** Префікс `rada_` (`rada_nreg`, `rada_dokid`, `rada_datred`)
- **Наші поля:** Без префіксу (`title`, `category`, `content_hash`)
- **Timestamps:** `_at` суфікс (`imported_at`, `updated_at`)

## Оптимізація зберігання

### Supabase

1. **Розмір embeddings:**
   - `vector(1536)` = ~6KB на документ
   - Для 50k документів: ~300MB embeddings

2. **Індекси:**
   - IVFFlat для векторного пошуку (швидкий, але приблизний)
   - GIN для JSONB keywords
   - B-tree для категорій, дат

3. **Партиціонування** (для майбутнього масштабування):
   - За категорією права
   - За датою імпорту

### R2

1. **Розмір файлів:**
   - Середній документ: ~100-500KB
   - Для 50k документів: ~5-25GB

2. **Кешування:**
   - Public read access
   - Cache-Control headers
   - CDN для швидкого доступу

3. **Архівування** (для майбутнього):
   - Старі версії документів можна архівувати
   - Versioning через content_hash

## Backup та відновлення

### Supabase

- Автоматичні backup через Supabase
- Point-in-time recovery
- Експорт через SQL dump

### R2

- Versioning (опціонально)
- Replication в інший bucket (опціонально)
- Експорт через R2 API

### Стратегія резервування

1. **Регулярні backup:**
   - Supabase: автоматично
   - R2: ручний або через скрипти

2. **Відновлення:**
   - Supabase: через backup restore
   - R2: через re-import з rada.gov.ua API (якщо потрібно)

## Висновок

**Supabase використовується для:**
- Метадані та embeddings (швидкий пошук)
- Індекси для векторного та лексичного пошуку
- Статистика та відстеження

**R2 використовується для:**
- Повний контент документів (canonical JSON)
- Raw дані з API (для майбутнього аналізу)
- Довгострокове зберігання

**Переваги такого підходу:**
- ✅ Швидкий пошук (Supabase з індексами)
- ✅ Економія простору в БД (великі дані в R2)
- ✅ Масштабованість (R2 для великих обсягів)
- ✅ Версійність через content hash

