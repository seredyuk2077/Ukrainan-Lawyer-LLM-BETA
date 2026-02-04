# PHASE 1: Діагностика AS-IS + Risk Register

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## 1.1. AS-IS СТАН СИСТЕМИ

### CLI Команди (Admin CLI)

**Основний entry point:** `scripts/legislation/admin-cli.ts`

**Доступні команди:**
- `add --nreg <nreg>` — імпорт одного документа
- `add-batch --file <path>` — батчевий імпорт з файлу
- `update --nreg <nreg> [--force]` — оновлення документа (skip якщо content_hash не змінився)
- `remove --nreg <nreg> --confirm` — видалення з усіх систем (з підтвердженням)
- `inspect --nreg <nreg>` — детальна діагностика документа (Supabase + Qdrant + R2 + debug stru)
- `status` — загальна статистика (Supabase counts, Qdrant counts)
- `search --query <text> --topk <n>` — RAG пошук для тестування
- `purge-all --confirm` — видалення всіх документів (double confirm)

**Статус:** Всі команди працюють, протестовані на Конституції та Постанові 57-95-п.

---

### Supabase Schema (`legislation_documents`)

**Primary Key:** `rada_nreg` (VARCHAR, NOT NULL)

**Поля (29 колонок):**

**Базові метадані:**
- `rada_nreg` (VARCHAR, PK)
- `rada_dokid` (INTEGER, nullable)
- `title` (VARCHAR, NOT NULL)
- `document_type` (VARCHAR, nullable) — "Конституція", "Закон", "Кодекс", "Постанова КМУ", etc.
- `category` (VARCHAR, nullable) — "конституційне", "кримінальне", "інше", etc.
- `law_number` (VARCHAR, nullable) — номер закону (3543-XII, 2341-III, etc.)
- `rada_datred` (DATE, NOT NULL)
- `source_url` (VARCHAR, NOT NULL)

**Версіонування:**
- `content_hash` (VARCHAR, NOT NULL) — SHA-256 hash canonical content
- `previous_hash` (VARCHAR, nullable) — попередня версія

**R2 Storage:**
- `r2_key` (TEXT, NOT NULL) — формат: `legislation/{category}/{encoded_nreg}.json`

**Timestamps:**
- `imported_at` (TIMESTAMPTZ, default: now())
- `updated_at` (TIMESTAMPTZ, default: now())
- `last_checked_at` (TIMESTAMPTZ, nullable) — для auto-update тригера
- `qdrant_indexed_at` (TIMESTAMPTZ, nullable)

**Статуси індексації:**
- `qdrant_status` (VARCHAR, nullable) — 'pending' | 'indexed' | 'error'
- `sync_status` (VARCHAR, default: 'pending') — legacy, не використовується активно
- `is_active` (BOOLEAN, default: true)

**Chunks tracking:**
- `chunks_count` (INTEGER, default: 0) — legacy поле
- `expected_chunks` (INTEGER, nullable) — кількість chunks з canonical
- `indexed_chunks` (INTEGER, nullable) — фактична кількість в Qdrant
- `articles_count` (INTEGER, default: 0) — legacy

**AI Enrichment:**
- `summary` (TEXT, nullable) — AI-generated summary
- `keywords` (JSONB, default: '[]') — AI-generated keywords array
- `topics` (JSONB, default: '[]') — AI-generated topics array
- `aliases` (JSONB, default: '[]') — AI-generated aliases array
- ⚠️ **ВІДСУТНІ:** `ai_enriched_at`, `ai_enrichment_hash`, `ai_category` (category зараз зберігається в `category`)

**Auto-update:**
- `auto_update` (BOOLEAN, default: false)
- `last_sync_error` (TEXT, nullable)

**Indexed state:**
- `indexed_content_hash` (TEXT, nullable) — який content_hash реально в Qdrant

**⚠️ ВІДСУТНІ ПОЛЯ ДЛЯ PHASE 5 (act_group):**
- `act_group_key` — потрібно додати
- `act_part_label` — потрібно додати
- `act_is_part` — потрібно додати
- `act_group_title` — потрібно додати

---

### Qdrant Collections

#### `lexery_legislation_chunks`

**Параметри:**
- Vector size: 1536 (openai/text-embedding-3-small)
- Distance: Cosine
- Point ID: Deterministic UUID v5 від `(rada_nreg + content_hash + chunk_index)`

**Payload indexes (для фільтрації/пошуку):**
- `rada_nreg` (keyword)
- `content_hash` (keyword)
- `category` (keyword)
- `document_type` (keyword)
- `rada_datred` (datetime)
- `article_number` (keyword, nullable)
- `chunk_index` (integer)

**Payload structure (ChunkPayload):**
```typescript
{
  rada_nreg: string;
  content_hash: string;
  chunk_index: number;
  article_number: string | null;
  token_count: number | null;
  r2_key: string;
  json_path: string; // format: "$.content.chunks[<index>].text"
  category: string;
  document_type: string;
  rada_datred: string;
  title: string;
  source_url: string;
  previous_hash: string | null;
}
```

**⚠️ ВІДСУТНІ ПОЛЯ ДЛЯ PHASE 5:**
- `act_group_key` — потрібно додати
- `unit_type` — потрібно додати для розрізнення article/point/chapter

---

#### `lexery_legislation_acts`

**Параметри:**
- Vector size: 1536 (embedding від title + summary + keywords)
- Distance: Cosine
- Point ID: Deterministic UUID v5 від `(rada_nreg + content_hash)`

**Payload indexes:**
- `rada_nreg` (keyword)
- `content_hash` (keyword)
- `category` (keyword)
- `document_type` (keyword)
- `rada_datred` (datetime)

**Payload structure (ActPayload):**
```typescript
{
  rada_nreg: string;
  content_hash: string;
  previous_hash: string | null;
  title: string;
  category: string;
  document_type: string;
  rada_datred: string;
  source_url: string;
  r2_key: string;
  summary: string; // AI-generated
  keywords: string[]; // AI-generated
  topics: string[]; // AI-generated
  aliases: string[]; // AI-generated
}
```

**⚠️ ВІДСУТНІ ПОЛЯ ДЛЯ PHASE 5:**
- `act_group_key` — потрібно додати

---

### R2 Storage Structure

**Bucket:** `legislation` (Cloudflare R2)

**Canonical JSON формат:**
- Prefix: `legislation/`
- Pattern: `legislation/{category}/{encodeURIComponent(nreg)}.json`
- Category values: "constitutional", "criminal", "civil", "other", etc.
- Example: `legislation/constitutional/254к%2F96-%D0%B2%D1%80.json`

**⚠️ ВАЖЛИВО — НЕ ЧІПАТИ:**
- `legislation/ActCatalogResolver/cache/...` — кеш мікросервісу (не рухати!)
- `legislation/DocListDB rada gov updater log/...` — логи апдейтера (не рухати!)
- Supreme Court bucket — окремий бакет, не чіпати

**⚠️ НОВІ ПРЕФІКСИ (для PHASE 3):**
- `legislation/_lexery_registry/` — для taxonomy/topics registry (новий, не конфліктує)
- `legislation/_lexery_enrichment/` — для AI enrichment cache (новий, не конфліктує)
- Format: `legislation/_lexery_enrichment/{encoded_nreg}/{content_hash}.json`

**Archive (для видалених):**
- Prefix: `legislation/archive/` (використовується в remove command)

---

### Jobs Tracking (`legislation_import_jobs`)

**Статус:** Таблиця існує, але використовується частково.

**Поля (з MIGRATION_COMPLETE.md):**
- `id` (PK)
- `status` (VARCHAR) — 'running' | 'completed' | 'failed'
- `total_count`, `processed_count`, `success_count`, `error_count`
- `started_at`, `completed_at`
- `config` (JSONB) — параметри імпорту
- `progress_data` (JSONB) — поточний прогрес

**⚠️ ПОТРЕБУЄ РОЗШИРЕННЯ ДЛЯ PHASE 4:**
- `document_nreg` — для single-doc jobs
- `content_hash` — для resume tracking
- `stage` — 'fetched' | 'canonical_built' | 'r2_uploaded' | 'embeddings_started' | 'qdrant_upserted' | 'done'
- `stage_progress` — "{batch_i}/{total_batches}" для embeddings/qdrant
- `last_error` — детальна помилка для retry

---

## 1.2. RISK REGISTER

### Failure Modes

#### 1. Парсинг та структура

| Ризик | Імовірність | Вплив | Мітигація |
|-------|-------------|-------|-----------|
| Відсутній `stru` в JSON | Середнє | Високий | Fallback на TXT parsing (реалізовано частково) |
| Кривий/неповний `stru` (0 units) | Низьке | Високий | TXT fallback + "0 chunks detection" (реалізовано) |
| Відсутні статті (тільки пункти) | Високе | Середній | ✅ Вирішено через point-based strategy |
| Великі документи (timeout) | Високе | Високий | Батчевий embedding + resume (частково) |
| Encoding issues (non-UTF-8) | Низьке | Середній | Додати encoding detection + conversion |
| Структурні аномалії (дублікати tree_id) | Середнє | Низький | Validation + deduplication в parseUnits |

#### 2. Rada API та rate limits

| Ризик | Імовірність | Вплив | Мітигація |
|-------|-------------|-------|-----------|
| Rate limits / 429 | Високе | Середній | ✅ Exponential backoff + паузи (частково) |
| Token expiration | Середнє | Низький | ✅ Token caching (реалізовано) |
| Нестабільний txt/html | Середнє | Середній | ✅ Fallback на stru (реалізовано) |
| Missing fields (datred, organs) | Низьке | Низький | ✅ Validation + default values |

#### 3. AI Enrichment

| Ризик | Імовірність | Вплив | Мітигація |
|-------|-------------|-------|-----------|
| AI повертає невалідний JSON | Високе | Низький | ✅ Retry + JSON extraction (реалізовано) |
| AI повертає category поза enum | Високе | Середній | ⚠️ PHASE 3: Strict validation + fallback |
| Дуже багато topics/keywords (dedup) | Високе | Низький | ⚠️ PHASE 3: Topic registry + canonicalization |
| Rate limits OpenRouter | Середнє | Середній | ✅ Backoff + retry (реалізовано) |
| Кешування не працює (дубль-виклики) | Високе | Низький | ⚠️ PHASE 3: content_hash-based cache |

#### 4. Qdrant / Embeddings

| Ризик | Імовірність | Вплив | Мітигація |
|-------|-------------|-------|-----------|
| Timeout на великих документах | Високе | Високий | ⚠️ PHASE 4: Progressive commits + resume |
| Мережеві помилки при upsert | Середнє | Середній | ✅ Retry в Qdrant client (частково) |
| Embedding batch failures | Низьке | Середній | ✅ Error handling + partial retry (реалізовано) |

#### 5. Data Quality

| Ризик | Імовірність | Вплив | Мітигація |
|-------|-------------|-------|-----------|
| Дублікати nreg (різні частини) | Середнє | Високий | ⚠️ PHASE 5: act_group для групування |
| "other" категоризація надто широка | Високе | Середній | ⚠️ PHASE 3: AI taxonomy + validation |
| 0 chunks для значущих актів | Низьке | Високий | ✅ Fallback + validation (реалізовано) |

#### 6. Інтеграції та безпека

| Ризик | Імовірність | Вплив | Мітигація |
|-------|-------------|-------|-----------|
| Зламати R2 prefixes (cache/logs) | Низьке | Критичний | ✅ Guardrails + prefix validation (реалізовано) |
| Зламати Supreme Court bucket | Низьке | Критичний | ✅ Окремий bucket, не чіпаємо |
| Масове видалення без confirm | Низьке | Критичний | ✅ Double confirm в CLI (реалізовано) |

---

## 1.3. ПЛАН ВИКОНАННЯ (UPDATED)

### PHASE 1: Діагностика ✅
- [x] AS-IS документація
- [x] Risk Register
- [x] Оновлення плану

### PHASE 2: Parsing Hardening (Content Units v2)
**Цілі:**
- Розширити підтримку tree_id prefixes (zg|ty|kn|rz|gl|st|nz|pr|fr|ch|pu|pp|cm...)
- Додати ChapterBased, AnnexBased стратегії
- Нормалізація тексту з юридичною семантикою
- Гарантувати "0 chunks" тільки для порожніх документів

**Acceptance:**
- Парсинг працює для 10+ різних типів документів (Закон, Кодекс, Постанова, Указ, Наказ, Рішення)
- 0 chunks тільки якщо документ реально порожній

### PHASE 3: Контрольований AI (Taxonomy + Caching)
**Цілі:**
- Канонічний enum категорій (~20-30)
- AI category з validation + fallback
- Topic registry + дедуплікація
- content_hash-based кешування AI enrichment

**Acceptance:**
- "other" використовується рідко (<10% для важливих актів)
- Повторний імпорт (той самий content_hash) не викликає AI
- Topics не дублюються (канонізація)

### PHASE 4: Timeout/Resume/Progress
**Цілі:**
- Resume через import_jobs
- Progressive commits (після кожного batch embeddings/qdrant)
- Retry/backoff для всіх операцій

**Acceptance:**
- ККУ (2341-14) імпортується без timeout
- Resume працює (продовження після падіння)

### PHASE 5: Act Group (багаточастинні акти)
**Цілі:**
- Додати поля act_group_key, act_part_label, act_is_part
- Heuristics для визначення груп
- Qdrant payload оновлення

**Acceptance:**
- КУпАП або подібний багаточастинний акт групуються правильно

### PHASE 6: Rada Open Data Utilities
**Цілі:**
- Модуль для doc/ist довідників
- Preflight перед імпортом
- Last-Modified / If-Modified-Since

**Acceptance:**
- Preflight працює для оцінки розміру/типу

### PHASE 7: Тести + Corpus + Репорти
**Цілі:**
- Тестовий корпус (20-30 nreg)
- Unit + integration tests
- Системні репорти

**Acceptance:**
- Batch import corpus працює
- Репорт показує стратегії, timings, errors

### PHASE 8: Документація
**Цілі:**
- Оновити README/ARCHITECTURE
- How to operate guide
- Migration notes

---

## ВИСНОВКИ

✅ **Система в хорошому стані:**
- Базовий парсинг працює (articles + points)
- Qdrant індексація працює
- CLI команди функціональні

⚠️ **Критичні прогалини:**
1. AI enrichment не кешується (PHASE 3)
2. Timeout на великих документах (PHASE 4)
3. Категоризація занадто широка "other" (PHASE 3)
4. Немає act_group для багаточастинних актів (PHASE 5)

🎯 **Наступні кроки:**
1. PHASE 3 (AI caching) — критично для продуктивності
2. PHASE 4 (Resume) — критично для великих документів
3. PHASE 2 (Parsing expansion) — для покриття всіх типів
4. PHASE 5 (Act group) — для UX
