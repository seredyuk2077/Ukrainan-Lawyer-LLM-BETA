## Act Catalog Resolver API (Cloudflare Worker)

Ізольований HTTP‑сервіс, який робить **пошук по каталогу актів DocListDB** (картки актів у Qdrant, без повних текстів) і повертає компактні посилання на акти: `nreg`, `dokid`, `nazva`.

Це задумано як окремий бекенд‑компонент для юридичного AI: основна LLM не “гуглить” і не перебирає каталоги сама, а викликає цей сервіс як інструмент і отримує **точні ідентифікатори актів** для подальших кроків (витяг повного тексту, цитування, тощо).

### Production

- **Worker**: `act-catalog-resolver`
- **Prod URL**: `https://act-catalog-resolver.andriykosrdkgames.workers.dev`
- **Endpoints**: `GET /health`, `POST /catalog/resolve`

---

## Дані та індекси

### Qdrant

- **Collection**: `legislation-catalog-index`
- Індексуємо **картки актів** (DocListDB catalog), не тексти актів.

Ключові поля payload (див. `src/types.ts`):

- `nreg`, `dokid`, `nazva`
- `type`, `organ` (коди рядками, напр. `"2"`, `"4"`)
- `status`, `year`, `datred`, `minjust`

### Embeddings

Embedding контракт має збігатися з імпортером/апдейтером:

- **Endpoint**: `https://openrouter.ai/api/v1/embeddings`
- **Model**: `text-embedding-3-small`
- **Dimensions**: `768`

---

## Архітектура та pipeline (як працює пошук)

1) **HTTP**: `POST /catalog/resolve`  
2) **Interpret** (`src/search/interpret.ts`):
   - класифікація запиту: `nreg_exact | nreg_partial | semantic`
   - виділення nreg‑токена з тексту (якщо він є)
   - прості **metadata hints** з тексту (рік, орган, тип)
   - відомі alias (зараз: “Конституція …” → `254к/96-вр`)
3) **Fast path**:
   - для `nreg_exact` робимо швидкий lookup в Qdrant через `scroll` по `payload.nreg`
4) **Vector search (Qdrant)**:
   - будуємо `embedding_text` (запит + текстові підказки фільтрів)
   - рахуємо embedding
   - робимо `search` в Qdrant (беремо `candidates` кандидатів)
5) **Rerank (опційно)**:
   - `mode=vector-only`: rerank ніколи не виконується
   - `mode=llm-rerank`: rerank завжди (якщо увімкнено в конфігу)
   - `mode=auto`: rerank виконується лише якщо запит **достатньо “складний/двозначний”** (консервативні евристики в `src/search/pipeline.ts`)
6) **Формування відповіді**: top‑`k` результатів + `strategy` + `meta`

### NREG нормалізація

Для актів ВРУ суфікси виду `-IX/-IV/-III/...` канонізуються як **roman + 11**:

- `2341-III -> 2341-14`
- `435-IV -> 435-15`
- `113-IX -> 113-20`

---

## Фільтри

У запиті можна вказати `filters`:

- `types`: `LAW | CODE | CONSTITUTION | RESOLUTION | DECREE | ORDER | VRU_LAW | VRU_RESOLUTION | KABMIN_RESOLUTION | KABMIN_ORDER | PRESIDENT_DECREE | PRESIDENT_ORDER`
- `organs`: `VRU | KMU | PRESIDENT`
- `year_from`, `year_to` (включно)

Якщо **явні** `filters` не задані, pipeline може “захардкодити” частину підказок з тексту (тільки безпечні): `year_*`, `organs`, а з `types` — лише комбіновані категорії типу `KABMIN_RESOLUTION`, `PRESIDENT_DECREE` тощо.

---

## Cache (R2 S3 API)

Кеш зберігає **готові відповіді** в Cloudflare R2 під префіксом:

- bucket: `legislation`
- prefix: `legislation/ActCatalogResolver/cache/`

Важливо:

- кеш працює лише коли `CACHE_ENABLED=true`
- **debug‑відповіді не кешуються** (`debug=true`), щоб уникнути збереження діагностики та мати прогнозовану поведінку

---

## API

### `GET /health`

Повертає:

```json
{ "status": "ok", "ok": true, "service": "act-catalog-resolver-api", "ts": "..." }
```

### `POST /catalog/resolve`

#### Request JSON

```json
{
  "query": "закон про поліцію",
  "k": 5,
  "candidates": 100,
  "filters": {
    "types": ["LAW"],
    "organs": ["VRU"],
    "year_from": 2010,
    "year_to": 2015
  },
  "mode": "auto",
  "debug": false
}
```

- `query` (required): рядок запиту
- `k` (default `5`, max `20`)
- `candidates` (default `100`, max `200`)
- `lang` (optional): зараз не впливає на pipeline (залишено для сумісності/майбутнього)
- `mode`: `auto | vector-only | llm-rerank`
- `debug`: якщо `true`, додає `debug.plan`, `debug.filter`, `debug.embedding_text`, `debug.returned_payload_meta` (також можна ввімкнути через `?debug=1`)

#### Response JSON (скорочено)

```json
{
  "query": "…",
  "normalized_query": "…",
  "strategy": {
    "fast_path": "nreg_exact | nreg_partial | vector",
    "rerank_used": false,
    "filters_applied": {}
  },
  "results": [
    {
      "nreg": "70-2022-р",
      "dokid": 513220,
      "nazva": "…",
      "score": 0.91,
      "source_score": 0.91,
      "rerank_score": 0.98,
      "why": "…"
    }
  ],
  "meta": {
    "candidates_requested": 100,
    "candidates_actual": 87,
    "returned": 5,
    "took_ms": 412
  }
}
```

#### Errors

- `400`: невалідний JSON, порожній `query`, або запитаний `mode=llm-rerank` при вимкненому rerank
- `500`: внутрішня помилка (мережа/таймаути/зовнішні сервіси)

---

## Приклади curl

### Prod

```bash
curl -sS https://act-catalog-resolver.andriykosrdkgames.workers.dev/health
```

```bash
curl -sS https://act-catalog-resolver.andriykosrdkgames.workers.dev/catalog/resolve \
  -H 'content-type: application/json' \
  -d '{"query":"70-2022-р","k":1,"mode":"auto"}'
```

### Local

```bash
curl -sS http://127.0.0.1:8787/catalog/resolve \
  -H 'content-type: application/json' \
  -d '{"query":"закон про поліцію","k":5,"mode":"auto"}'
```

---

## Demo CLI

Є маленький “чат” для живої демонстрації сервісу: вводиш текст → він викликає API → друкує кроки та top‑результати.

### Запуск

З папки `Act Catalog Resolver API/`:

```bash
npm run demo
```

Або через `Makefile`:

```bash
make demo
```

Опційно можна задати URL воркера:

- env: `CATALOG_RESOLVER_URL`
- або аргумент: `node scripts/demo-chat.mjs --url=https://...`

Demo викликає `/catalog/resolve` з `debug=true`, щоб з відповіді зібрати “людинозрозумілі” кроки (fast‑path / embedding / Qdrant / rerank). Через це demo‑запити **не кешуються**.

---

## Локальний запуск

### Install

```bash
npm install
```

### Dev

Рекомендовано передати env‑файл напряму (наприклад repo‑root `.env`):

```bash
npx wrangler dev --env-file "/absolute/path/to/your/.env"
```

Або:

```bash
make dev
```

Або створити `.dev.vars` у цій папці (не комітиться) і запустити:

```bash
npx wrangler dev
```

---

## Інтеграційні тести

Локально (скрипт сам піднімає `wrangler dev`):

```bash
npm run test:integration
```

Проти прод‑URL (без `wrangler dev`):

```bash
node scripts/tests/run.mjs --startDev=false --baseUrl=https://act-catalog-resolver.andriykosrdkgames.workers.dev
```

---

## Env vars & Deploy

Шаблон: `env.example`.

### Мінімально потрібні (Worker runtime)

- `QDRANT_URL`
- `QDRANT_API_KEY` (якщо потрібен)
- `EMBEDDING_API_KEY` (**preferred**) **або** `OPEN_ROUTER_API_RAG` (сумісність; у проді часто це той самий ключ OpenRouter)

### Для rerank

- `RERANK_ENABLED=true`
- `OPENROUTER_API_KEY` (preferred; OpenRouter chat completions key)
- (опц.) fallback: `OPEN_ROUTER_API_RAG`

### Для R2 cache

- `CACHE_ENABLED=true`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET` (default `legislation`)
- `R2_PREFIX` (default `legislation/ActCatalogResolver/cache/`)

### Deploy

```bash
npx wrangler deploy
```

---

## Як використовувати як tool у LLM

Типовий сценарій:

1) LLM викликає `POST /catalog/resolve` з `query` і `mode=auto`.
2) Беремо top‑`k` результатів і повертаємо в агента лише **ідентифікатори** (`dokid`, `nreg`) + коротку назву.
3) Наступним кроком агент може витягнути повний текст/версію акту по `dokid` у зовнішньому модулі.

