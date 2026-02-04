# Lexery Legislation DB Infra — Runtime Architecture

## Система

Імпорт актів з **rada.gov.ua** → canonical JSON → **R2** (source of truth) → embeddings → **Qdrant** (acts + chunks) → **Supabase** (metadata, jobs, sync_health). Retrieval: Qdrant vector search.

## Компоненти

- **Supabase:** legislation_documents, legislation_import_jobs.
- **R2:** bucket за `R2_LEGISLATION_BUCKET`; ключі `{category}/{rada_nreg}.json`.
- **Qdrant:** колекції acts і chunks; payload.rada_nreg обовʼязковий. Чанки тільки в Qdrant (таблиці legislation_chunks немає).

## Pipeline

- **add:** normalize nreg → fetch → buildCanonical → R2 write → embed → Qdrant upsert → Supabase upsert.
- **verify:** Supabase ↔ R2 ↔ Qdrant консистентність; `--write-health` оновлює sync_health.
- **inspect:** діагностика одного документу.
- **remove:** Qdrant (chunks → acts) → R2 delete → Supabase delete; ідемпотентний.

## Recovery

- R2 missing → add/update --force.
- Qdrant partial → update --force.
- Supabase mismatch → verify --write-health, repair-consistency.
