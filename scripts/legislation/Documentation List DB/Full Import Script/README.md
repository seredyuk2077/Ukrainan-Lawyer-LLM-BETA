## DocListDB — Full Import Script (production)

Production-ready full importer for the **Rada `doc.zip` → `doc.txt`** catalog into **Qdrant** with:
- pause/resume (stateful)
- retry/backoff + dead-letter (`errors.jsonl`)
- structured logs + heartbeat
- Supabase sync (optional): `nreg -> supabase_doc_id` (підтримує `legal_documents`, і fallback на `legislation_documents`)
- built-in `test` mode (10 records) with pause/resume + audit + cleanup + PASS/FAIL report

### Folder boundary (important)

All local artifacts are created **inside this folder**:
- `tmp/doc.zip`, `tmp/doc.txt` (local source)
- `tmp/state.json` (resume state)
- `tmp/errors.jsonl` (dead-letter / error log)
- `tmp/inserted_ids.jsonl` (IDs inserted by test/run for cleanup)
- `tmp/report.json` (last run report)

### Requirements

- Node.js 18+
- Root `.env` (repository root) with:
  - **Qdrant**:
    - `QDRANT_URL` (e.g. `https://<host>:6333`) **or** `QDRANT_API` (as base URL)
    - `QDRANT_API_KEY` (if your Qdrant requires it)
    - optional: `QDRANT_COLLECTION` (defaults to `legislation-catalog-index`)
    - optional: `QDRANT_TIMEOUT_MS`
  - **OpenRouter**: `OPEN_ROUTER_API_RAG`
  - **Supabase** (optional; default enabled): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
    - If your project does not have `legal_documents`, the importer will try `legislation_documents (rada_nreg)` automatically.
    - You can disable sync with `--skip-supabase-sync`.

### Install

From repo root:

```bash
npm install --prefix "scripts/legislation/Documentation List DB/Full Import Script"
```

### Build

```bash
npm run --prefix "scripts/legislation/Documentation List DB/Full Import Script" build
```

### Canonical commands

All commands run the compiled CLI:

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" --help
```

#### 1) Download `doc.zip` and prepare local `doc.txt`

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" download-doc
```

#### 2) Built-in end-to-end test (10 records, pause/resume, audit, cleanup)

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" test
```

#### 3) Full import (creates new state)

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" import
```

Useful knobs:
- `--batch-size 200`
- `--time-limit 3600`
- `--pause-after-batches 50`
- `--skip-supabase-sync`
- `--index-name legislation-catalog-index` (Qdrant collection name)
- `--expected-index-dimensions 768`
- `--openrouter-dimensions 768` (requests embeddings in the desired dimensions if supported)

#### 4) Resume a paused/interrupt run

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" resume
```

#### 5) Audit (semantic query + filter query)

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" audit
```

#### 6) Cleanup (delete-by-ids)

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" cleanup
```

#### 7) Reset local state (dangerous, local only)

```bash
node "scripts/legislation/Documentation List DB/Full Import Script/dist/cli.js" reset-state --force
```

### Notes on embedding dimensions (critical safety)

This importer **will not truncate embeddings silently**.

- If the embedding model returns vectors with dimensions not equal to `--expected-index-dimensions`,
  the run will stop with an actionable error:
  - use a model / API option that returns the required dimensions (e.g. `--openrouter-dimensions 768`).

### Troubleshooting

- Check `tmp/errors.jsonl` for record-level details (payload validation, schema mismatches, network errors).

