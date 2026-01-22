# Тестовий імпорт Конституції України — Детальний звіт

**Дата:** 2026-01-21  
**Документ:** Конституція України (254к/96-вр)  
**Команда:** `pnpm tsx scripts/legislation/admin-cli.ts add --nreg "254к/96-вр"`

---

## ⏱️ Час виконання

**Загальний час:** 90 секунд (1 хвилина 30 секунд)

**Розбивка:**
- **Started:** 2026-01-21 18:30:59.943 UTC
- **Completed:** 2026-01-21 18:32:30.335 UTC
- **Duration:** 90.392 секунди

**Етапи (оцінка):**
- Fetch з rada.gov.ua: ~5-10 сек (JSON + TXT)
- Build canonical: ~2-3 сек
- Upload canonical → R2: ~2-3 сек
- AI enrichment (Claude 3.7 Sonnet): ~15-20 сек (1 виклик з retry)
- Embeddings generation (172 chunks + 1 act): ~40-50 сек (batch по 3, з затримками)
- Supabase upsert: ~1 сек
- Qdrant upsert (173 points): ~10-15 сек
- Post-verify: ~2-3 сек

---

## 💰 Витрати токенів AI (оцінка)

### AI Enrichment (Claude 3.7 Sonnet через OpenRouter)

**Input (prompt):**
- Title + metadata: ~50 tokens
- Перші 5 статей (по ~500 символів): ~2000-2500 tokens
- Інструкції: ~300 tokens
- **Всього input:** ~2350-2850 tokens

**Output (response):**
- Summary: ~50 tokens
- Keywords (20): ~100 tokens
- Topics (7): ~50 tokens
- Aliases (10): ~80 tokens
- **Всього output:** ~280 tokens

**Загалом Claude 3.7 Sonnet:** ~2630-3130 tokens (1 виклик, retry не знадобився)

### Embeddings (openai/text-embedding-3-small через OpenRouter)

**Chunks embeddings (172 викликів):**
- Середній token_count на chunk: ~80 tokens (з canonical data)
- Загальна кількість tokens для chunks: **~13,726 tokens** (172 chunks × ~80 tokens)
- **Всього викликів:** 172 (batch по 3, з затримками ~500ms між батчами)

**Acts embedding (1 виклик):**
- Input: title + summary + keywords (first 10) = 342 символи = **~86 tokens**
- **Всього викликів:** 1

**Загалом Embeddings:** **~13,812 tokens** (13,726 + 86)

### Загальна оцінка витрат

| Сервіс | Модель | Викликів | Input tokens (приблизно) | Output tokens (приблизно) |
|--------|--------|----------|-------------------------|---------------------------|
| OpenRouter | Claude 3.7 Sonnet | 1 | 2,350-2,850 | 280 |
| OpenRouter | text-embedding-3-small | 173 | 13,812 | 0 (embeddings) |
| **Всього** | | **174** | **~16,162-16,662** | **~280** |

**Примітка:** Точна кількість токенів залежить від реальної tokenization у моделях. Оцінка базується на:
- Canonical data (token_count для chunks)
- Розмірі промптів та responses
- OpenAI tokenizer rules (приблизно 4 символи = 1 token для української)

---

## ✅ Verification — всі етапи

### 1. Fetch з rada.gov.ua

✅ **JSON завантажено:** 8,488 байт  
✅ **TXT завантажено:** 136,324 символів  
✅ **Збережено в runs/:** `rada_raw.json`, `rada_raw.txt`

### 2. Build Canonical

✅ **Canonical JSON побудовано:**
- Articles: 168 статей
- Chunks: 172 chunks
- Content hash: `3817b1176f6cf532cdfd04db50f6c761448d41357f392cebaf710c4d38178d3f`
- R2 key: `legislation/constitutional/254%D0%BA%2F96-%D0%B2%D1%80.json`

✅ **Canonical preview збережено:** `canonical.preview.json` (15 KB)

### 3. Upload Canonical → R2

✅ **R2 upload успішний:**
- Key: `legislation/constitutional/254%D0%BA%2F96-%D0%B2%D1%80.json`
- Size: 760,138 bytes (742.32 KB)
- ETag: підтверджено
- **Guardrails:** ✅ canonical key валідний, не cache/log

### 4. AI Enrichment

✅ **Claude 3.7 Sonnet успішно:**
- Summary: 174 символи (1 речення)
- Keywords: 20 елементів (межі: 10-40) ✅
- Topics: 7 елементів (межі: 3-10) ✅
- Aliases: 10 елементів (межі: 5-15) ✅
- Retry: не знадобився (перший виклик успішний)

✅ **Збережено:** `enrichment.json`

**Приклад enrichment:**
- Summary: "Конституція України є основним законом держави..."
- Keywords: ["конституція", "суверенітет", "незалежність", ...]
- Topics: ["конституційне право", "державний устрій", ...]
- Aliases: ["Основний Закон України", "КУ", "254к/96-ВР", ...]

### 5. Embeddings Generation

✅ **Chunks embeddings:**
- Згенеровано: 172 embeddings (1536 dims кожен)
- Batch size: 3 (з затримками)
- Model: `openai/text-embedding-3-small`

✅ **Acts embedding:**
- Згенеровано: 1 embedding (1536 dims)
- Input: title + summary + keywords
- Model: `openai/text-embedding-3-small`

✅ **Валідація:** всі embeddings мають 1536 dimensions

### 6. Supabase Upsert

✅ **legislation_documents:**
- Upsert успішний (onConflict=rada_nreg)
- **Статуси:**
  - `qdrant_status`: `indexed` ✅
  - `indexed_content_hash`: `3817b1176f6cf532cdfd04db50f6c761448d41357f392cebaf710c4d38178d3f` ✅
  - `indexed_content_hash == content_hash`: ✅ true
  - `expected_chunks`: 172 ✅
  - `indexed_chunks`: 172 ✅
  - `indexed_chunks == expected_chunks`: ✅ true

- **AI enrichment збережено:**
  - `summary`: ✅ присутній (174 символи)
  - `keywords`: ✅ 20 елементів
  - `topics`: ✅ 7 елементів
  - `aliases`: ✅ 10 елементів

- **Інші поля:**
  - `previous_hash`: null (перший імпорт) ✅
  - `last_checked_at`: встановлено ✅
  - `last_sync_error`: null ✅

✅ **legislation_chunks:**
- НЕ заповнювались (embeddings тільки в Qdrant) ✅
- Count: 0 (як очікувалось)

✅ **legislation_import_jobs:**
- Job створено і завершено успішно
- Status: `completed`
- Success count: 1

### 7. Qdrant Upsert

✅ **lexery_legislation_chunks:**
- Upsert успішний: 172 points
- Point IDs: deterministic UUIDs (на основі rada_nreg + content_hash + chunk_index)
- Payload: всі MUST поля присутні ✅
  - rada_nreg, content_hash, chunk_index, article_number, token_count
  - r2_key, json_path, category, document_type, rada_datred
  - title, source_url, previous_hash

✅ **lexery_legislation_acts:**
- Upsert успішний: 1 point
- Point ID: deterministic UUID (на основі rada_nreg + content_hash)
- Payload: всі MUST поля + enrichment ✅
  - summary, keywords (array), topics (array), aliases (array)

✅ **Verification:**
- Count by filter (rada_nreg + content_hash):
  - Chunks: 172 ✅
  - Acts: 1 ✅
- **Matches expected:** ✅ expected_chunks == 172 == qdrant chunks count

### 8. Post-Verify

✅ **Supabase updated:**
- `indexed_chunks` = 172 ✅
- `indexed_content_hash` = content_hash ✅
- `qdrant_status` = 'indexed' ✅
- `qdrant_indexed_at` = встановлено ✅

---

## 🔍 Retrieval Sanity Test

**Команда:** `pnpm tsx scripts/legislation/admin-cli.ts search --query "право власності" --topk 3`

### Результати:

✅ **Qdrant search працює:**
- Знайдено: 3 результати
- Top hit score: 0.6170 (стаття 41)
- Результати релевантні запиту

**Top 3 hits:**
1. **Score: 0.6170** — Стаття 41 (право власності)
   - Snippet: "Кожен має право володіти, користуватися і розпоряджатися своєю власністю..."
   
2. **Score: 0.5186** — Стаття 13 (об'єкти права власності)
   - Snippet: "Земля, її надра... є об'єктами права власності Українського народу..."
   
3. **Score: 0.4888** — Стаття 14 (право власності на землю)
   - Snippet: "Право власності на землю гарантується..."

✅ **R2 extraction працює:**
- json_path правильно витягує текст з canonical JSON
- Snippets коректні та релевантні

---

## 📊 Data Quality Checks

### Counts

| Компонент | Очікувалось | Фактично | Статус |
|-----------|-------------|----------|--------|
| Supabase documents | 1 | 1 | ✅ |
| Supabase chunks | 0 | 0 | ✅ (embeddings в Qdrant) |
| Qdrant chunks | 172 | 172 | ✅ |
| Qdrant acts | 1 | 1 | ✅ |
| R2 canonical | 1 | 1 | ✅ |

### Consistency

✅ **expected_chunks == indexed_chunks:** 172 == 172  
✅ **indexed_content_hash == content_hash:** match  
✅ **qdrant_status == 'indexed':** true  
✅ **Qdrant counts match expected:** chunks=172, acts=1  

### AI Enrichment Quality

✅ **Summary:** присутній, 174 символи, юридично нейтральний  
✅ **Keywords:** 20 (в межах 10-40) ✅  
✅ **Topics:** 7 (в межах 3-10) ✅  
✅ **Aliases:** 10 (в межах 5-15) ✅  

**Приклад aliases:**
- "Основний Закон України"
- "КУ"
- "254к/96-ВР"
- "Конституція 1996"
- "Основний нормативно-правовий акт України"

### R2 Key Validation

✅ **isCanonicalKey:** true  
✅ **isCacheOrLogKey:** false  
✅ **No double-prefix:** true  
✅ **Format:** `legislation/constitutional/{encoded_nreg}.json` ✅  

---

## 📁 Runs Directory Structure

**Run dir:** `scripts/legislation/runs/import__254%...__2026-01-21__18-30-49-804Z/`

**Файли:**
- ✅ `report.json` (590 bytes) — результат імпорту
- ✅ `enrichment.json` (1,839 bytes) — AI enrichment (JSON)
- ✅ `canonical.preview.json` (15,537 bytes) — canonical preview (без raw)
- ✅ `logs.txt` (137 bytes) — текстові логи
- ✅ `rada_raw.json` (12,310 bytes) — raw JSON з rada.gov.ua
- ✅ `rada_raw.txt` (244,526 bytes) — raw TXT з rada.gov.ua

**Примітка:** Canonical preview містить тільки перші 5 статей/chunks (для компактності). Повний canonical зберігається в R2.

## 🔍 Qdrant Detailed Verification

**Sample chunks (first 3):**
- ✅ IDs: deterministic UUIDs (формат RFC 4122 v5)
- ✅ chunk_index: різні (115, 17, 48) — правильно
- ✅ article_number: присутній
- ✅ r2_key: правильний формат
- ✅ json_path: правильний формат `$.content.chunks[<index>].text`

**Act point:**
- ✅ ID: deterministic UUID
- ✅ title: "Конституція України"
- ✅ summary: 174 символи
- ✅ keywords: 20 елементів
- ✅ topics: 7 елементів
- ✅ aliases: 10 елементів

---

## 🎯 Підсумок

### ✅ Всі етапи працюють коректно

1. ✅ Fetch з rada.gov.ua
2. ✅ Build canonical JSON
3. ✅ Upload canonical → R2 (з guardrails)
4. ✅ Chunking (172 chunks)
5. ✅ AI enrichment (Claude 3.7 Sonnet)
6. ✅ Embeddings generation (173 викликів)
7. ✅ Supabase upsert (registry + enrichment)
8. ✅ Qdrant upsert (deterministic IDs)
9. ✅ Post-verify (counts match)
10. ✅ Retrieval test (search працює)

### ✅ Data Quality

- Всі counts співпадають
- Deterministic IDs працюють
- AI enrichment в межах bounds
- Retrieval повертає релевантні результати

### ⏱️ Performance

- **Загальний час:** 90 секунд
- **Найповільніші етапи:** Embeddings (~40-50 сек) та Qdrant upsert (~10-15 сек)

### 💰 AI Costs (оцінка)

**Claude 3.7 Sonnet (1 виклик):**
- Input: ~2,350-2,850 tokens
- Output: ~280 tokens
- **Всього:** ~2,630-3,130 tokens

**text-embedding-3-small (173 виклики):**
- Input: ~13,812 tokens (172 chunks × ~80 tokens/chunk + 1 act × ~86 tokens)
- Output: 0 (embeddings не рахуються як output tokens)
- **Всього:** ~13,812 tokens

**Загальна оцінка:**
- **Total input tokens:** ~16,162-16,662 tokens
- **Total output tokens:** ~280 tokens
- **API викликів:** 174 (1 Claude + 173 embeddings)
- **Загальна вартість:** залежить від цін OpenRouter (Claude 3.7 Sonnet та text-embedding-3-small)

---

## 🔧 Виявлені деталі

1. **Canonical preview:** правильно обрізано raw (тільки перші 5 статей/chunks)
2. **Logs.txt:** мінімальні (тільки ключові етапи) — можна розширити для детальнішого дебагу
3. **Deterministic IDs:** працюють коректно (тест пройдено раніше)
4. **R2 guardrails:** спрацювали (canonical key валідний)
5. **Legislation_chunks:** правильно не заповнюється (embeddings тільки в Qdrant)

---

## ✅ Висновок

**Тестовий імпорт пройшов успішно!**

Всі етапи пайплайну працюють коректно, дані заповнюються правильно, retrieval тест показує релевантні результати. Система готова до production використання.

**Рекомендації:**
- Для batch імпорту врахувати rate limiting (concurrency=2-4)
- Можна додати більше деталей в logs.txt для дебагу
- Опційно: додати метрики токенів у report.json (якщо OpenRouter API повертає usage)
