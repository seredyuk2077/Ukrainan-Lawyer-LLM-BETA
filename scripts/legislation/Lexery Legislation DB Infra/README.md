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
pnpm exec tsx scripts/legislation/admin-cli.ts repair qdrant-dedup --nreg "322-08"
pnpm exec tsx scripts/legislation/admin-cli.ts audit-qdrant-payload --limit 50
pnpm exec tsx scripts/legislation/admin-cli.ts refresh-qdrant-payload-batch --concurrency 2 --batch-size 25 --resume
pnpm exec tsx scripts/legislation/admin-cli.ts reload-corpus-batch --concurrency 2 --batch-size 10 --resume
```

---

## Qdrant hygiene / version control

- `update --nreg ... --force` переіндексовує canonical поточну версію документа.
- Після успішного reindex importer автоматично видаляє старі Qdrant points з тим самим `rada_nreg`, але іншим `content_hash`.
- Для ручного контролю доступна команда:

```bash
pnpm exec tsx scripts/legislation/admin-cli.ts repair qdrant-dedup --nreg "322-08" --dry-run
pnpm exec tsx scripts/legislation/admin-cli.ts repair qdrant-dedup --nreg "322-08"
```

- Операційне правило: після масових update/import batch треба або переконатися, що importer завершив cleanup, або явно прогнати `repair qdrant-dedup` для підозрілих актів.
- Якщо LLDBI corpus розширюється, canonical/R2, Supabase metadata і Qdrant мають залишатися в sync. Старі версії в Qdrant не можна залишати, бо вони прямо збільшують retrieval noise.
- Для системного контролю payload completeness і drift використовуйте:

```bash
pnpm exec tsx scripts/legislation/admin-cli.ts audit-qdrant-payload
pnpm exec tsx scripts/legislation/admin-cli.ts audit-qdrant-payload --nregs "2755-17,z1257-07"
```

- Аудит перевіряє current-hash presence, старі версії в Qdrant, completeness полів `chunk_title/unit_type/unit_number/article_number/r2_key/json_path`, а також act payload (`summary/keywords/topics/aliases/validity_status`).
- Практичне правило: якщо audit показує `QDRANT_OLD_*` → спочатку `repair qdrant-dedup`; якщо показує missing/drift на current hash → `update --nreg ... --force`.

### Cheap payload refresh path

- Якщо audit показує тільки payload issues на current-hash points (`QDRANT_MISSING_CHUNK_TITLE`, metadata gaps) і/або старі версії, не обов'язково робити дорогий full re-embed.
- Для таких кейсів використовуйте:
- Для таких кейсів використовуйте:

```bash
pnpm exec tsx scripts/legislation/admin-cli.ts refresh-qdrant-payload-batch --resume
pnpm exec tsx scripts/legislation/admin-cli.ts refresh-qdrant-payload-batch --nregs "48/26-рг,v0007700-81"
```

- Команда:
  - читає audit report або явний список `nreg`
  - відновлює act/chunk payload з canonical в R2 + Supabase metadata
  - прибирає old versions у Qdrant
  - робить fallback на `update --force`, якщо current-hash points неповні або audit показує не лише refreshable issues
- Операційне правило: перед дорогим corpus-wide `update --force` спочатку спробуйте `refresh-qdrant-payload-batch`; це суттєво дешевше і швидше для чисто payload-driven регресій retrieval.

### Full corpus reload path

- Якщо змінюється canonical parser, embedding strategy, act/chunk payload schema або треба примусово перепакувати весь корпус, використовуйте:

```bash
pnpm exec tsx scripts/legislation/admin-cli.ts reload-corpus-batch --concurrency 2 --batch-size 10 --resume
pnpm exec tsx scripts/legislation/admin-cli.ts reload-corpus-batch --resume --retry-failed
```

- Команда:
  - читає весь `legislation_documents` корпус або явний список `nreg`
  - запускає `importOne(mode=update, force=true)` батчами
  - зберігає resumable report у `runs/audit/LLDBI_CORPUS_RELOAD_REPORT.json`
  - вміє повторно проганяти transient fail-и з того самого report через `--retry-failed`
  - використовує retry-safe embedding path, щоб великі акти не падали через 1-2 transient embedding miss-и всередині батча
  - підходить для контрольованого corpus-wide reindex без ручного циклу по `update --force`
- Практичне правило:
  - `refresh-qdrant-payload-batch` для cheap metadata/payload repair
  - `reload-corpus-batch` для дорогих, але повних reindex кампаній

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
