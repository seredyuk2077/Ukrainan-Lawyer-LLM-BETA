# R2 Canonical Format — Формат зберігання в Cloudflare R2

## Огляд

R2 Canonical Format — це стандартизований JSON формат для зберігання нормативно-правових актів в Cloudflare R2.

**Призначення:**
- Довгострокове зберігання повного контенту
- Канонічний формат для парсингу та обробки
- Версійність та відстеження змін
- Швидкий доступ до повного контенту документів

## Структура папок

### Організація

**Рекомендована структура:** За категорією права

```
legislation/
  ├── civil/              # Цивільне право
  │   ├── 435-15.json
  │   ├── 1234-2023.json
  │   └── ...
  │
  ├── criminal/           # Кримінальне право
  │   ├── 2341-14.json
  │   └── ...
  │
  ├── labor/              # Трудове право
  │   ├── 123-2024.json
  │   └── ...
  │
  ├── family/             # Сімейне право
  │   └── ...
  │
  ├── tax/                # Податкове право
  │   └── ...
  │
  ├── land/               # Земельне право
  │   └── ...
  │
  ├── commercial/         # Господарське право
  │   └── ...
  │
  ├── administrative/     # Адміністративне право
  │   └── ...
  │
  ├── procedural/         # Процесуальне право
  │   └── ...
  │
  └── other/              # Інше
      └── ...
```

**Альтернатива:** За типом документа (не рекомендується через багато типів)

### Формування шляху

**Формат:** `legislation/{category}/{nreg}.json`

**Правила:**
- `category` — нормалізована назва категорії (lowercase, латиниця)
- `nreg` — оригінальний `nreg` з API (може містити спеціальні символи)
- Файл завжди `.json`

**Приклади:**
- `legislation/civil/435-15.json`
- `legislation/criminal/2341-14.json`
- `legislation/labor/123-2024.json`

**Кодування спеціальних символів:**
- URL-encode для `nreg` при формуванні шляху
- `encodeURIComponent(nreg)` в коді

## Naming Conventions

### Категорії права

**Mapping категорій на папки:**

```typescript
{
  "цивільне": "civil",
  "кримінальне": "criminal",
  "трудове": "labor",
  "сімейне": "family",
  "податкове": "tax",
  "земельне": "land",
  "господарське": "commercial",
  "адміністративне": "administrative",
  "процесуальне": "procedural",
  "конституційне": "constitutional",
  "інше": "other"
}
```

**Правила:**
- Тільки латиниця, lowercase
- Без пробілів та спеціальних символів
- Якщо категорія невідома → `other`

### Імена файлів

**Формат:** `{nreg}.json`

**Правила:**
- Оригінальний `nreg` з API (без змін)
- Може містити спеціальні символи (`-`, `/`, `_`)
- Завжди `.json` розширення

**Приклади:**
- `435-15.json`
- `n0388500-25.json`
- `123/2023.json`

## JSON Schema

### Версія 1.0 (поточна)

**Версія формату:** `1.0`

**Мета-поля:**

```json
{
  "version": "1.0",
  "schema_version": "1.0"
}
```

### Повна структура

```json
{
  "version": "1.0",
  "schema_version": "1.0",
  
  "metadata": {
    "rada_nreg": "435-15",
    "rada_dokid": 12345,
    "title": "Цивільний кодекс України",
    "document_type": "Кодекс",
    "category": "цивільне",
    "law_number": "435-IV",
    
    "rada_datred": "2024-01-15",
    "source_url": "https://data.rada.gov.ua/laws/show/435-15",
    
    "imported_at": "2025-01-10T12:00:00Z",
    "updated_at": "2025-01-10T12:00:00Z",
    
    "content_hash": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
    "previous_hash": null
  },
  
  "content": {
    "articles": [
      {
        "number": "123",
        "title": "Стаття 123",
        "content": "Текст статті...",
        "parts": [
          {
            "number": "1",
            "content": "Частина 1...",
            "points": [
              {
                "number": "1",
                "content": "Пункт 1...",
                "subpoints": [
                  {
                    "number": "1",
                    "content": "Підпункт 1..."
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    
    "structure": {
      "type": "document",
      "children": [
        {
          "type": "section",
          "title": "Розділ I",
          "children": [
            {
              "type": "chapter",
              "title": "Глава 1",
              "articles": ["123", "124", "125"]
            }
          ]
        }
      ]
    }
  },
  
  "ai_enrichment": {
    "keywords": ["договір", "купівля", "продаж"],
    "topics": ["цивільне право", "договірне право"],
    "summary": "Короткий опис документа...",
    "classification": {
      "document_type": "Кодекс",
      "category": "цивільне",
      "confidence": 0.95
    }
  },
  
  "raw": {
    "rada_api_json": {
      // Повний JSON з rada.gov.ua API
      // Зберігаємо для майбутнього аналізу
    },
    "rada_api_txt": null  // TXT версія (опціонально, якщо потрібна)
  }
}
```

### Детальний опис полів

#### Root Level

- **`version`** (string, required): Версія формату (зараз `"1.0"`)
- **`schema_version`** (string, required): Версія JSON схеми (зараз `"1.0"`)

#### `metadata`

**Ідентифікатори:**
- `rada_nreg` (string, required): Primary identifier з API
- `rada_dokid` (number, optional): Додатковий ідентифікатор
- `law_number` (string, optional): Номер закону (якщо є)

**Базові метадані:**
- `title` (string, required): Назва документа
- `document_type` (string, required): Тип документа
- `category` (string, required): Категорія права

**Дати:**
- `rada_datred` (string, required): Дата редакції (YYYY-MM-DD)
- `imported_at` (string, required): ISO timestamp імпорту
- `updated_at` (string, required): ISO timestamp оновлення

**Версійність:**
- `content_hash` (string, required): SHA-256 hash контенту
- `previous_hash` (string, optional): Попередній hash (якщо було оновлення)

**Посилання:**
- `source_url` (string, required): URL на rada.gov.ua

#### `content.articles`

**Масив статей:**

```typescript
interface Article {
  number: string;              // "123", "123-1"
  title: string;               // "Стаття 123"
  content: string;             // Текст статті (без HTML)
  parts?: ArticlePart[];       // Частини статті
}

interface ArticlePart {
  number: string;              // "1", "2"
  content: string;             // Текст частини
  points?: ArticlePoint[];     // Пункти
}

interface ArticlePoint {
  number: string;              // "1", "2", "а"
  content: string;             // Текст пункту
  subpoints?: ArticleSubpoint[];  // Підпункти
}

interface ArticleSubpoint {
  number: string;              // "1", "2"
  content: string;             // Текст підпункту
}
```

#### `content.structure`

**Ієрархічна структура (опціонально):**

```typescript
interface StructureNode {
  type: "document" | "section" | "chapter" | "article";
  title?: string;              // Назва (якщо є)
  articles?: string[];         // Номери статей (для chapter)
  children?: StructureNode[];  // Дочірні вузли
}
```

#### `ai_enrichment`

**AI-згенеровані дані:**

- `keywords` (string[], required): Ключові слова
- `topics` (string[], optional): Темы документа
- `summary` (string, optional): Короткий опис
- `classification` (object, optional):
  - `document_type` (string): Тип документа
  - `category` (string): Категорія права
  - `confidence` (number): Впевненість класифікації (0.0-1.0)

#### `raw`

**Raw дані з API:**

- `rada_api_json` (object, required): Повний JSON з API
- `rada_api_txt` (string, optional): TXT версія (якщо збережена)

## Версійність формату

### Стратегія версійності

**Версія формату vs Версія документа:**

1. **Версія формату (`version`, `schema_version`):**
   - Описує структуру JSON
   - Змінюється при зміні схеми
   - Поточна версія: `1.0`

2. **Версія документа (`content_hash`):**
   - Описує версію контенту документа
   - Змінюється при зміні контенту
   - SHA-256 hash

### Правила оновлення формату

**Мажорна версія (1.0 → 2.0):**
- Breaking changes (видалення обов'язкових полів)
- Несумісність з попередніми версіями
- Потрібна міграція даних

**Мінорна версія (1.0 → 1.1):**
- Додавання опціональних полів
- Зміни в опціональних полях
- Зворотна сумісність

**Патч версія (1.0 → 1.0.1):**
- Виправлення помилок
- Уточнення документації
- Повна зворотна сумісність

### Backward Compatibility

**Версія 1.0 гарантує:**
- Всі обов'язкові поля завжди присутні
- Опціональні поля можуть бути відсутні
- Парсери повинні обробляти відсутні опціональні поля

**При майбутніх оновленнях:**
- Нові поля завжди опціональні в першій мінорній версії
- Старі поля залишаються (deprecation замість видалення)
- Міграційні скрипти для оновлення формату

## Re-parsing Strategy

### Коли потрібен re-parsing

**Сценарії:**

1. **Оновлення формату:**
   - Нова версія формату
   - Потрібна міграція даних

2. **Покращення парсингу:**
   - Виявлені помилки в парсингу
   - Покращення алгоритмів витягування статей

3. **Оновлення AI моделей:**
   - Нові моделі для класифікації
   - Потрібно перегенерувати AI enrichment

### Стратегія re-parsing

**Підхід:**

1. **Визначення документів для re-parsing:**
   - За версією формату (старі версії)
   - За датою імпорту (до певної дати)
   - За категорією (окремі категорії)

2. **Re-parsing процес:**
   - Використовуємо `raw.rada_api_json` (оригінальні дані)
   - Застосовуємо новий парсер
   - Генеруємо новий canonical формат

3. **Оновлення:**
   - Перевірка `content_hash` (чи змінився контент)
   - Оновлення файлу в R2 (upsert)
   - Оновлення метаданих в Supabase

**Idempotency:**
- Re-parsing idempotent (можна запускати багато разів)
- Використовуємо `content_hash` для визначення змін

## Валідація формату

### JSON Schema Validation

**Схема валідації:**

Можна використовувати JSON Schema для валідації:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "schema_version", "metadata", "content"],
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+$"
    },
    "schema_version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+$"
    },
    "metadata": {
      "type": "object",
      "required": ["rada_nreg", "title", "document_type", "category", "rada_datred", "content_hash", "source_url"],
      "properties": {
        "rada_nreg": {"type": "string"},
        "title": {"type": "string"},
        ...
      }
    },
    ...
  }
}
```

### Перевірки при збереженні

**Обов'язкові перевірки:**

1. **Структура:**
   - Всі required поля присутні
   - Типи полів відповідають схемі

2. **Валідність даних:**
   - `rada_nreg` відповідає pattern
   - `content_hash` має правильний формат (64 hex символи)
   - Дати у правильному форматі (YYYY-MM-DD, ISO timestamp)

3. **Консистентність:**
   - `content_hash` відповідає фактичному контенту
   - `category` відповідає шляху в R2
   - `metadata.rada_nreg` відповідає імені файлу

## Приклад повного файлу

```json
{
  "version": "1.0",
  "schema_version": "1.0",
  
  "metadata": {
    "rada_nreg": "435-15",
    "rada_dokid": 12345,
    "title": "Цивільний кодекс України",
    "document_type": "Кодекс",
    "category": "цивільне",
    "law_number": "435-IV",
    "rada_datred": "2024-01-15",
    "source_url": "https://data.rada.gov.ua/laws/show/435-15",
    "imported_at": "2025-01-10T12:00:00Z",
    "updated_at": "2025-01-10T12:00:00Z",
    "content_hash": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
    "previous_hash": null
  },
  
  "content": {
    "articles": [
      {
        "number": "123",
        "title": "Стаття 123. Право власності",
        "content": "Кожен має право володіти, користуватися та розпоряджатися своїм майном.",
        "parts": [
          {
            "number": "1",
            "content": "Право власності включає право володіння, користування та розпорядження майном.",
            "points": [
              {
                "number": "1",
                "content": "Володіння - це фактичне володіння майном.",
                "subpoints": []
              },
              {
                "number": "2",
                "content": "Користування - це використання майна згідно з його призначенням.",
                "subpoints": []
              }
            ]
          },
          {
            "number": "2",
            "content": "Право власності може бути обмежене законом.",
            "points": []
          }
        ]
      }
    ],
    "structure": {
      "type": "document",
      "children": [
        {
          "type": "section",
          "title": "Розділ I. Загальні положення",
          "children": [
            {
              "type": "chapter",
              "title": "Глава 1. Право власності",
              "articles": ["123", "124", "125"]
            }
          ]
        }
      ]
    }
  },
  
  "ai_enrichment": {
    "keywords": ["право власності", "майно", "володіння", "користування", "розпорядження"],
    "topics": ["цивільне право", "право власності", "майнові права"],
    "summary": "Цивільний кодекс України регулює цивільні правовідносини...",
    "classification": {
      "document_type": "Кодекс",
      "category": "цивільне",
      "confidence": 0.98
    }
  },
  
  "raw": {
    "rada_api_json": {
      "nreg": "435-15",
      "nazva": "Цивільний кодекс України",
      "datred": 20240115,
      "stru": [
        {
          "id": "o1",
          "typ": "ST",
          "stru": "123",
          "text": "Стаття 123. Право власності..."
        }
      ]
    },
    "rada_api_txt": null
  }
}
```

## Висновок

R2 Canonical Format забезпечує:

- ✅ Стандартизовану структуру папок
- ✅ Чіткі naming conventions
- ✅ Повну JSON схему з усіма полями
- ✅ Версійність формату та документа
- ✅ Backward compatibility
- ✅ Стратегію re-parsing
- ✅ Валідацію формату

Формат готовий для імплементації та зберігання.

