# Session Recap Checkpoint — Legislation RAG System

**Дата створення:** 2026-01-22  
**Статус:** AS-IS Documentation + Infrastructure Evidence  
**Мета:** Повне відновлення контексту попередньої сесії з evidence-based підтвердженням

---

## 1. Executive Summary

### Що це за система

**Lexery Legislation RAG** — система для імпорту, обробки та індексації нормативно-правових актів з rada.gov.ua для RAG (Retrieval-Augmented Generation) пошуку.

**Архітектура:**
- **Source:** rada.gov.ua API (JSON + TXT)
- **Storage:** Cloudflare R2 (canonical JSON)
- **Registry:** Supabase PostgreSQL (метадані, статуси, health)
- **Vector DB:** Qdrant Cloud (embeddings для acts + chunks)
- **AI:** Claude 3.7 Sonnet через OpenRouter (enrichment, classification)

### Source of Truth

- **Canonical JSON:** R2 (`legislation/{category}/{encoded_nreg}.json`) — повний текст + структура
- **Metadata:** Supabase `legislation_documents` — registry/control-plane
- **Embeddings:** Qdrant `lexery_legislation_acts` + `lexery_legislation_chunks` — data plane для пошуку

### Моделі

- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **AI Enrichment:** Anthropic Claude 3.7 Sonnet (OpenRouter)
- **Taxonomy:** V1 (29 категорій, EN slugs)

---

## 2. Що було зроблено за попередню сесію (Timeline)

### PHASE 1: Diagnostics ✅
- AS-IS документація системи
- Risk Register (parsing, Rada API, AI, Qdrant, data quality)
- План виконання phases

### PHASE 2: Parsing Hardening ✅
- **Розширені стратегії парсингу:**
  - `article-based` — для законів/кодексів зі статтями (typ='ST')
  - `point-based` — для постанов/наказів з пунктами (typ='PU', 'PP')
  - `chapter-based` — для документів з великою структурою (глави/розділи)
  - `annex-based` — для документів з додатками/формами/таблицями
  - `fallback` — TXT parsing якщо stru не дає units
- **Mapping typ/tree_id → unit_type:** ST→article, PU→point, GL→chapter, RZ→section, etc.
- **No-empty-index policy:** Важливі документи (постанови, накази) завжди мають chunks > 0 через обов'язковий TXT fallback
- **HTML→Text normalizer:** Детермінований, з тестами (6/6 passed)
- **AI Parsing Assist:** Для "weird docs" з нестандартною структурою (PHASE 11)

### PHASE 3: Controlled AI ✅
- **Taxonomy V1:** ~29 категорій (constitutional, criminal, defense_mobilization, border_migration, etc.)
- **AI enrichment caching:** По `content_hash`, skip якщо не змінився
- **Strict validation:** Category validation + fallback, deduplication topics/keywords
- **"Other" policy:** Дозволено тільки для кадрових/технічних документів (не для законів/кодексів)

### PHASE 4: Timeout/Resume/Progress ✅
- **Job tracking:** `legislation_import_jobs` з `progress_data` (stage, stageProgress, processedChunks)
- **Progressive commits:** Batch embeddings + Qdrant upsert з `onProgress` callbacks
- **Resume support:** CLI команди (`jobs list/inspect/resume`, `--resume` flag)
- **Error handling:** Jobs автоматично помічаються як `failed` з `error_message`

### PHASE 5: Act Group ✅
- **Supabase schema:** `act_group_key`, `act_is_part`, `act_part_label`, `act_group_title`
- **Heuristics:** `normalizeBaseTitle`, `detectPartLabel`, `generateActGroupKey`
- **Qdrant payload:** `act_group_key`, `act_part_label` в chunks та acts
- **Unit tests:** 10/10 passed

### PHASE 6: Real World Test (ККУ) ✅
- **ККУ (2341-14):** 943 chunks, indexed ✅
- **Time:** ~80s для великого документа
- **Search:** ККУ знаходиться в топ-результатах для релевантних запитів ✅
- **Category:** criminal (не other) ✅

### PHASE 7: Corpus Tests ✅
- **Corpus:** 4 документи (3/4 успішно)
- **Report generator:** JSON + Markdown з детальними метриками
- **Validations:** Zero chunks check, other category warnings

### PHASE 9-12: Document Type System V1 ✅
- **Standardized slugs:** `document_type_slug` (EN) окремо від `document_type` (UA)
- **Slug mapping:** `constitution`, `code`, `law`, `cmu_resolution`, `presidential_decree`, `regulation`, `convention`, `ccu_opinion`, `other`
- **Repair tools:** `repair doc-types`, `repair document-type-consistency`

### PHASE 14-17: Hardening ✅
- **Document number extraction:** `document_number` (універсальний номер, не тільки law_number)
- **Storage category:** Стабільний R2 folder (не змінюється при перекласифікації)
- **Category normalization:** Завжди taxonomy slug EN (не UA, не "інше")

### PHASE 18: Invariants V1 ✅
- **Verify tool:** `verify --nreg` / `verify --all` з детальними checks
- **Invariants:**
  - `document_type_slug NOT NULL`
  - `category NOT NULL` (EN taxonomy slug)
  - `document_number NOT NULL`
  - `storage_category NOT NULL`
  - `expected_chunks == indexed_chunks` (якщо `qdrant_status=indexed`)
  - `Qdrant acts count == 1` (CURRENT version only)
  - `Qdrant chunks count == indexed_chunks`
  - `R2 key exists`
  - `canonical chunks count == expected_chunks`

### PHASE 19-20: Health Status + Soak Tests ✅
- **Sync health:** `green` / `yellow` / `red` / `unknown` (на основі verify results)
- **Legal status:** `active` / `inactive` / `unknown` (з Rada metadata)
- **Soak tests:** Різноманітні документи для перевірки стабільності

---

## 3. Map файлів і модулів

### Entry Point: `admin-cli.ts`

**Команди:**
- `status` — перевірка готовності інфраструктури
- `add --nreg` — імпорт одного документа
- `update --nreg` — оновлення/переіндексація
- `remove --nreg` — видалення документа
- `inspect --nreg` — детальна інформація
- `add-batch --file` — batch імпорт
- `jobs list/inspect/resume` — управління jobs
- `verify --nreg/--all` — перевірка консистентності
- `repair categories/act-groups/consistency/doc-types/numbers` — repair команди
- `test-kku/test-corpus/test-kupap` — тести

### Core Pipeline: `lib/importer.ts`

**Функція:** `importOne(opts: ImportOptions)`

**Workflow:**
1. Fetch з rada.gov.ua (JSON + TXT)
2. Build canonical JSON (`buildCanonical`)
3. Upload canonical → R2 (`uploadCanonicalJsonToR2`)
4. AI enrichment (`generateEnrichment`) з кешуванням по `content_hash`
5. Generate embeddings (`generateEmbeddingsBatch`) з progress callbacks
6. Upsert Supabase (`legislation_documents`)
7. Upsert Qdrant (acts + chunks) з progress callbacks
8. Verify Qdrant counts
9. Update Supabase post-verify

**Key features:**
- Idempotent (stable Qdrant IDs, safe R2 upload)
- Resume support (через `legislation_import_jobs`)
- Progressive commits (batch embeddings, batch Qdrant upsert)
- Error handling (jobs marked as failed, docs marked as error)

### Canonical Builder: `canonical/buildCanonical.ts`

**Функція:** `buildCanonical(options: BuildCanonicalOptions)`

**Input:** JSON path + TXT path (optional)

**Output:** `CanonicalDocument` з:
- `metadata` — rada_nreg, title, document_type, document_type_slug, category, law_number, document_number, rada_datred, source_url, content_hash, previous_hash, r2_key
- `content` — articles, chunks, structure
- `ai_enrichment` — keywords, topics, summary, aliases (optional)
- `raw` — rada_api_json, rada_api_txt

**Key logic:**
- Extract law_number (`extractLawNumber`)
- Guess document_type (rule-based + JSON typ)
- Guess category (rule-based, буде перезаписано AI)
- Parse content units (`parseContentUnits`) з різними стратегіями
- Create chunks (`createChunksFromUnits`)
- Generate content_hash (SHA-256)

### Content Units Parser: `canonical/parseUnits.ts`

**Функція:** `parseContentUnits(stru, txt, documentType, metadata)`

**Стратегії:**
1. `article-based` — parseArticleUnitsFromStru (typ='ST')
2. `point-based` — parsePointUnitsFromStru (typ='PU', 'PP')
3. `chapter-based` — parseChapterBasedUnits (typ='GL', 'RZ')
4. `annex-based` — parseAnnexBasedUnits (typ='DP')
5. `fallback` — parseUnitsFromTxt (якщо stru не дає units)

**AI Parsing Assist:** Для "weird docs" з нестандартною структурою (`aiParsingAssist.ts`)

**No-empty-index policy:** Важливі документи завжди мають chunks > 0 через обов'язковий TXT fallback

### Chunking: `canonical/chunking.ts`

**Функція:** `createChunksFromUnits(units, context)`

**Логіка:**
- Target size: ~700-1200 tokens (~3000-6000 chars)
- Overlap: 10-15% при розбитті довгих units
- Header context: `{title} ({document_type}): {hierarchy} {unit_title}`
- Token estimation: ~4 chars per token (для української)

### R2 Path: `canonical/r2Path.ts`

**Функція:** `generateR2Key(category, nreg)`

**Format:** `legislation/{storage_category}/{encoded_nreg}.json`

**Mapping:** `CATEGORY_TO_R2_FOLDER` (taxonomy slug → R2 folder)

**Guardrails:** `assertCanonicalKeyForWrite` (заборона на небезпечні prefixes)

### AI Enrichment: `lib/aiEnrichment.ts`

**Функція:** `generateEnrichment(input: EnrichmentInput)`

**Output:**
- `summary` — 1-3 речення (юридично нейтральний)
- `category` — taxonomy slug EN (з валідацією)
- `keywords` — 10-40 елементів (українською)
- `topics` — 3-10 елементів (українською)
- `aliases` — 5-15 елементів (варіанти назв/скорочень)

**Validation:**
- Category validation (strict taxonomy, fallback якщо невалідна)
- Deduplication (topics/keywords)
- Bounds checking (keywords 10-40, topics 3-10, aliases 5-15)

**Caching:** По `content_hash` (перевіряється в `importer.ts`)

### Qdrant Client: `lib/qdrantRagClient.ts`

**Class:** `QdrantRagClient`

**Collections:**
- `lexery_legislation_acts` — 1 point per document
- `lexery_legislation_chunks` — N points per document (N = expected_chunks)

**Methods:**
- `upsertAct(payload, vector)` — upsert act
- `upsertChunks(chunks, onProgress?)` — batch upsert chunks з progress callback
- `deleteDocument(radaNreg, contentHash)` — видалити всі points для документа
- `countDocument(radaNreg, contentHash)` — підрахувати points

**IDs:** Детерміновані UUID (`qdrantIds.ts`):
- Act ID: `deterministicUuidFromString("${nreg}|${content_hash}")`
- Chunk ID: `deterministicUuidFromString("${nreg}|${content_hash}|${chunk_index}")`

**Versioning:** CURRENT VERSION ONLY (старі версії видаляються через dedup)

### Supabase Admin: `lib/supabaseAdmin.ts`

**Функція:** `createSupabaseAdminClient()`

**Connection:** `SUPABASE_LEGISLATION_URL` + `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY`

**Tables:**
- `legislation_documents` — registry/control-plane
- `legislation_import_jobs` — job tracking

### Job Progress: `lib/jobProgress.ts`

**Functions:**
- `updateJobProgress(supabase, { jobId, stage, stageProgress, processedChunks })`
- `completeJob(supabase, jobId)`
- `failJob(supabase, jobId, errorMessage)`
- `findResumeJob(supabase, radaNreg)` — знайти running job для resume

**Stages:**
- `fetched` → `canonical_built` → `r2_uploaded` → `ai_enrichment_done` → `embeddings_started/progress/done` → `qdrant_upsert_started/progress/done` → `supabase_updated` → `done`

### Verify: `commands/verify.ts`

**Функції:**
- `verifyDocument(nreg, options?)` — перевірка одного документа
- `verifyAll(options?)` — batch verify з пагінацією
- `printEvidenceQueries()` — SQL evidence queries

**Invariants (з коду):**
1. Supabase:
   - `document_type_slug NOT NULL`
   - `category NOT NULL` (EN taxonomy slug)
   - `document_number NOT NULL`
   - `storage_category NOT NULL`
   - `expected_chunks >= 0`, `indexed_chunks >= 0`
   - `qdrant_status=indexed ⇒ indexed_chunks == expected_chunks`
   - `indexable document has chunks > 0`
   - `act_is_part=false ⇒ act_group_key IS NULL`
2. R2:
   - `r2_key exists in bucket`
   - `canonical JSON valid`
   - `canonical chunks count == expected_chunks`
3. Qdrant:
   - `Qdrant acts count == 1` (CURRENT version only)
   - `Qdrant chunks count == indexed_chunks`
   - `payload has required fields` (rada_nreg, r2_key, json_path, chunk_index, content_hash)
   - `payload document_type_slug matches Supabase`
   - `payload category matches Supabase`

**Health calculation:**
- `green` — всі інваріанти PASS, sync_status=synced, qdrant_status=indexed
- `yellow` — часткові проблеми або warnings
- `red` — критичні помилки (sync_status=error, qdrant_status=error, немає R2, немає Qdrant match)
- `unknown` — недостатньо даних

### Repair Commands: `commands/repair-*.ts`

- `repair-categories.ts` — нормалізувати та перекласифікувати categories
- `repair-act-groups.ts` — перерахувати act_group поля
- `repair-consistency.ts` — виправити невідповідності між Supabase/Qdrant/R2
- `repair-doc-types.ts` — виправити document_type_slug
- `repair-numbers.ts` — заповнити document_number
- `repair-document-type-consistency.ts` — виправити document_type для консистентності з document_type_slug
- `repair-qdrant-dedup.ts` — видалити старі версії з Qdrant

### Taxonomy: `taxonomy/taxonomy.ts`

**TAXONOMY_V1:** 29 категорій (EN slugs → UA labels)

**Functions:**
- `isValidCategory(category)` — перевірка валідності
- `getCategoryLabel(slug)` — отримати UA label
- `normalizeCategory(category)` — нормалізувати до taxonomy slug
- `guessCategoryFromKeywords(title, documentType)` — rule-based fallback
- `canBeOtherCategory(documentType)` — чи може документ мати "other" категорію

### Document Types: `documentTypes/guessDocumentTypeV2.ts`

**Функція:** `guessDocumentTypeV2({ title, typ, typn, organs, stru })`

**Output:** `{ slug: DocumentTypeSlug, confidence: number }`

**Slugs:** `constitution`, `code`, `law`, `cmu_resolution`, `presidential_decree`, `regulation`, `convention`, `ccu_opinion`, `other`

### Act Grouping: `canonical/actGrouping.ts`

**Функція:** `determineActGroup({ title, documentType, lawNumber })`

**Output:**
- `act_group_key` — stable hash (NULL для одиночних актів)
- `act_is_part` — boolean
- `act_part_label` — label частини ("статті 1-212-24")
- `act_group_title` — canonical title групи

---

## 4. Data Model Map

### Supabase: `legislation_documents`

**Primary Key:** `rada_nreg` (VARCHAR, NOT NULL)

**CORE Fields (Must-Have):**
- `rada_nreg` — PK, всі файли
- `title` — назва документа
- `r2_key` — R2 pointer (TEXT, NOT NULL)
- `source_url` — URL rada.gov.ua
- `content_hash` — SHA-256 hash canonical JSON (VARCHAR, NOT NULL, CHECK length=64)
- `rada_datred` — дата редакції (DATE, NOT NULL)
- `document_type_slug` — EN slug (TEXT, nullable, але verify вимагає NOT NULL)
- `category` — EN taxonomy slug (VARCHAR, nullable, але verify вимагає NOT NULL)
- `storage_category` — R2 folder (TEXT, nullable, але verify вимагає NOT NULL)
- `document_number` — універсальний номер (TEXT, nullable, але verify вимагає NOT NULL)
- `expected_chunks` — очікувана кількість chunks (INTEGER, nullable, default=0)
- `indexed_chunks` — фактична кількість chunks в Qdrant (INTEGER, nullable, default=0)
- `qdrant_status` — статус індексації (VARCHAR, nullable, default='pending', CHECK: 'pending'|'indexed'|'error')
- `sync_status` — статус синхронізації (VARCHAR, nullable, default='pending', CHECK: 'synced'|'pending'|'error')
- `imported_at` — timestamp імпорту (TIMESTAMPTZ, NOT NULL, default=now())
- `updated_at` — timestamp оновлення (TIMESTAMPTZ, NOT NULL, default=now())

**OPTIONAL Fields:**
- `rada_dokid` — ID документа (INTEGER, nullable)
- `previous_hash` — попередній content_hash (VARCHAR, nullable)
- `document_type` — UA label (VARCHAR, nullable)
- `law_number` — номер закону (VARCHAR, nullable, тільки для законів)
- `act_is_part` — чи є частиною групи (BOOLEAN, nullable, default=false)
- `act_group_key` — stable key групи (TEXT, nullable)
- `act_part_label` — label частини (TEXT, nullable)
- `act_group_title` — canonical title групи (TEXT, nullable, DEPRECATED)
- `summary` — AI-generated опис (TEXT, nullable)
- `keywords` — AI-generated keywords (JSONB, nullable, default=[])
- `topics` — AI-generated topics (JSONB, nullable, default=[])
- `aliases` — AI-generated aliases (JSONB, nullable, default=[])

**Status Fields:**
- `sync_health` — health статус (TEXT, nullable, CHECK: 'green'|'yellow'|'red')
- `sync_issue` — опис проблеми (TEXT, nullable)
- `legal_status` — юридичний статус (TEXT, nullable, CHECK: 'active'|'inactive'|'unknown')

**DEPRECATED Fields:**
- `articles_count` — legacy, можливо дублює expected_chunks
- `chunks_count` — дублює expected_chunks
- `is_active` — завжди true?
- `auto_update` — не використовується
- `indexed_content_hash` — не використовується
- `last_checked_at` — не використовується
- `last_sync_error` — не використовується
- `qdrant_indexed_at` — не використовується

### Supabase: `legislation_import_jobs`

**Primary Key:** `id` (UUID, NOT NULL)

**CORE Fields:**
- `id` — PK
- `status` — статус job (VARCHAR, NOT NULL, default='pending', CHECK: 'pending'|'running'|'completed'|'failed')
- `created_at` — timestamp створення (TIMESTAMPTZ, nullable, default=now())

**OPTIONAL Fields:**
- `total_count` — загальна кількість документів (INTEGER, nullable, default=0)
- `processed_count` — оброблено (INTEGER, nullable, default=0)
- `success_count` — успішно (INTEGER, nullable, default=0)
- `error_count` — помилки (INTEGER, nullable, default=0)
- `started_at` — timestamp початку (TIMESTAMPTZ, nullable)
- `completed_at` — timestamp завершення (TIMESTAMPTZ, nullable)
- `error_message` — повідомлення про помилку (TEXT, nullable)
- `config` — конфігурація job (JSONB, nullable, default={})
- `progress_data` — дані прогресу (JSONB, nullable, default={})

**progress_data structure:**
```json
{
  "stage": "embeddings_progress",
  "stageProgress": "3/10",
  "processedChunks": 300,
  "documentNreg": "2341-14",
  "contentHash": "...",
  "expectedChunks": 943
}
```

### Qdrant: `lexery_legislation_acts`

**Collection:** `lexery_legislation_acts`

**Vector:** 1536 dimensions (OpenAI text-embedding-3-small)

**Point ID:** `deterministicUuidFromString("${nreg}|${content_hash}")`

**Expected Count:** 1 per document (CURRENT version only)

**Payload Schema (MUST):**
- `rada_nreg` (string) — PK filter
- `content_hash` (string) — versioning
- `title` (string)
- `category` (string) — EN taxonomy slug
- `document_type` (string) — UA label
- `document_type_slug` (string) — EN slug
- `rada_datred` (string) — ISO datetime
- `source_url` (string)
- `r2_key` (string)
- `summary` (string)
- `keywords` (string[])
- `topics` (string[])
- `aliases` (string[])
- `act_group_key` (string | null)
- `act_part_label` (string | null)
- `previous_hash` (string | null)

### Qdrant: `lexery_legislation_chunks`

**Collection:** `lexery_legislation_chunks`

**Vector:** 1536 dimensions (OpenAI text-embedding-3-small)

**Point ID:** `deterministicUuidFromString("${nreg}|${content_hash}|${chunk_index}")`

**Expected Count:** `expected_chunks` per document (CURRENT version only)

**Payload Schema (MUST):**
- `rada_nreg` (string) — PK filter
- `content_hash` (string) — versioning
- `chunk_index` (number) — порядковий номер
- `article_number` (string | null)
- `token_count` (number | null)
- `r2_key` (string)
- `json_path` (string) — path в canonical JSON (напр. `$.content.chunks[0].text`)
- `category` (string) — EN taxonomy slug
- `document_type` (string) — UA label
- `document_type_slug` (string) — EN slug
- `rada_datred` (string) — ISO datetime
- `title` (string)
- `source_url` (string)
- `previous_hash` (string | null)
- `act_group_key` (string | null)
- `act_part_label` (string | null)

### R2: Canonical JSON

**Key Format:** `legislation/{storage_category}/{encoded_nreg}.json`

**Storage Categories:** `constitutional`, `criminal`, `civil`, `administrative`, `labor`, `finance`, `tax`, `commercial`, `land`, `energy`, `defense`, `security`, `migration`, `anti_corruption`, `procurement`, `healthcare`, `education`, `environment`, `transport`, `local`, `judiciary`, `international`, `digital`, `other`

**Canonical JSON Schema:**
```json
{
  "version": "1.0",
  "schema_version": "1.0",
  "metadata": {
    "rada_nreg": "2341-14",
    "rada_dokid": 12345,
    "title": "Кримінальний кодекс України",
    "document_type": "Кодекс",
    "document_type_slug": "code",
    "category": "criminal",
    "law_number": "2341-14",
    "document_number": "2341-14",
    "rada_datred": "2001-04-05",
    "source_url": "https://data.rada.gov.ua/laws/show/2341-14",
    "imported_at": "2026-01-22T10:00:00Z",
    "updated_at": "2026-01-22T10:00:00Z",
    "content_hash": "abc123...",
    "previous_hash": null,
    "r2_key": "legislation/criminal/2341-14.json"
  },
  "content": {
    "articles": [...],
    "chunks": [
      {
        "chunk_index": 0,
        "article_number": "1",
        "text": "...",
        "title": "Стаття 1",
        "token_count": 800
      }
    ],
    "structure": {
      "type": "document",
      "children": [...]
    }
  },
  "ai_enrichment": {
    "keywords": [...],
    "topics": [...],
    "summary": "...",
    "aliases": [...]
  },
  "raw": {
    "rada_api_json": {...},
    "rada_api_txt": "..."
  }
}
```

**⚠️ НЕ ЧІПАТИ:**
- `legislation/ActCatalogResolver/cache/...` (кеш мікросервісу)
- `legislation/DocListDB rada gov updater log/...` (логи мікросервісу)

---

## 5. Інваріанти (Definition of Done)

### Supabase Invariants

1. **document_type_slug NOT NULL** — EN slug обов'язковий
2. **category NOT NULL** — EN taxonomy slug обов'язковий
3. **document_number NOT NULL** — універсальний номер обов'язковий
4. **storage_category NOT NULL** — R2 folder обов'язковий
5. **expected_chunks >= 0** — не може бути негативним
6. **indexed_chunks >= 0** — не може бути негативним
7. **qdrant_status=indexed ⇒ indexed_chunks == expected_chunks** — якщо індексовано, кількості мають збігатися
8. **indexable document has chunks > 0** — важливі документи мають chunks > 0
9. **act_is_part=false ⇒ act_group_key IS NULL** — одиночні акти не мають act_group_key

### R2 Invariants

1. **r2_key exists in bucket** — canonical JSON має існувати в R2
2. **canonical JSON valid** — структура має бути валідною
3. **canonical chunks count == expected_chunks** — кількість chunks в canonical має збігатися з expected_chunks

### Qdrant Invariants

1. **Qdrant acts count == 1** — рівно 1 point на документ (CURRENT version only)
2. **Qdrant chunks count == indexed_chunks** — кількість chunks в Qdrant має збігатися з indexed_chunks
3. **payload has required fields** — rada_nreg, r2_key, json_path, chunk_index, content_hash
4. **payload document_type_slug matches Supabase** — консистентність між Qdrant та Supabase
5. **payload category matches Supabase** — консистентність між Qdrant та Supabase

### Cross-Store Invariants

1. **canonical chunks count == expected_chunks** — R2 ↔ Supabase
2. **Qdrant points count == indexed_chunks** — Qdrant ↔ Supabase
3. **content_hash consistency** — Supabase ↔ Qdrant ↔ R2 (всі мають однаковий content_hash)

---

## 6. Поточний стан системи (Evidence)

### Supabase Evidence (2026-01-22)

**Total Documents:** 50

**NULL Stats:**
- `null_doc_type_slug`: 0 (0%)
- `null_category`: 0 (0%)
- `null_document_number`: 0 (0%)
- `null_storage_category`: 0 (0%)
- `null_sync_health`: 1 (2%)

**Status Distribution:**
- `qdrant_status=indexed`: 50 (100%)
- `qdrant_status=error`: 0 (0%)
- `sync_status=synced`: 50 (100%)

**Category Distribution (Top 10):**
- `finance_banking`: 13 (26.00%)
- `other`: 5 (10.00%)
- `defense_mobilization`: 4 (8.00%)
- `administrative`: 4 (8.00%)
- `procurement`: 3 (6.00%)
- `international_eu`: 3 (6.00%)
- `constitutional`: 2 (4.00%)
- `administrative_offenses`: 2 (4.00%)
- `labor_social`: 2 (4.00%)
- `national_security`: 2 (4.00%)

**Document Type Slug Distribution (Top 8):**
- `cmu_resolution`: 20 (40.00%)
- `law`: 14 (28.00%)
- `regulation`: 6 (12.00%)
- `code`: 4 (8.00%)
- `presidential_decree`: 3 (6.00%)
- `convention`: 1 (2.00%)
- `constitution`: 1 (2.00%)
- `ccu_opinion`: 1 (2.00%)

**Sync Health Distribution:**
- `green`: 24 (48%)
- `yellow`: 22 (44%)
- `red`: 3 (6%)
- `null`: 1 (2%)

**Jobs:**
- `total_jobs`: 97
- `completed`: 86 (88.7%)
- `failed`: 7 (7.2%)
- `running`: 4 (4.1%)

### Qdrant Evidence

**Collections:**
- `lexery_legislation_acts` — 1 point per document (expected: 50)
- `lexery_legislation_chunks` — N points per document (expected: sum of expected_chunks)

**Versioning Policy:** CURRENT VERSION ONLY (старі версії видаляються через dedup)

**Point IDs:** Детерміновані UUID (`qdrantIds.ts`)

### R2 Evidence

**Bucket:** `legal-court-decisions` (legislation prefix)

**Key Format:** `legislation/{storage_category}/{encoded_nreg}.json`

**Sample Keys (з R2):**
- `legislation/administrative/80731-10.json` (4.1 MB)
- `legislation/administrative/80732-10.json` (2.1 MB)
- `legislation/civil/435-15.json` (6.0 MB)
- `legislation/constitutional/254к%2F96-%D0%B2%D1%80.json` (577 KB)
- `legislation/criminal/2341-14.json` (4.4 MB)

**⚠️ Protected Prefixes (НЕ ЧІПАТИ):**
- `legislation/ActCatalogResolver/cache/...` (кеш мікросервісу)
- `legislation/DocListDB rada gov updater log/...` (логи мікросервісу)

---

## 7. Risks / UNKNOWN / Next Steps

### Known Risks

1. **Category "other" (10%)** — 5 документів мають category="other". Можливо потребують перекласифікації через AI.

2. **Sync Health "yellow" (44%)** — 22 документи мають yellow статус. Потрібно перевірити через `verify --all --write-health`.

3. **Sync Health "red" (6%)** — 3 документи мають red статус. Критично, потрібно виправити через `repair consistency`.

4. **Failed Jobs (7.2%)** — 7 jobs failed. Потрібно перевірити через `jobs list --failed` та `jobs inspect`.

5. **Running Jobs (4.1%)** — 4 jobs running. Можливо зависли, потрібно перевірити через `jobs inspect`.

### UNKNOWN

1. **Qdrant Total Points** — не перевірено через MCP (немає прямого доступу). Потрібно перевірити через `inspect-qdrant-acts` або `verify --all`.

2. **R2 Total Files** — не перевірено повну кількість файлів в R2. Потрібно перевірити через `list_files` з пагінацією.

3. **Canonical JSON Structure Consistency** — не перевірено чи всі canonical JSON мають однакову структуру. Потрібно перевірити через `verify --all`.

4. **Act Group Coverage** — не перевірено скільки документів мають `act_is_part=true`. Потрібно перевірити через SQL.

5. **Embedding Quality** — не перевірено якість embeddings (semantic similarity). Потрібно перевірити через `search` команди.

### Next Steps (без реалізації в цій сесії)

1. **Health Repair** — виконати `verify --all --write-health` для оновлення sync_health всіх документів.

2. **Failed Jobs Investigation** — перевірити failed jobs через `jobs list --failed` та `jobs inspect`, виправити помилки.

3. **Running Jobs Check** — перевірити running jobs через `jobs inspect`, завершити або перезапустити.

4. **Category "other" Review** — перевірити 5 документів з category="other", можливо перекласифікувати через `repair categories --force-ai`.

5. **Red Status Repair** — виправити 3 документи з red статусом через `repair consistency`.

6. **Qdrant Dedup** — перевірити чи немає старих версій в Qdrant, виконати `repair-qdrant-dedup` якщо потрібно.

7. **R2 Audit** — перевірити чи всі r2_key з Supabase існують в R2, виправити якщо потрібно.

8. **Documentation Update** — оновити OPERATIONAL_GUIDE.md з новими командами та best practices.

---

## 8. Ключові файли документації

- **VERSIONING_POLICY.md** — політика версіонування (CURRENT VERSION ONLY)
- **SCHEMA_MAP.md** — мапа схеми Supabase (CORE vs OPTIONAL vs DEPRECATED)
- **OPERATIONAL_GUIDE.md** — операційний гід (команди, troubleshooting)
- **FINAL_SUMMARY.md** — підсумок попередньої сесії
- **PHASE_*.md** — фазові репорти

---

**Цей документ зафіксовано як checkpoint після повного аудиту системи та інфраструктури.** ✅
