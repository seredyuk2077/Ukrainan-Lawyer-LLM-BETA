# PHASE 4: Timeout/Resume/Progress для великих документів — COMPLETED

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Що зроблено

### 1. Job Progress Tracking ✅
- **Створено:** `lib/jobProgress.ts`
- **Функції:**
  - `updateJobProgress()` — оновлення прогресу job
  - `completeJob()` — завершення job як успішний
  - `failJob()` — помітка job як failed
  - `findResumeJob()` — пошук незавершеного job для resume

### 2. Import Stages ✅
**Стадії імпорту:**
- `fetched` — дані завантажені з Rada
- `canonical_built` — canonical JSON побудовано
- `r2_uploaded` — canonical завантажено в R2
- `ai_enrichment_done` — AI enrichment завершено
- `embeddings_started` — генерація embeddings почата
- `embeddings_progress` — прогресування embeddings (batch i/n)
- `embeddings_done` — embeddings згенеровано
- `qdrant_upsert_started` — Qdrant upsert почато
- `qdrant_upsert_progress` — прогресування Qdrant upsert (batch i/n)
- `qdrant_upsert_done` — Qdrant upsert завершено
- `supabase_updated` — Supabase оновлено
- `done` — імпорт завершено

### 3. Progressive Commits ✅
**Embeddings:**
- Оновлено `generateEmbeddingsBatch()` для підтримки `onProgress` callback
- Після кожного batch embeddings → оновлення `job.progress_data`
- Логування прогресу в run logs

**Qdrant Upsert:**
- Оновлено `upsertChunks()` для підтримки `onProgress` callback
- Після кожного batch (100 points) → оновлення `job.progress_data`
- Логування прогресу в run logs

**Supabase Updates:**
- Малі оновлення після кожного критичного етапу
- Не чекаємо до кінця для гігантського update

### 4. Error Handling ✅
- При помилці → job помічається як `failed`
- `last_error` зберігається в `progress_data`
- Job може бути відновлений (resume) пізніше

---

## Як працює

### Для малих документів (< 100 chunks)
- Батчі невеликі (concurrency=3 для embeddings)
- Progress оновлюється рідко
- Немає проблеми з timeout

### Для великих документів (> 100 chunks)
- Більші батчі (concurrency=32 для embeddings)
- Progress оновлюється після кожного batch
- Малі Supabase updates після кожного batch
- Немає гігантського timeout на останньому update

### Resume (майбутнє)
- `findResumeJob()` вже реалізовано
- Можна додати CLI команду `--resume` для продовження
- Перевірка `progress_data.stage` для визначення з якого місця продовжувати

---

## Acceptance Criteria

### ✅ Великі документи не падають по timeout
- **Механізм:** Progressive commits після кожного batch
- **Результат:** Кожен batch — малий update, немає гігантського update в кінці

### ✅ Прогрес відстежується
- **Механізм:** `job.progress_data` оновлюється після кожного етапу
- **Результат:** Можна бачити на якому етапі застряг job

### ✅ Job може бути завершений/провалений
- **Механізм:** `completeJob()` та `failJob()` helpers
- **Результат:** Чіткий статус job в Supabase

---

## Наступні кроки (опціонально)

1. **CLI команда --resume** — для продовження незавершених jobs
2. **CLI команда --restart** — для перезапуску з очищенням
3. **Auto-resume** — автоматичне продовження при перезапуску importer

---

## Приклад progress_data

```json
{
  "stage": "embeddings_progress",
  "stage_progress": "5/12",
  "document_nreg": "2341-14",
  "content_hash": "abc123...",
  "expected_chunks": 1200,
  "processed_chunks": 160,
  "updated_at": "2026-01-21T20:30:00Z"
}
```
