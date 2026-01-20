# DocListDB — Daily Updater (Rada cards → embeddings → Qdrant)

This folder contains an **isolated**, production-oriented updater that runs daily and keeps **DocListDB “document cards”** in Qdrant up to date **incrementally**:

- reads delta candidates from Rada feeds (`r.txt` + `nn`, optional weekly backstop `n`)
- fetches **only card JSON** (`/laws/card/<nreg>.json`) — **no full document texts**
- normalizes to the existing payload schema (keys preserved)
- compares with existing Qdrant payload (skip if identical → no embeddings/upsert)
- for changed/new cards: computes embeddings and **batch upserts** to Qdrant
- stores **state + lock + run reports** in **Cloudflare R2** (S3-compatible API; no MCP at runtime)

## Commands

Run from this folder:

```bash
npm ci

# Dry-run (no embeddings, no Qdrant upsert)
npm run sync -- --dry-run --max-docs 25

# Normal run
npm run sync

# Force weekly/monthly backstop (30 days)
npm run sync -- --backstop

# Self-test: when there are no changes, do insert/retrieve/delete in Qdrant and log “selftest ok”
npm run sync -- --selftest
```

### CLI flags

- `--dry-run`: fetch feeds/cards + normalize + (optionally) compare against Qdrant; **no embeddings, no upsert**
- `--backstop`: also read 30-day HTML feed `https://data.rada.gov.ua/laws/main/n`
- `--selftest`: when there are **no candidates**, perform Qdrant insert/retrieve/delete with a UUID id
- `--max-docs N`: process at most N candidates
- `--concurrency N`: concurrency for fetching cards + Qdrant compares (defaults to 1)
- `--rada-delay-min-ms / --rada-delay-max-ms`: pacing between Rada requests (defaults 5000–7000ms)
- `--skip-retrieve`: skip Qdrant compare (useful for dry-run smoke checks)
- `--log-level debug|info|warn|error`

## Rada endpoints used

- **Updated feed**: `https://data.rada.gov.ua/laws/main/r.txt`
- **New today**: `https://data.rada.gov.ua/laws/main/nn`
- **Backstop (30d)**: `https://data.rada.gov.ua/laws/main/n`
- **Card JSON**: `https://data.rada.gov.ua/laws/card/<nreg>.json`

HTTP rules implemented:

- always sets `User-Agent: OpenData`
- supports `Last-Modified` / `If-Modified-Since` for `r.txt`, `nn`, and `n`
- retry/backoff on `429` and `5xx`
- request pacing (random delay, configurable)
- **does not call** `/api/token` or `/api/limits`

## State + lock + run reports in R2

All runtime artifacts are stored under:

- bucket: `R2_BUCKET`
- prefix: `R2_PREFIX` (default: `legislation/DocListDB rada gov updater log/`)

Notes:
- The updater also accepts the legacy/wrong prefix `legislation/DocListDB/rada gov updater log/` and automatically maps it to the existing one above.

Keys used:

- `state.json`: persistent state (Last-Modified values + last successful run timestamps)
- `locks/daily.lock`: lock file (to prevent double runs); if the lock is younger than TTL → exit **code 0**
- `runs/<run_id>.json`: run report (stats + changed examples + truncated errors)

State is only written **after a fully successful run**.

## Environment variables

This updater reads env vars from the environment (GitHub Actions secrets) or from a local `.env`.

If your tooling blocks `.env.example`, use `env.example` as a template.

### Qdrant

- `QDRANT_URL` (preferred) or `QDRANT_API` (legacy base URL)
- `QDRANT_API_KEY` (if required)
- `QDRANT_COLLECTION` (default: `legislation-catalog-index`)
- `QDRANT_TIMEOUT_MS` (optional)

### Embeddings (OpenRouter-compatible)

- `EMBEDDING_API_KEY` **or** `OPEN_ROUTER_API_RAG`
- `EMBEDDING_MODEL` (default: `text-embedding-3-small`)
- `EMBEDDING_DIMENSIONS` (default: `768`)
- `EMBEDDING_ENDPOINT` (default: `https://openrouter.ai/api/v1/embeddings`)
- `EMBEDDING_TIMEOUT_MS` (optional)

### Cloudflare R2 (S3 API)

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID` (or `R2_ACCESS_KEY`)
- `R2_SECRET_ACCESS_KEY` (or `R2_SECRET_KEY`)
- `R2_REGION` (default: `auto`)
- `R2_BUCKET` (or `R2_BUCKET_NAME`)
- `R2_PREFIX` (default uses the existing prefix with spaces)

## Notes / compatibility

- **nreg encoding**: `nreg` may contain slashes and Cyrillic. We encode **path segments** (split by `/`) to avoid turning `/` into `%2F`.
- **Qdrant point IDs**: the updater tries `retrieve(id=dokid)` first. If not found, it falls back to a fast `scroll` filter by `dokid` and will upsert using the found point id to avoid duplicates.
- **Supabase fields**: the updater preserves `is_in_supabase` / `supabase_doc_id` from existing payload (if present) to avoid spurious changes.

