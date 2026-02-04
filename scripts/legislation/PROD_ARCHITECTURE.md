# Lexery Legislation DB / RAG — Production Architecture

**Призначення:** один документ з архітектурою pipeline, компонентів, failure modes та Definition of Done для прод-деплою.

---

## 1. Що це за система

Імпорт нормативно-правових актів з **rada.gov.ua** → побудова **canonical JSON** → збереження в **Cloudflare R2** (source of truth) → embeddings → **Qdrant** (acts + chunks) → **Supabase** (metadata, jobs, sync_health). Retrieval: Qdrant vector search по чанках; UI/API опираються на Supabase + R2.

---

## 2. Компоненти

### Supabase (Registry / Control Plane)

- **legislation_documents** — метадані документів: `rada_nreg`, `title`, `content_hash`, `r2_key`, `expected_chunks`, `qdrant_status` (`indexed`/`pending`/…), `sync_health` (`green`/`red`/`yellow`), `document_type_slug`, `category`, `validity_status`, тощо.
- **legislation_import_jobs** — історія імпортів: `job_id`, `rada_nreg`, `stage`, `progress`, `created_at`, `updated_at`. Використовується для resume та діагностики.
- **UI views** (якщо є в міграціях): read-only представлення для адмінки/звітів.

### R2 (Source of Truth — canonical)

- **Bucket:** змінна `R2_LEGISLATION_BUCKET` (наприклад `legislation`).
- **Ключі:** `{category_folder}/{rada_nreg}.json` (наприклад `labor/322-08.json`). Категорія визначається taxonomy (див. `prod_lexery_legislation_db_infra/canonical/r2Path.ts`).
- **Формат:** один JSON на документ (canonical structure: meta, stru, content, тощо). Не змінювати ключі/формат без оновлення імпортера та repair-логіки.

### Qdrant (Data Plane — retrieval)

- **Колекції:**
  - **acts** — один вектор на акт (title + summary + keywords); payload містить `rada_nreg`, мета.
  - **chunks** — вектори по тексту чанків; payload містить `rada_nreg`, `chunk_index`, посилання на акт.
- **Поле в payload:** `rada_nreg` обовʼязкове для фільтрації та видалення. Таблиці `legislation_chunks` в БД **немає** — усі чанки тільки в Qdrant.

---

## 3. Pipeline покроково

### add (імпорт одного документу)

1. **Normalize nreg** — введений nreg (наприклад `322-08`) перетворюється на канонічний `rada_nreg` (Rada API може повертати інший формат — перевіряти через `add --dry-run --nreg "322-08"`).
2. **Fetch** — завантаження даних з Rada API.
3. **buildCanonical** — побудова canonical JSON.
4. **R2 write** — `uploadCanonicalJsonToR2` за ключем `{category}/{rada_nreg}.json`.
5. **Embed** — генерація embeddings для acts і chunks.
6. **Qdrant upsert** — спочатку acts, потім chunks (stable IDs).
7. **Supabase upsert** — запис/оновлення рядка в `legislation_documents` (qdrant_status=indexed, expected_chunks, sync_health тощо).
8. **Health** — verify може виставляти `sync_health` при `--write-health`.

### verify (консистентність Supabase ↔ R2 ↔ Qdrant)

- Перевірка наявності документу в Supabase, валідність полів (document_type_slug, category, validity_status, тощо).
- Перевірка наявності canonical в R2 за `r2_key`.
- Перевірка кількості points у Qdrant (acts=1, chunks≥0 за rada_nreg).
- Опція `--write-health`: оновлення `sync_health` на основі результатів (green/red/yellow).

### inspect (діагностика одного документу)

- Виводить метадані з Supabase, наявність у R2, кількість acts/chunks у Qdrant. Корисно для ручного аудиту після add/remove.

### remove (видалення з усієї інфраструктури)

- **Порядок (обовʼязковий):** Qdrant (chunks → acts) → R2 (delete object за r2_key) → Supabase (delete row у legislation_documents).
- **Ідемпотентність:** повторний виклик на вже видаленому документі — успіх без помилок.
- **Не використовує** таблицю legislation_chunks (її немає).

### repair-consistency, backfill-validity, soak-test

- **repair-consistency** — вирівнювання стану між Supabase, R2 і Qdrant (відповідно до контракту: R2 = source of truth, Qdrant = індекс). Запускати після збоїв або ручних змін.
- **backfill-validity** — заповнення/оновлення validity_status для документів (Rada/резолвер). Запускати при оновленні контракту validity або масовому імпорті.
- **soak-test** — batch verify по списку nreg (файл); корисний для регресії після змін.

---

## 4. Як запускати

```bash
# Entrypoint (без змін)
pnpm exec tsx scripts/legislation/admin-cli.ts --help

# Типові команди
pnpm exec tsx scripts/legislation/admin-cli.ts add --nreg "322-08"
pnpm exec tsx scripts/legislation/admin-cli.ts verify --nreg "<rada_nreg>" --write-health
pnpm exec tsx scripts/legislation/admin-cli.ts inspect --nreg "<rada_nreg>"
pnpm exec tsx scripts/legislation/admin-cli.ts remove --nreg "<rada_nreg>" --confirm
pnpm exec tsx scripts/legislation/admin-cli.ts search --query "звільнення за прогул" --topk 5
pnpm exec tsx scripts/legislation/admin-cli.ts status
```

**Важливо:** для verify/remove/inspect використовувати саме **rada_nreg** (як повертає Rada/нормалайзер), а не лише введений номер. Для 322-08 перевірити через `add --dry-run --nreg "322-08"`.

---

## 5. Failure modes + recovery

| Ситуація | Що робити |
|--------|------------|
| **R2 missing** (canonical не знайдено за r2_key) | Переімпорт: `add --nreg "<nreg>"` або `update --nreg "<nreg>" --force`. repair-consistency може позначити невідповідність. |
| **Qdrant partial** (acts або chunks відсутні/неповні) | `verify --nreg "<nreg>"` покаже FAIL. Переіндексувати: `update --nreg "<nreg>" --force`. |
| **Supabase mismatch** (qdrant_status/sync_health не відповідають R2/Qdrant) | `verify --nreg "<nreg>" --write-health` оновить sync_health. repair-consistency для масового вирівнювання. |

Після будь-якого recovery — перезапустити `verify --nreg "<nreg>" --write-health` і переконатися, що PASS.

---

## 6. Definition of Done (прод-інваріанти)

- Документ у Supabase: рядок з коректним `r2_key`, `qdrant_status=indexed`, `sync_health=green` (де застосовно).
- R2: обʼєкт за `r2_key` існує, розмір адекватний.
- Qdrant: acts=1, chunks>0 (для актів з контентом), payload.rada_nreg відповідає.
- Verify: PASS (FAIL=0).
- Remove: ідемпотентний; після remove inspect показує відсутність у Supabase/R2/Qdrant.

---

## 7. Compat stubs

У корені `scripts/legislation` залишені **compat stubs**: файли в `commands/`, `lib/supabaseAdmin.ts`, `config.ts`, `radaClient.ts` які реекспортують реалізацію з `prod_lexery_legislation_db_infra/`. Це потрібно, щоб існуючий entrypoint `admin-cli.ts` не змінював імпорти; весь runtime-код живе в `prod_lexery_legislation_db_infra/`.

---

*Останнє оновлення: 2026-01-29 (prod cleanup + final audit).*
