# Lexery Legislation DB Infra

Прод-пакет для pipeline Legislation RAG: імпорт актів з rada.gov.ua → canonical в R2 → embeddings → Qdrant (acts/chunks) → Supabase (metadata, jobs, sync_health).

## Запуск (з monorepo)

З кореня проєкту:

```bash
pnpm exec tsx scripts/legislation/admin-cli.ts --help
pnpm exec tsx scripts/legislation/admin-cli.ts add --nreg "322-08"
pnpm exec tsx scripts/legislation/admin-cli.ts verify --nreg "322-08" --write-health
pnpm exec tsx scripts/legislation/admin-cli.ts inspect --nreg "322-08"
pnpm exec tsx scripts/legislation/admin-cli.ts remove --nreg "322-08" --confirm
```

## Env vars

- `SUPABASE_LEGISLATION_URL`, `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY`
- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_LEGISLATION_BUCKET`
- `qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB`, `qdrant_clusterAPI_LEXERY_LEGISLATION_DB`
- `OPEN_ROUTER_API_RAG` (для AI enrichment)

## Структура

- `src/commands/` — CLI-команди (add, verify, remove, inspect, repair, backfill, тощо)
- `src/lib/` — Supabase, R2, Qdrant, Rada, importer, job progress
- `src/canonical/` — buildCanonical, chunking, embeddings, r2Path
- `src/documentTypes/`, `src/taxonomy/`, `src/utils/` — типи, таксономія, nreg/rawFetch

Детальніше: [ARCHITECTURE.md](./ARCHITECTURE.md).
