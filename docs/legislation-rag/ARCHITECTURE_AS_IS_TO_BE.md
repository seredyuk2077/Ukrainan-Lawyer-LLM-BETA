# Architecture: AS-IS → TO-BE

**Дата:** 2026-01-21  
**Статус:** Міграція завершена

---

## AS-IS (до міграції)

### Supabase
- `legislation_documents`: 1 документ (Конституція 254к/96-вр)
- `legislation_chunks`: 172 chunks з embeddings (vector 1536) в Supabase
- `legislation_import_jobs`: не використовувався
- Retrieval: через RPC `match_chunks_v3` / `match_legislation_chunks` (legacy)

### R2
- Canonical JSON: `legislation/constitutional/254%D0%BA%2F96-%D0%B2%D1%80.json`
- Cache/log prefixes: змішані з canonical (без чіткого розділення)

### Qdrant
- Не використовувався для Legislation RAG
- Тільки DocListDB catalog (`legislation-catalog-index`)

---

## TO-BE (після міграції)

### Архітектурні ролі

1. **Supabase** = Registry/Control Plane
   - Метадані документів
   - Статуси індексації (qdrant_status: pending|indexed|error)
   - Версіонування (content_hash, previous_hash)
   - Jobs логування
   - AI enrichment (summary, keywords, topics, aliases)

2. **R2** = Source of Truth (Canonical JSON)
   - Формат: `legislation/{category}/{encodeURIComponent(nreg)}.json`
   - Чітке розділення: canonical vs cache/log/archive
   - Guardrails проти double-prefix та помилок

3. **Qdrant** = Data Plane (Retrieval DB)
   - `lexery_legislation_chunks` (1536 dims, cosine) — точний пошук норм
   - `lexery_legislation_acts` (1536 dims, cosine) — абстрактний пошук актів
   - Deterministic IDs (UUID-shaped) для ідемпотентності

---

## Qdrant Schema

### Collections

#### `lexery_legislation_chunks`
- **Vector size:** 1536 (openai/text-embedding-3-small)
- **Distance:** Cosine
- **Point ID:** `qdrantChunkId({ radaNreg, contentHash, chunkIndex })` (deterministic UUID)
- **Payload (MUST):**
  - `rada_nreg` (keyword)
  - `content_hash` (keyword)
  - `chunk_index` (integer)
  - `article_number` (keyword, nullable)
  - `token_count` (integer, nullable)
  - `r2_key` (keyword)
  - `json_path` (keyword) — формат: `$.content.chunks[<index>].text`
  - `category` (keyword)
  - `document_type` (keyword)
  - `rada_datred` (datetime)
  - `title` (keyword)
  - `source_url` (keyword)
  - `previous_hash` (keyword, nullable)

#### `lexery_legislation_acts`
- **Vector size:** 1536 (embedding summary+title+keywords)
- **Distance:** Cosine
- **Point ID:** `qdrantActId({ radaNreg, contentHash })` (deterministic UUID)
- **Payload (MUST):**
  - `rada_nreg` (keyword)
  - `content_hash` (keyword)
  - `previous_hash` (keyword, nullable)
  - `title` (keyword)
  - `category` (keyword)
  - `document_type` (keyword)
  - `rada_datred` (datetime)
  - `source_url` (keyword)
  - `r2_key` (keyword)
  - `summary` (keyword) — AI-generated
  - `keywords` (keyword array) — AI-generated
  - `topics` (keyword array) — AI-generated
  - `aliases` (keyword array) — AI-generated

### Versioning через content_hash

- Нова редакція акту = новий `content_hash`
- Qdrant point IDs включають `content_hash` → автоматично нові points
- Старі points залишаються (можна видалити по фільтру `content_hash` при потребі)

---

## Supabase Schema

### `legislation_documents` (оновлено)

**Нові колонки:**
- `indexed_content_hash` (text) — який content_hash реально в Qdrant
- `qdrant_status` (enum: pending|indexed|error)
- `qdrant_indexed_at` (timestamp)
- `expected_chunks` (int) — з canonical
- `indexed_chunks` (int) — фактична кількість в Qdrant
- `last_checked_at` (timestamp) — для auto-update тригера
- `auto_update` (boolean default false)
- `last_sync_error` (text)
- `summary` (text) — AI enrichment
- `aliases` (jsonb) — AI enrichment

**Без змін:**
- `rada_nreg` (PK) — контракт з майбутнім каталогом актів
- `content_hash`, `previous_hash`, `r2_key`, `keywords`, `topics` (як було)

### `legislation_chunks` (оновлено)

**Нові колонки:**
- `content_hash` (text) — денормалізація для унікальності

**Нові constraints:**
- Unique: `(document_nreg, content_hash, chunk_index)`

**Примітка:** Нові імпорти НЕ заповнюють `legislation_chunks` (embeddings тільки в Qdrant). Таблиця залишається для legacy/аудиту.

### `legislation_import_jobs` (використовується)

- Логування всіх операцій (add/update/remove)
- Статуси, counts, timings, errors
- `config` JSONB: action, rada_nreg, тощо
- `progress_data` JSONB: preview, result

---

## R2 Policy

### Два бакети

- **Supreme Court Decisions bucket:** НЕ ЧІПАТИ (жодних операцій)
- **Legislation bucket:** використовується для Legislation RAG

### Prefix структура

- **Canonical:** `legislation/{category}/{encodeURIComponent(nreg)}.json`
- **Archive:** `legislation/archive/{category}/{encoded_nreg}__{timestamp}.json`
- **Cache (Resolver):** `legislation/ActCatalogResolver/cache/...` (НЕ змінювати)
- **Logs (Updater):** `legislation/DocListDB rada gov updater log/...` (НЕ змінювати)

### Guardrails

- Перевірка проти `legislation/legislation/` (double-prefix bug)
- Перевірка що canonical не йде в cache/log
- Перевірка що використовується правильний bucket

Детальніше: [R2_POLICY.md](./R2_POLICY.md)

---

## Foundation for Future Update-Trigger Microservice

### Контракт зовнішнього сервісу

**Як перевірити наявність акту в Supabase:**
```sql
SELECT rada_nreg, content_hash, qdrant_status, indexed_content_hash, last_checked_at, auto_update
FROM legislation_documents
WHERE rada_nreg = '...'
```

**Як визначити чи документ оновився:**
1. Порівняти `rada_datred` з rada.gov.ua
2. Якщо `rada_datred` змінився → fetch + build canonical → порівняти `content_hash`
3. Якщо `content_hash` змінився → потрібна переіндексація

**Які поля потрібні для auto-update:**
- `last_checked_at` — коли останній раз перевіряли
- `indexed_content_hash` — яка версія реально в Qdrant
- `qdrant_status` — чи індексація завершена
- `auto_update` — чи увімкнено автоматичне оновлення
- `last_sync_error` — помилки синхронізації

**Алгоритм auto-update:**
1. Перевірити `last_checked_at` (не частіше ніж раз на день)
2. Fetch актуальну версію з rada.gov.ua
3. Build canonical → `content_hash`
4. Порівняти з `indexed_content_hash`
5. Якщо змінився → викликати `admin-cli update --nreg "..."` (або внутрішній API)
6. Оновити `last_checked_at`

---

## Admin CLI

### Команди

- `status` — readiness checks + counts + останні jobs
- `add --nreg "..."` — імпорт одного документа
- `add-batch --file nregs.txt` — batch імпорт
- `update --nreg "..." [--force]` — оновлення (skip якщо content_hash не змінився)
- `remove --nreg "..." [--confirm]` — видалення (з архівуванням canonical)
- `inspect --nreg "..."` — детальна інформація про документ
- `purge-all --i-know-what-im-doing` — повне очищення (з подвійним підтвердженням)
- `search --query "..." [--nreg ...] [--topk 5]` — retrieval sanity test

### Runs Directory

Кожна операція створює папку:
`scripts/legislation/runs/{slug}__{encoded_nreg}__{timestamp}/`

Вміст:
- `report.json` — counts, hashes, timings, qdrant counts
- `enrichment.json` — AI enrichment (strict JSON)
- `canonical.preview.json` — canonical без raw (або trimmed)
- `logs.txt` — текстові логи операції
- `qdrant_ids.json` — (опційно) перші 10 IDs, total count

---

## Data Flow

### Import (add/update)

```
rada.gov.ua API
  ↓
Build canonical JSON
  ↓
Upload canonical → R2 (guardrails)
  ↓
Chunking (expected_chunks)
  ↓
AI enrichment (Claude 3.7 Sonnet)
  ↓
Embeddings (openai/text-embedding-3-small)
  ├─ chunks embeddings
  └─ acts embedding (summary+title+keywords)
  ↓
Supabase upsert (registry)
  ├─ legislation_documents (метадані + статуси)
  └─ legislation_import_jobs (лог)
  ↓
Qdrant upsert
  ├─ lexery_legislation_chunks (deterministic IDs)
  └─ lexery_legislation_acts (deterministic IDs)
  ↓
Post-verify (counts match)
  ↓
Update Supabase (qdrant_status=indexed)
```

### Retrieval

```
User query
  ↓
Embed query (text-embedding-3-small)
  ↓
Qdrant search (lexery_legislation_chunks)
  ↓
Filter by payload (rada_nreg, category, тощо)
  ↓
Top-K results (score + payload)
  ↓
Extract text from R2 (json_path)
  ↓
Return: score, title, article_number, snippet, r2_key
```

---

## Deterministic IDs (Idempotency)

### Chunks
```typescript
qdrantChunkId({ radaNreg: "254к/96-вр", contentHash: "abc...", chunkIndex: 0 })
// → deterministic UUID (RFC 4122 v5)
```

### Acts
```typescript
qdrantActId({ radaNreg: "254к/96-вр", contentHash: "abc..." })
// → deterministic UUID
```

**Гарантії:**
- Один і той самий (nreg, hash, chunk_index) → один і той самий ID
- Нова редакція (новий content_hash) → нові IDs
- Повторний імпорт не створює дублікатів

---

## Verification

### Readiness Checks

```bash
pnpm tsx scripts/legislation/check_readiness.ts
```

Перевіряє:
- Supabase: колонки, індекси, підключення
- Qdrant: колекції, dims, distance
- R2: bucket доступність

### Data Quality

- `expected_chunks == len(canonical.content.chunks)`
- `indexed_chunks == Qdrant chunks count`
- `qdrant_status == 'indexed'` після успішного імпорту
- `indexed_content_hash == content_hash` після успішного імпорту

---

## Migration Summary

✅ **PHASE A:** Preflight, AS-IS mapping  
✅ **PHASE B:** Qdrant collections + indexes  
✅ **PHASE C:** Supabase schema improvements  
✅ **PHASE D:** R2 guardrails + policy  
✅ **PHASE E:** Remove test Constitution  
✅ **PHASE F:** Admin CLI + full importer  
⏳ **PHASE G:** Smoke tests (pending)  
⏳ **PHASE H:** Final docs + commit (pending)

---

## Next Steps

1. **Smoke tests:**
   - Import 1 документ (не Конституція)
   - Batch import 3-5 документів
   - Retrieval sanity test

2. **Future auto-update service:**
   - Використовувати `last_checked_at`, `indexed_content_hash`, `qdrant_status`
   - Підключити до rada.gov.ua feeds
   - Викликати `admin-cli update` для змінених актів

3. **Legacy cleanup:**
   - Позначити Supabase RPC як deprecated
   - Можливо видалити embeddings з `legislation_chunks` (якщо не потрібні)
