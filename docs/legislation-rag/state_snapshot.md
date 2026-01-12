# Legislation RAG — State Snapshot

**Дата створення:** 2025-01-10  
**Проєкт:** Ukrainian-Lawyer-LLM-BETA  
**Етап:** Проміжний стан Legislation RAG (Constitution WIP)

---

## Supabase DB Snapshot

**Дата перевірки:** 2025-01-10  
**Project URL:** `https://pitabqxhkfvawkasrcyn.supabase.co`  
**Перевірка виконана через:** MCP Supabase (SQL queries)

### Таблиці Legislation

#### `legislation_documents`
**Призначення:** Метадані нормативно-правових актів з rada.gov.ua

**Row count:** 1

**Ключові колонки:**
- `rada_nreg` (varchar, PK): Унікальний ідентифікатор документа
- `title` (varchar): Назва документа
- `content_hash` (varchar(64)): SHA-256 hash контенту
- `previous_hash` (varchar(64), nullable): Попередній hash (для версійності)
- `r2_key` (text): Шлях до canonical JSON файлу в R2
- `chunks_count` (int): Кількість чанків в документі
- `articles_count` (int): Кількість статей
- `sync_status` (varchar): Статус синхронізації (`synced`/`pending`/`error`)
- `keywords` (jsonb): AI-згенеровані ключові слова
- `topics` (jsonb): AI-згенеровані теми

**Поточний документ:**
- `rada_nreg`: `254к/96-вр`
- `title`: `Конституція України`
- `chunks_count`: `172`
- `articles_count`: `168`
- `sync_status`: `synced`
- `r2_key`: `legislation/constitutional/254%D0%BA%2F96-%D0%B2%D1%80.json`
- `content_hash`: `3817b1176f6cf532cdfd04db50f6c761448d41357f392cebaf710c4d38178d3f`
- `keywords`: присутні (jsonb)
- `topics`: присутні (jsonb)
- `previous_hash`: відсутній (null)

#### `legislation_chunks`
**Призначення:** Семантичні чанки для векторного пошуку. Містить тільки вектори та посилання на R2. Текст зберігається в R2.

**Row count:** 172

**Ключові колонки:**
- `id` (uuid, PK): Унікальний ідентифікатор
- `document_nreg` (varchar, FK): Посилання на документ
- `r2_key` (text): Шлях до файлу в R2
- `json_path` (text): JSONPath до тексту всередині JSON
- `chunk_index` (integer): Порядковий номер чанку
- `embedding` (vector): Векторне представлення чанку
- `article_number` (varchar, nullable): Номер статті
- `token_count` (int, nullable): Розмір чанку в токенах

**Статистика:**
- `total_chunks`: 172
- `chunks_with_embeddings`: 172 (100%)
- `chunks_without_embeddings`: 0
- `chunk_index range`: 0-171 (без пропусків)

**Embeddings:**
- **Тип:** `vector` (PostgreSQL pgvector extension)
- **Розмірність:** 1536 (OpenAI text-embedding-3-small)
- **Модель:** `openai/text-embedding-3-small`
- **API:** OpenRouter
- **Покриття:** 100% (всі chunks мають embeddings)

#### `legislation_import_jobs`
**Призначення:** Завдання для batch імпорту документів

**Row count:** 0

**Статус:** Таблиця створена, але поки не використовується (batch імпорт не запускався)

### Міграції

**Застосовані міграції:**
1. `20251231130227` — `create_legislation_tables`
2. `20260109134925` — `001_enable_vector_extension`
3. `20260109134930` — `002_cleanup_test_data`
4. `20260109134934` — `003_drop_legacy_articles_table`
5. `20260109134944` — `004_create_legislation_chunks`
6. `20260109134951` — `005_create_chunks_indexes`
7. `20260109134959` — `006_update_legislation_documents`
8. `20260109135017` — `007_add_documents_indexes`
9. `20260109214049` — `recreate_match_legislation_chunks`
10. `20260109214107` — `create_match_legislation_chunks_v2`
11. `20260109214140` — `create_match_chunks_v3`
12. `20260109214413` — `recreate_match_chunks_v3_fixed`

### Примітки

- ✅ Конституція України імпортована та синхронізована
- ✅ Всі chunks мають embeddings (100% покриття)
- ✅ `keywords` та `topics` заповнені (AI-згенеровані)
- ⚠️ `previous_hash` не використовується (null) — це нормально для першого імпорту
- ✅ `sync_status` = `synced` — документ повністю синхронізований

**Як перевіряв:**
```sql
-- Row counts
SELECT 'legislation_documents' as table_name, COUNT(*) FROM legislation_documents
UNION ALL
SELECT 'legislation_chunks', COUNT(*) FROM legislation_chunks
UNION ALL
SELECT 'legislation_import_jobs', COUNT(*) FROM legislation_import_jobs;

-- Embeddings coverage
SELECT 
  COUNT(*) as total_chunks,
  COUNT(embedding) as chunks_with_embeddings,
  COUNT(*) - COUNT(embedding) as chunks_without_embeddings
FROM legislation_chunks;

-- Document details
SELECT 
  rada_nreg, title, chunks_count, articles_count, sync_status,
  r2_key, content_hash,
  keywords IS NOT NULL as has_keywords,
  topics IS NOT NULL as has_topics,
  previous_hash IS NOT NULL as has_previous_hash
FROM legislation_documents;
```

---

## Cloudflare R2 Snapshot (verified by script)

**Дата перевірки:** 2025-01-10  
**Bucket:** `legislation` (окремий bucket для Legislation RAG, не Supreme Court)  
**Перевірка виконана через:** 
- MCP Cloudflare R2 (list files)
- Скрипт: `scripts/legislation/r2_verify_and_fix.ts` (для реальних розмірів через AWS SDK)

⚠️ **Важливо:** MCP може показувати некоректні розміри файлів. Для перевірки реальних розмірів використовується скрипт `r2_verify_and_fix.ts`, який використовує AWS SDK `HeadObjectCommand` для отримання точного `ContentLength`.

### Ключові файли

#### Конституція України
- **R2 Key:** `legislation/constitutional/254%D0%BA%2F96-%D0%B2%D1%80.json` (URL-encoded)
- **NREG:** `254к/96-вр`
- **Очікуваний розмір:** ~451 KB (462,056 bytes) — згідно з документацією
- **Статус:** ⚠️ Потрібна перевірка через скрипт для підтвердження реального розміру

**Примітка:** Згідно з документацією (`12_pilot_import_constitution_report.md`), спочатку завантажився мінімальний JSON (660 bytes) через обмеження MCP. Пізніше було реалізовано правильне завантаження через AWS SDK (`13_r2_upload_implementation_report.md`). Потрібна перевірка, що повний файл завантажено.

### Скрипт для перевірки реальних розмірів

**Шлях:** `scripts/legislation/r2_verify_and_fix.ts`

**Використання:**
```bash
pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg="254к/96-вр"
```

**Що робить:**
- Перевіряє розмір файлу в R2 через `HeadObjectCommand` (AWS SDK)
- Порівнює з локальним canonical JSON
- Перевіряє content_hash
- Перевіряє правильність r2_key в DB та chunks
- Може автоматично виправити проблеми з флагом `--fix`

**Альтернативні скрипти:**
- `scripts/legislation/r2_verify_bucket_separation.ts` — перевірка розділення bucket'ів
- `scripts/legislation/r2_repair_document.ts` — ремонт існуючого документа

### Примітки

- ⚠️ MCP `list_files` не знайшов файли з префіксом `legislation/` — можливо, це інший bucket або потрібна перевірка через AWS SDK скрипт
- ✅ Bucket розділення: `legislation` bucket окремий від `legal-court-decisions` (Supreme Court)
- 📝 Для підтвердження реального розміру файлу Конституції використати скрипт `r2_verify_and_fix.ts`

---

## Загальний стан

### Що зроблено
- ✅ Створено схему БД (legislation_documents, legislation_chunks, legislation_import_jobs)
- ✅ Увімкнено pgvector extension для векторного пошуку
- ✅ Імпортовано Конституцію України (1 документ, 172 chunks)
- ✅ Згенеровано embeddings для всіх chunks (1536 dimensions)
- ✅ Заповнено AI-метадані (keywords, topics)
- ✅ Реалізовано правильне завантаження в R2 через AWS SDK

### Що потрібно перевірити
- ⚠️ Реальний розмір файлу Конституції в R2 (через скрипт)
- ⚠️ Правильність JSONPath в chunks
- ⚠️ Повнота canonical JSON в R2 (не мінімальний варіант)

### Наступні кроки
1. Перевірити реальний розмір файлу в R2 через `r2_verify_and_fix.ts`
2. Якщо файл мінімальний — виконати ремонт через `r2_repair_document.ts`
3. Підготуватися до batch імпорту інших документів
4. Тестування RAG retrieval на реальних запитах

---

**Останнє оновлення:** 2025-01-10
