# DocListDB / Legislation Catalog — ARCHITECTURE

## 1) Що це за модуль

**DocListDB / Legislation Catalog** — сервіс/набір production‑скриптів, який індексує **“картки актів”** (метадані без повних текстів) і дає API для резолву людських запитів у точні ідентифікатори актів:

- `nreg` (рядковий ідентифікатор/номер реєстрації)
- `dokid` (числовий id документа)
- `nazva` (назва)

Це дозволяє AI швидко:
- зрозуміти, що акт існує (всі роки, історичні/актуальні),
- отримати точні `nreg/dokid` для наступних кроків (витяг повного тексту, цитування, RAG по тексту тощо).

**Факт (prod):** каталог зберігається в **Qdrant**; Cloudflare Vectorize **не використовується**.

---

## 2) Які дані зберігаємо

### 2.1) “Картка акта” (payload schema)

Payload у Qdrant (ключі повинні залишатися сумісними між імпортером/апдейтером/резолвером):

- `nreg`: string
- `dokid`: number
- `nazva`: string
- `type`: string (нормалізований код/тип)
- `organ`: string (нормалізований код/орган)
- `status`: string
- `year`: number | null
- `datred`: string | null (формат `YYYYMMDD`)
- `minjust`: boolean
- `source_system`: `"rada"`
- `is_in_supabase`: boolean
- `supabase_doc_id`: string | null
- `types_raw?`: string
- `organs_raw?`: string

### 2.2) Embedding contract (критично)

Для консистентного semantic search **запит і документи повинні бути в одному embedding‑просторі**:

- **Endpoint**: `https://openrouter.ai/api/v1/embeddings`
- **Model**: `text-embedding-3-small`
- **Dimensions**: `768`

Якщо dims не збігаються з Qdrant колекцією — пайплайни мають **падати**, а не “мовчки truncate”.

---

## 3) Компоненти

### 3.1) Full import (initial load)

**Папка:** `Full Import Script/`  
**Що робить:** завантажує `doc.zip` → парсить `doc.txt` → нормалізує → (опц.) Supabase map → embeddings → **upsert** у Qdrant.

- **Вхід**: `doc.zip/doc.txt` з Rada Open Data
- **Вихід**: points у Qdrant `legislation-catalog-index` (vector + payload)
- **State**: локально в `Full Import Script/tmp/` (resume state / errors / report)

**Як запускати (локально):**

```bash
npm install --prefix "scripts/legislation/Documentation List DB/Full Import Script"
npm run --prefix "scripts/legislation/Documentation List DB/Full Import Script" build
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" --help
```

Корисні команди:
- `download-doc` — завантажити джерело
- `test` — 10 записів + cleanup
- `import` / `resume` — повний імпорт з pause/resume
- `audit` — контрольні query/filters

### 3.2) Updater (rada.gov incremental)

**Папка:** `UpdaterDB/`  
**Що робить:** щодня бере дельти з Rada feeds → тягне card JSON → нормалізує → порівнює з Qdrant payload → для змін робить embeddings → batch upsert у Qdrant.

- **Джерела**:
  - `https://data.rada.gov.ua/laws/main/r.txt` (updated)
  - `https://data.rada.gov.ua/laws/main/nn` (new)
  - (опц.) `https://data.rada.gov.ua/laws/main/n` (backstop)
  - `https://data.rada.gov.ua/laws/card/<nreg>.json`
- **State/lock/logs**: Cloudflare R2 (S3 API)

**Як запускати (локально):**

```bash
cd "scripts/legislation/Documentation List DB/UpdaterDB"
npm ci
npm run sync -- --dry-run --max-docs 25
```

### 3.3) Act Catalog Resolver API (Cloudflare Worker)

**Папка:** `Act Catalog Resolver API/`  
**Що робить:** приймає людський запит → робить fast‑path по `nreg` або vector search у Qdrant → (опц.) LLM rerank → повертає `nreg/dokid/nazva`.

- **Prod Worker**: `act-catalog-resolver`
- **Prod URL**: `https://act-catalog-resolver.andriykosrdkgames.workers.dev`
- **Endpoints**: `GET /health`, `POST /catalog/resolve`
- **Modes**: `auto | vector-only | llm-rerank`
- **Cache (опц.)**: R2 prefix `legislation/ActCatalogResolver/cache/`

**Локальний запуск:**

```bash
cd "scripts/legislation/Documentation List DB/Act Catalog Resolver API"
npm install
npx wrangler dev --env-file "/absolute/path/to/your/.env"
```

---

## 4) Data flow (схема)

### 4.1) Data ingest

`rada doc.zip/doc.txt` → **Full Import Script** → (embeddings) → **Qdrant `legislation-catalog-index`**

`rada feeds + card JSON` → **UpdaterDB** → (compare → embeddings для змін) → **Qdrant `legislation-catalog-index`** → (logs/state) → **R2**

### 4.2) Query / resolve

`user query` → **Resolver API** → (embeddings) → **Qdrant search/scroll** → (optional rerank via OpenRouter chat) → `nreg list`

---

## 5) Infra state snapshot (важливо)

### 5.1) Qdrant (prod)

- **Collection**: `legislation-catalog-index`
- **Vectors**: `size=768`, `distance=Cosine`
- **Points**: ~`289,615`
- **Collections у кластері**: `["legislation-catalog-index"]` (станом на 2026‑01‑21)

### 5.2) Cloudflare Workers (prod)

- **Worker**: `act-catalog-resolver`
- **URL**: `https://act-catalog-resolver.andriykosrdkgames.workers.dev`
- **Required vars/secrets (імена, без значень):**
  - Qdrant: `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`
  - Embeddings:
    - `EMBEDDING_API_KEY` (preferred) **or** `OPEN_ROUTER_API_RAG` (compat)
    - `EMBEDDING_ENDPOINT`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`
  - Rerank:
    - `RERANK_ENABLED`, `RERANK_MODEL`, `OPENROUTER_BASE_URL`
    - `OPENROUTER_API_KEY` (preferred; fallback: `OPEN_ROUTER_API_RAG`)
  - R2 cache: `CACHE_ENABLED`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`, `R2_REGION`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

### 5.3) Cloudflare R2 (prod)

- **Bucket**: `legislation`
- **Updater**:
  - prefix: `legislation/DocListDB rada gov updater log/`
  - keys: `state.json`, `locks/daily.lock`, `runs/<run_id>.json`
- **Resolver cache**:
  - prefix: `legislation/ActCatalogResolver/cache/` (наприклад `by_query/*.json`)

### 5.4) GitHub Actions

- **Workflow**: `.github/workflows/rada-doclistdb-updater.yml`
- **Schedule**: `cron: "17 2 * * *"`
- **Secrets expected**:
  - `QDRANT_URL`, `QDRANT_API_KEY`
  - `OPEN_ROUTER_API_RAG`
  - `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

### 5.5) Supabase

Цей модуль **не є “source of truth”** для каталогу актів, але importer може (опційно) підтягувати мапінг `nreg -> supabase_doc_id`.

Фактичний стан у проекті:
- `public.legislation_documents` існує (колонки включають `rada_nreg`, `rada_dokid`, `r2_key`, `title`, …)
- `public.legal_documents` може бути відсутня (імпортер має fallback)

---

## 6) How to run (коротко)

### 6.1) Local

- Importer: встановити → build → `dist/cli.js import|resume|test`
- Updater: `npm ci` → `npm run sync [--dry-run]`
- Resolver: `npm install` → `wrangler dev` → `curl http://127.0.0.1:8787/health`

### 6.2) Prod

- Resolver: `npx wrangler deploy` (secrets/vars через `wrangler secret put` / `wrangler.toml`)
- Updater: запускається GitHub Actions workflow

---

## 7) Known limitations / future improvements

- **Semantic ambiguity**: людські запити можуть бути двозначними → rerank/heuristics не ідеальні.
- **Synonyms/query rewrite**: можна додати synonym‑словарі або query‑rewrite перед embeddings.
- **Hybrid search**: BM25 + vector/hybrid (або фільтри + vector) для складних кейсів.
- **Better filters UX**: нормалізація органів/типів, більш строгі фільтри по роках/статусу.
- **Окремий nreg-index**: дуже швидкий exact/regex lookup до Qdrant (або payload‑індексів) для `nreg_exact`.

