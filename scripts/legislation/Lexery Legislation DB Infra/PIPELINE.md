# Lexery Legislation DB Infra — Pipeline (покроково)

Як виконується add, verify, remove, inspect: які функції викликаються і в якому порядку.

---

## 1. ADD (імпорт одного документу)

**Entry:** `admin-cli.ts` → `addDocument()` → `importOne()` з `src/lib/importer.ts`.

| Крок | Що відбувається | Функції / модулі |
|------|------------------|------------------|
| 1 | Нормалізація nreg | Вхідний nreg передається як є; Rada API може повертати інший формат — перевіряти `add --dry-run --nreg "..."` |
| 2 | Fetch з Rada | `RadaClient.fetchJson(radaNreg)`, `RadaClient.fetchTxt(radaNreg)` — збереження в run dir (rada_raw.json, rada_raw.txt) |
| 3 | Побудова canonical | `buildCanonical()` з `src/canonical/buildCanonical.ts` — парсинг stru/txt, chunking, content_hash, metadata (document_type_slug, category, validity тощо) |
| 4 | R2 key | `generateR2Key(category, rada_nreg)` з `src/canonical/r2Path.ts` → `legislation/{folder}/{nreg}.json` |
| 5 | Запис у R2 | `uploadCanonicalJsonToR2(r2, bucket, r2Key, canonicalJson)` — bucket з `getLegislationBucket()` (env R2_LEGISLATION_BUCKET) |
| 6 | AI enrichment | `generateEnrichment()` з `src/lib/aiEnrichment.ts` — summary, keywords, category (OpenRouter); кеш по content_hash у legislation_documents |
| 7 | Embeddings | `generateEmbedding()` / `generateEmbeddingsBatch()` з `src/canonical/embeddings.ts` — для acts (1 вектор) і для кожного chunk |
| 8 | Qdrant upsert | `QdrantRagClient` з `src/lib/qdrantRagClient.ts` — спочатку upsert acts, потім chunks; колекції `lexery_legislation_acts`, `lexery_legislation_chunks` |
| 9 | Supabase upsert | INSERT/UPDATE `legislation_documents` (r2_key, qdrant_status=indexed, expected_chunks, indexed_chunks, sync_health, validity_status, document_type_slug, category, тощо) |
| 10 | Job progress | `updateJobProgress()` → `progress_data` в `legislation_import_jobs` (stage: fetched → canonical_built → r2_uploaded → … → supabase_updated) |

**Dry-run:** після кроку 3 вихід без запису в R2/Qdrant/Supabase.

**Resume:** якщо `--resume` і є running job для цього nreg — продовження зі збереженого stage (job progress у Supabase).

---

## 2. VERIFY (консистентність)

**Entry:** `admin-cli.ts` → `verifyDocument()` з `src/commands/verify.ts`.

| Крок | Що перевіряється | Джерело |
|------|-------------------|--------|
| 1 | Документ існує | Supabase `legislation_documents` по rada_nreg |
| 2 | Поля NOT NULL | document_type_slug, category, document_number, storage_category, validity_status, status_note, source_status_* |
| 3 | Act group sanity | act_group_key / act_is_part узгодженість |
| 4 | Chunks count | expected_chunks vs indexed_chunks (Supabase) |
| 5 | R2 canonical | headObject(r2, bucket, r2_key) — наявність, розмір; getJsonFromR2 для перевірки кількості chunks у JSON |
| 6 | Qdrant | countByNreg(qdrant, lexery_legislation_chunks, nreg), countByNreg(qdrant, lexery_legislation_acts, nreg) — acts=1, chunks=expected |
| 7 | Payload category | scroll chunks — перевірка payload.category |
| 8 | write-health | Якщо `--write-health` — оновлення sync_health (green/red/yellow) у legislation_documents |

Результат: PASS/FAIL по кожній перевірці; при --write-health оновлюється поле sync_health.

---

## 3. REMOVE (видалення документу)

**Entry:** `admin-cli.ts` → `removeDocument()` з `src/commands/remove.ts`.

| Крок | Дія | Функції |
|------|-----|--------|
| 1 | Preflight | SELECT документ з Supabase; countByNreg для chunks і acts у Qdrant; headObject для R2 |
| 2 | Delete Qdrant chunks | `deleteByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg)` |
| 3 | Delete Qdrant acts | `deleteByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg)` |
| 4 | Delete R2 object | deleteObject(r2, bucket, r2_key) |
| 5 | Delete Supabase row | DELETE FROM legislation_documents WHERE rada_nreg = … |

Порядок обов'язковий: Qdrant (chunks → acts) → R2 → Supabase. Якщо документ вже відсутній у Supabase — виконується лише best-effort delete у Qdrant і вихід без помилки (ідемпотентність).

---

## 4. INSPECT (діагностика)

**Entry:** `admin-cli.ts` → `inspectDocument()` з `src/commands/inspect.ts`.

Читає з Supabase (legislation_documents по rada_nreg), R2 (head по r2_key), Qdrant (countByNreg для acts і chunks). Виводить: document_found, title, content_hash, r2_key, qdrant_status, expected_chunks, indexed_chunks, R2 exists/size/lastModified, qdrant counts, discrepancies.

---

## 5. Інші команди (коротко)

- **update** — той самий `importOne()` з mode `update`; skip якщо content_hash не змінився (окрім --force).
- **repair-consistency** — вирівнювання payload/category у Qdrant та стану в Supabase по даним з R2/canonical.
- **backfill-validity** — заповнення validity_status по Rada/резолверу для документів з NULL або unknown.
- **soak-test** — batch verify по списку nreg з файлу (наприклад scripts/legislation/test/soak_nregs.txt).
- **search** — vector search по колекції lexery_legislation_chunks, вивід snippet з R2.

Вихідні шляхи для звітів/аудиту (за замовчуванням): `scripts/legislation/runs/` (audit/, diverse/, corpus_report_*.md, тощо). Опційно можна змінювати через аргументи команд.
