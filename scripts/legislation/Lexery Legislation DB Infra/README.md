# Lexery Legislation DB Infra

Прод-пакет для pipeline Legislation RAG: імпорт актів з rada.gov.ua → canonical в R2 → embeddings → Qdrant (acts/chunks) → Supabase (metadata, jobs, sync_health).

---

## Сервіси та схема даних

| Сервіс | Призначення | Ключові сутності |
|--------|-------------|-------------------|
| **Supabase** | Реєстр документів і jobs | Таблиці: `legislation_documents`, `legislation_import_jobs`, `legislation_import_proposals` |
| **R2** | Source of truth для canonical | Один bucket: `R2_LEGISLATION_BUCKET` (default `legislation`). Ключі: `legislation/{category}/{rada_nreg}.json` |
| **Qdrant** | Векторний пошук | Колекції: `lexery_legislation_acts`, `lexery_legislation_chunks`. Payload обов'язково містить `rada_nreg` |

Детально: [ARCHITECTURE.md](./ARCHITECTURE.md) (схема, таблиці, бакет, колекції), [PIPELINE.md](./PIPELINE.md) (покроково add/verify/remove/inspect).

---

## Ізольований запуск (перенос пакету)

Пакет можна переносити й запускати окремо (наприклад, на іншому хості або в CI). Шляхи не залежать від `scripts/legislation/`:

- **Робоча директорія:** `process.cwd()` або змінна `LEXERY_LEGISLATION_WORKSPACE_ROOT`. У цій директорії мають бути `.env` і (за потреби) папки `runs/`, `data/`, `tmp/`.
- **Run-артефакти:** зберігаються в R2 під `legislation/tech/runs/`, локально папка `runs/` не створюється.
- **Локальні виходи аудитів:** якщо команда пише у файл — використовується `runs/` або `data/` відносно workspace root.

Для ізольованого запуску: скопіюйте папку `scripts/legislation/` (включно з `admin-cli.ts` і папкою `Lexery Legislation DB Infra`), додайте `.env` у корінь робочої директорії і запускайте з неї: `pnpm exec tsx admin-cli.ts status` (або з батьківської директорії: `pnpm exec tsx legislation/admin-cli.ts status`).

---

## Запуск (з monorepo)

```bash
pnpm exec tsx scripts/legislation/admin-cli.ts --help
pnpm exec tsx scripts/legislation/admin-cli.ts add --nreg "322-08"
pnpm exec tsx scripts/legislation/admin-cli.ts verify --nreg "322-08" --write-health
pnpm exec tsx scripts/legislation/admin-cli.ts inspect --nreg "322-08"
pnpm exec tsx scripts/legislation/admin-cli.ts remove --nreg "322-08" --confirm
pnpm exec tsx scripts/legislation/admin-cli.ts search --query "трудовий договір" --topk 5
```

---

## Env vars

| Змінна | Призначення |
|--------|-------------|
| `SUPABASE_LEGISLATION_URL` | URL проєкту Supabase |
| `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY` | Service role key (admin) |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 (S3-сумісний API) |
| `R2_LEGISLATION_BUCKET` | Ім'я бакету (default: `legislation`) |
| `qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB` | URL кластера Qdrant |
| `qdrant_clusterAPI_LEXERY_LEGISLATION_DB` | API key Qdrant |
| `OPEN_ROUTER_API_RAG` | API key для AI enrichment (OpenRouter) |

---

## Структура пакету

| Папка | Призначення |
|-------|-------------|
| `src/commands/` | CLI-команди: add, verify, remove, inspect, repair, backfill, search, soak-test, тощо |
| `src/lib/` | Supabase, R2, Qdrant, Rada, importer, job progress, AI enrichment |
| `src/canonical/` | buildCanonical, chunking, embeddings, r2Path (ключі R2) |
| `src/documentTypes/`, `src/taxonomy/`, `src/utils/` | Типи документів, категорії, nreg/rawFetch |
