# DocListDB / Legislation Catalog (Documentation List DB)

Ця папка — “DocListDB / Legislation Catalog”: набір production‑скриптів/сервісів, які дозволяють AI швидко:
- дізнатись, **які акти існують** (усі роки, історичні/актуальні)
- отримати релевантні `nreg/dokid/nazva` через HTTP API

**Факт (prod):** каталог актів зберігається в **Qdrant**, колекція `legislation-catalog-index`.  
Cloudflare Vectorize **не використовується** (див. `deprecated/vectorize/`).

## Entry points

- `ARCHITECTURE.md` — повна архітектура, data flow, infra snapshot, how-to-run
- `Full Import Script/README.md` — повний імпорт `doc.zip/doc.txt → embeddings → Qdrant`
- `UpdaterDB/README.md` — щоденний інкрементальний апдейтер `rada.gov.ua → Qdrant` + R2 state/logs
- `Act Catalog Resolver API/README.md` — Cloudflare Worker API `POST /catalog/resolve`

## Структура папки

- `Full Import Script/` — production importer (stateful, resumable) для первинного наповнення Qdrant
- `UpdaterDB/` — daily updater (incremental) + R2 state/lock/logs
- `Act Catalog Resolver API/` — Worker API для резолву актів (vector search + optional rerank + optional R2 cache)
- `deprecated/` — legacy/архів (в т.ч. Vectorize)

## Мінімальні залежності (локально)

- Node.js 18+ (Updater workflow використовує Node 20)
- Доступи через env vars (значення не комітяться; див. `env.example` у підпапках)

