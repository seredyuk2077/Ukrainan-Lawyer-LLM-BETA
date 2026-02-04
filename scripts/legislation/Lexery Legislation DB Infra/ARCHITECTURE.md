# Lexery Legislation DB Infra — Архітектура

Детальний опис компонентів, схеми даних та потоку для pipeline add/verify/remove.

---

## 1. Загальна схема

```
┌─────────────────┐     fetch      ┌──────────────┐     build      ┌─────────────────┐
│  rada.gov.ua    │ ──────────────►│  Raw JSON/TXT│ ──────────────►│ Canonical JSON  │
│  (Rada API)     │                │  (temp→R2)   │                │ (in memory)     │
└─────────────────┘                └──────────────┘                └────────┬────────┘
                                                                              │
        ┌─────────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────┐
        │                                                                     ▼                                                  │
        │  ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
        │  │ R2 (Cloudflare) — Source of Truth                                                                               │  │
        │  │ Bucket: R2_LEGISLATION_BUCKET (default "legislation")                                                           │  │
        │  │ Key format: legislation/{category_folder}/{rada_nreg}.json   e.g. legislation/labor/322-08.json                │  │
        │  │ Category folders: constitutional, criminal, civil, labor, administrative, tax, commercial, land, other, ...   │  │
        │  └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
        │                                                                     │                                                  │
        │  ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
        │  │ Qdrant — Vector DB (Data Plane)                                                                                 │  │
        │  │ Collections:                                                                                                    │  │
        │  │   • lexery_legislation_acts   — один вектор на акт (title + summary + keywords); payload: rada_nreg, category   │  │
        │  │   • lexery_legislation_chunks — вектори по тексту чанків; payload: rada_nreg, chunk_index, article_number, ...  │  │
        │  │ Payload обов'язково містить rada_nreg для фільтрації та видалення. Таблиці legislation_chunks в БД немає.      │  │
        │  └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
        │                                                                     │                                                  │
        │  ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
        │  │ Supabase — Registry / Control Plane                                                                             │  │
        │  │ Tables: legislation_documents, legislation_import_jobs, legislation_import_proposals                             │  │
        │  └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
        └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Сервіси та бакети

### R2 (Cloudflare)

| Параметр | Значення |
|----------|----------|
| **Bucket** | `process.env.R2_LEGISLATION_BUCKET` або `"legislation"` |
| **Формат ключа** | `legislation/{category_folder}/{rada_nreg}.json` |
| **Приклади ключів** | `legislation/labor/322-08.json`, `legislation/criminal/2341-14.json`, `legislation/other/2947-iii.json` |
| **Категорії (папки)** | constitutional, criminal, civil, labor, administrative, tax, commercial, land, defense, migration, other, … (див. `src/canonical/r2Path.ts` CATEGORY_TO_R2_FOLDER) |
| **Вміст файлу** | Один JSON: canonical document (metadata + content.chunks + content.structure, validity, document_type_slug, тощо) |
| **Run artifacts** | Префікс `legislation/tech/runs/` — артефакти кожного add/update/remove (report.json, logs.txt, rada_raw.json, canonical.preview.json, enrichment.json). Пишуться в тимчасову локальну директорію, потім завантажуються в R2 і тимчасова директорія видаляється; локально папка `scripts/legislation/runs` не створюється. |

Інші префікси в тому ж бакеті (наприклад `ActCatalogResolver/`, `DocListDB rada gov updater log/`) належать іншим сервісам (DocListDB), не цьому pipeline.

### Qdrant

| Параметр | Значення |
|----------|----------|
| **Endpoint** | `process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB` |
| **API Key** | `process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB` |
| **Колекція acts** | `lexery_legislation_acts` — по одному point на документ (embedding з title + summary + keywords) |
| **Колекція chunks** | `lexery_legislation_chunks` — по одному point на chunk тексту |
| **Payload (обов'язково)** | `rada_nreg` (string) — для filter/delete по документу; також category, chunk_index, article_number де потрібно |
| **ID points** | Стабільні (uuid або складний id з rada_nreg + chunk_index), щоб upsert був ідемпотентним |

### Supabase

| Таблиця | Призначення |
|---------|-------------|
| **legislation_documents** | Реєстр документів: rada_nreg (PK), title, content_hash, r2_key, expected_chunks, qdrant_status (pending/indexed/error), sync_health (green/yellow/red/unknown), document_type_slug, category, validity_status, status_note, act_group_key, … RLS увімкнено. |
| **legislation_import_jobs** | Історія імпортів: id (UUID), status (pending/running/completed/failed), total_count, processed_count, success_count, error_count, started_at, completed_at, config (jsonb), progress_data (jsonb). Для resume та діагностики. |
| **legislation_import_proposals** | Пропозиції на імпорт: id, rada_nreg, proposed_by, decision (pending/approved/rejected), decision_reason, evidence (jsonb). |

Ключові поля **legislation_documents** (для pipeline):

- **r2_key** — шлях у R2, напр. `legislation/labor/322-08.json`
- **qdrant_status** — `indexed` після успішного upsert у Qdrant
- **sync_health** — оновлюється verify (green/red/yellow)
- **expected_chunks** — з canonical; **indexed_chunks** — фактична кількість у Qdrant
- **validity_status** — in_force / expired / not_in_force / suspended / unknown

---

## 3. Пайплайн (коротко)

- **add:** Rada fetch → buildCanonical → R2 put (legislation/{category}/{nreg}.json) → AI enrichment → embeddings → Qdrant upsert (chunks, потім acts) → Supabase upsert (legislation_documents + job progress).
- **verify:** Читання з Supabase, R2 (head/get), Qdrant (count by rada_nreg); порівняння expected_chunks vs Qdrant; опційно `--write-health` оновлює sync_health.
- **remove:** Qdrant delete by rada_nreg (chunks → acts) → R2 delete object → Supabase delete row. Ідемпотентний.
- **inspect:** Виводить метадані з Supabase + наявність у R2 + кількість points у Qdrant по rada_nreg.

Детальний покроковий опис — у **PIPELINE.md**.

---

## 4. Recovery

| Ситуація | Дія |
|----------|-----|
| R2 object відсутній | add або update --force (перезаписати canonical) |
| Qdrant partial (немає частини chunks/acts) | update --force (переіндексувати) |
| Supabase qdrant_status/sync_health не відповідають стану | verify --nreg … --write-health; при потребі repair-consistency |
| Помилка під час add | jobs list → jobs resume --job-id … (якщо підтримано) або повторний add |
