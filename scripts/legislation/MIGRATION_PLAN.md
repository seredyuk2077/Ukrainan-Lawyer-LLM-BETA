# План міграції Legislation RAG (Supabase + R2 + Qdrant)

**Дата початку:** 2026-01-21  
**Статус:** IN PROGRESS

## 📋 Plan of Attack

### PHASE A — Preflight / Access / AS-IS verification ✅
**Статус:** COMPLETED

**Завдання:**
- [x] Repo scan (структура файлів)
- [x] MCP healthcheck (Supabase, R2, Qdrant)
- [x] AS-IS mapping (які файли за що відповідають)
- [x] Виявлення дрейфу міграцій (Supabase live schema vs migrations)

**Факти (підтверджено):**
- Supabase: 1 документ (Конституція 254к/96-вр), 172 chunks, 0 jobs
- R2: canonical знаходиться за `legislation/constitutional/254%D0%BA%2F96-%D0%B2%D1%80.json` (786KB)
- Qdrant: є скрипт для DocListDB, потрібно створити 2 нові колекції для RAG

---

### PHASE B — Qdrant setup (collections + indexes) ✅
**Статус:** COMPLETED

**Завдання:**
- [x] Створити `lexery_legislation_chunks` (1536 dims, cosine)
- [x] Створити `lexery_legislation_acts` (1536 dims, cosine)
- [x] Налаштувати payload indexes (rada_nreg, content_hash, category, document_type, rada_datred, article_number)
- [x] Створити Qdrant inspector CLI (read-only) - інтегровано в readiness checks

**Ризики:**
- Неправильні параметри колекцій → мітигація: перевірка через inspector перед використанням

---

### PHASE C — Supabase schema improvements (control plane) ✅
**Статус:** COMPLETED

**Завдання:**
- [x] Додати колонки в `legislation_documents`:
  - `indexed_content_hash` (text)
  - `qdrant_status` (enum: pending|indexed|error)
  - `qdrant_indexed_at` (timestamp)
  - `expected_chunks` (int)
  - `indexed_chunks` (int)
  - `last_checked_at` (timestamp)
  - `auto_update` (boolean default false)
  - `last_sync_error` (text)
  - `summary` (text) — AI enrichment
  - `aliases` (jsonb) — AI enrichment
- [x] Додати unique constraint в `legislation_chunks` (document_nreg, content_hash, chunk_index)
- [ ] Оновити `legislation_import_jobs` для логування етапів (буде в PHASE F)
- [x] Створити DB readiness checks скрипт

**Ризики:**
- Зміна схеми може вплинути на існуючі дані → мітигація: всі нові колонки nullable або з default значеннями

---

### PHASE D — R2 hygiene
**Статус:** PENDING

**Завдання:**
- [ ] Підтвердити поточні prefixes і зафіксувати правила
- [ ] Оновити код для чіткого розділення canonical/cache/logs
- [ ] Опційно: додати chunks_manifest у R2

**Ризики:**
- Зміна prefix може зламати існуючі посилання → мітигація: не змінювати існуючі ключі, тільки нові записи

---

### PHASE E — Remove test Constitution everywhere (safe)
**Статус:** PENDING

**Завдання:**
- [ ] Створити CLI команду `remove --nreg "254к/96-вр" --confirm`
- [ ] Видалити з Supabase (cascade до chunks)
- [ ] Видалити з Qdrant (acts + chunks collections)
- [ ] Видалити/архівувати canonical з R2
- [ ] Verification: перевірити що все видалено

**Ризики:**
- Випадкове видалення → мітигація: подвійне підтвердження (--confirm + typed phrase)

---

### PHASE F — New importer + Admin CLI (core deliverable)
**Статус:** PENDING

**Завдання:**
- [ ] Створити CLI структуру (commander.js)
- [ ] Реалізувати команди:
  - `status` — readiness checks
  - `add --nreg "..."` — імпорт одного документа
  - `add-batch --file ...` — batch імпорт
  - `update --nreg "..."` — оновлення (перевірка content_hash)
  - `remove --nreg "..."` — видалення
  - `purge-all` — повне очищення (з підтвердженням)
  - `inspect --nreg "..."` — детальна інформація
- [ ] Пайплайн add/update:
  1. Fetch з rada.gov.ua
  2. Build canonical
  3. Upload canonical → R2
  4. Chunking
  5. AI enrichment (claude-3.7-sonnet): summary, keywords, topics, aliases
  6. Embeddings (openai/text-embedding-3-small)
  7. Supabase upsert
  8. Qdrant upsert (chunks + acts)
  9. Post-verify
  10. Job log
- [ ] Локальна папка `runs/{slug}__{nreg}__{timestamp}/` з preview/report/logs

**Ризики:**
- AI enrichment може бути нестабільним → мітигація: retry logic, fallback
- Qdrant upsert може зазнати невдачі → мітигація: batch processing, retry

---

### PHASE G — Tests / Validation
**Статус:** PENDING

**Завдання:**
- [ ] Smoke tests через CLI
- [ ] Data quality checks (expected_chunks == indexed_chunks)
- [ ] Retrieval sanity test (Qdrant search → R2 extract)

---

### PHASE H — Docs / Cleanup / Commit
**Статус:** PENDING

**Завдання:**
- [ ] Оновити README в scripts/legislation
- [ ] Створити ARCHITECTURE_AS_IS_TO_BE.md
- [ ] Прибрати/позначити застарілі доки
- [ ] Commit зміни

---

## ⚠️ Risks & Mitigations

### Ризик 1: Зламати інтеграцію з глобальною БД
**Мітигація:** НЕ перейменовувати `legislation_documents`, НЕ змінювати `rada_nreg` як PK

### Ризик 2: Втрата даних при видаленні Конституції
**Мітигація:** Подвійне підтвердження, backup перед видаленням (опційно)

### Ризик 3: Неправильні Qdrant point IDs (дублікати)
**Мітигація:** Детерміновані IDs на основі hash(rada_nreg + content_hash + chunk_index)

### Ризик 4: AI enrichment нестабільність
**Мітигація:** Retry logic, валідація JSON, fallback на порожні значення

### Ризик 5: R2 prefix змішування
**Мітигація:** Чіткий стандарт префіксів, не змінювати існуючі ключі

---

## ✅ Definition of Done

- [ ] Qdrant: створені 2 collections з 1536 dims, cosine, payload indexes, inspector працює
- [ ] Supabase: legislation_documents має нові колонки/статуси; unique constraints проти дублів; jobs логуються
- [ ] R2: canonical upload стабільний; prefix policy задокументована; нічого не змішується в нових записах
- [ ] Конституція 254к/96-вр: повністю видалена з Supabase + Qdrant + R2, перевірено
- [ ] Новий імпортер + CLI: add/update/remove/batch/purge/status/inspect працюють
- [ ] Smoke tests пройдені, є технічні звіти (runs/*)
- [ ] Документація оновлена, є ARCHITECTURE, інструкції запуску
- [ ] Все закомічено

---

## 📝 AS-IS Mapping (поточний стан)

### Ключові файли:

**Імпорт:**
- `pipeline_import_one.ts` — основний пайплайн імпорту (fetch → canonical → R2 → embeddings → Supabase)
- `canonical/buildCanonical.ts` — побудова canonical JSON
- `canonical/chunking.ts` — розбиття на chunks
- `canonical/embeddings.ts` — генерація embeddings через OpenRouter
- `canonical/r2Path.ts` — генерація R2 ключів

**Клієнти:**
- `radaClient.ts` — клієнт rada.gov.ua API
- `lib/r2Client.ts` — R2 клієнт
- `lib/r2Upload.ts` — R2 upload утиліти

**Конфігурація:**
- `config.ts` — базові налаштування

**Тести:**
- `test/run-benchmark.ts` — приклад retrieval

### Supabase схема (поточна):
- `legislation_documents`: rada_nreg (PK), content_hash, r2_key, keywords (jsonb), topics (jsonb), chunks_count, sync_status
- `legislation_chunks`: id (PK), document_nreg (FK), r2_key, json_path, chunk_index, embedding (vector 1536), article_number, token_count
- `legislation_import_jobs`: id (PK), status, counts, timestamps, error_message

### R2 структура:
- Canonical: `legislation/{category}/{encoded_nreg}.json`
- Cache: `legislation/ActCatalogResolver/cache/...`
- Logs: `legislation/DocListDB rada gov updater log/...`

### Qdrant (потрібно створити):
- `lexery_legislation_chunks` — не існує
- `lexery_legislation_acts` — не існує
