# Звіт про прогрес міграції Legislation RAG

**Дата:** 2026-01-21  
**Статус:** IN PROGRESS (60% завершено)

## ✅ Завершені фази

### PHASE A — Preflight ✅
- Repo scan виконано
- MCP healthcheck пройдено
- AS-IS mapping задокументовано
- Дрейф міграцій виявлено та вирівняно

### PHASE B — Qdrant Setup ✅
- Створено колекції:
  - `lexery_legislation_chunks` (1536 dims, Cosine)
  - `lexery_legislation_acts` (1536 dims, Cosine)
- Налаштовано payload indexes
- Smoke test пройдено успішно

**Файли:**
- `setup_qdrant_rag.ts` — скрипт створення колекцій

### PHASE C — Supabase Schema ✅
- Додано нові колонки в `legislation_documents`:
  - indexed_content_hash, qdrant_status, qdrant_indexed_at
  - expected_chunks, indexed_chunks, last_checked_at
  - auto_update, last_sync_error
  - summary, aliases (AI enrichment)
- Додано unique constraint в `legislation_chunks`
- Створено readiness checks скрипт

**Файли:**
- Міграція: `add_qdrant_tracking_fields`
- `check_readiness.ts` — перевірка готовності

## 🚧 В процесі

### PHASE F — New Importer + Admin CLI (60%)
- ✅ Створено Qdrant RAG client (`lib/qdrantRagClient.ts`)
- ✅ Створено AI enrichment module (`lib/aiEnrichment.ts`)
- ✅ Створено базову структуру CLI (`admin-cli.ts`)
- ⏳ Потрібно: повний імпортер з інтеграцією всіх компонентів
- ⏳ Потрібно: команди add/remove/inspect (базова структура є)

**Файли:**
- `lib/qdrantRagClient.ts` — клієнт для Qdrant
- `lib/aiEnrichment.ts` — AI enrichment через Claude
- `admin-cli.ts` — головний CLI файл
- `commands/status.ts` — команда status

## ⏳ Очікують виконання

### PHASE D — R2 Hygiene
- Підтвердити поточні prefixes
- Зафіксувати правила
- Опційно: chunks_manifest

### PHASE E — Remove Test Constitution
- Створити команду remove
- Видалити з Supabase + Qdrant + R2
- Verification

### PHASE F — Completion
- Повний імпортер з інтеграцією:
  - Fetch → canonical → R2
  - Chunking → embeddings
  - AI enrichment
  - Supabase upsert
  - Qdrant upsert (chunks + acts)
  - Post-verify
- Команди: add/update/remove/batch/purge/inspect
- Runs/ directory для логів

### PHASE G — Tests
- Smoke tests
- Data quality checks
- Retrieval sanity test

### PHASE H — Docs + Commit
- Оновити README
- Створити ARCHITECTURE_AS_IS_TO_BE.md
- Commit зміни

## 📝 Наступні кроки

1. **Завершити PHASE F:**
   - Створити повний імпортер (`lib/importer.ts`)
   - Інтегрувати всі компоненти (fetch → canonical → R2 → chunking → AI → embeddings → Supabase → Qdrant)
   - Реалізувати команди add/remove/inspect

2. **PHASE E:**
   - Реалізувати команду remove для Конституції
   - Видалити з усіх систем
   - Verification

3. **PHASE D:**
   - Зафіксувати R2 prefix policy
   - Опційно: chunks_manifest

4. **PHASE G + H:**
   - Тести
   - Документація
   - Commit

## 🔧 Технічні деталі

### Qdrant Point IDs
- Chunks: `hash(rada_nreg + content_hash + chunk_index)` (перші 32 символи SHA-256)
- Acts: `hash(rada_nreg + content_hash)` (перші 32 символи SHA-256)

### AI Enrichment
- Model: `anthropic/claude-3.7-sonnet`
- Endpoint: OpenRouter
- Output: JSON з summary, keywords, topics, aliases
- Валідація: перевірка структури та наявності полів

### Supabase Schema
- Нові колонки: всі nullable або з default значеннями (без руйнівних змін)
- Unique constraint: `(document_nreg, content_hash, chunk_index)` в chunks

## ⚠️ Відомі обмеження

1. **Admin CLI:** базова структура створена, але повний імпортер потрібно інтегрувати
2. **Runs directory:** ще не створено, буде в повному імпортері
3. **Batch import:** поки не реалізовано
4. **Update command:** поки не реалізовано (перевірка content_hash)

## 📊 Статистика

- **Файлів створено:** 6
- **Міграцій застосовано:** 1
- **Qdrant колекцій:** 2
- **Supabase колонок додано:** 10
- **Готовність:** ~60%
