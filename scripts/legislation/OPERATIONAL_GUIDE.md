# Operational Guide — Legislation RAG

**Останнє оновлення:** 2026-01-21

---

## Основні команди

### Імпорт документів

```bash
# Імпорт одного документа
pnpm tsx scripts/legislation/admin-cli.ts add --nreg "2341-14"

# Оновлення документа (якщо змінився content_hash)
pnpm tsx scripts/legislation/admin-cli.ts update --nreg "2341-14"

# Примусове переіндексування
pnpm tsx scripts/legislation/admin-cli.ts update --nreg "2341-14" --force

# Імпорт з resume (якщо є незавершений job)
pnpm tsx scripts/legislation/admin-cli.ts add --nreg "2341-14" --resume
```

### Управління Jobs

```bash
# Список всіх jobs
pnpm tsx scripts/legislation/admin-cli.ts jobs list

# Список failed jobs
pnpm tsx scripts/legislation/admin-cli.ts jobs list --failed

# Список running jobs
pnpm tsx scripts/legislation/admin-cli.ts jobs list --running

# Детальна інформація про job
pnpm tsx scripts/legislation/admin-cli.ts jobs inspect --job-id <uuid>

# Продовжити job
pnpm tsx scripts/legislation/admin-cli.ts jobs resume --job-id <uuid>
```

### Діагностика

```bash
# Детальна інформація про документ
pnpm tsx scripts/legislation/admin-cli.ts inspect --nreg "2341-14"

# Пошук (retrieval test)
pnpm tsx scripts/legislation/admin-cli.ts search --query "кримінальна відповідальність" --topk 5
```

### Тестування

```bash
# End-to-end test для ККУ
pnpm tsx scripts/legislation/admin-cli.ts test-kku

# Corpus batch test
pnpm tsx scripts/legislation/admin-cli.ts test-corpus \
  --file scripts/legislation/test/corpus_nregs.txt \
  --concurrency 2 \
  --report
```

---

## Parsing Strategies

Система автоматично вибирає стратегію парсингу на основі структури документа:

1. **article-based** — для законів/кодексів зі статтями (typ='ST')
2. **point-based** — для постанов/наказів з пунктами (typ='PU')
3. **chapter-based** — для документів з великою структурою (глави/розділи)
4. **annex-based** — для документів з додатками/формами/таблицями
5. **fallback** — TXT parsing якщо stru не дає units

**No-empty-index policy:** Важливі документи (постанови, накази) завжди мають chunks > 0 через обов'язковий TXT fallback.

---

## Taxonomy V1

Категорії визначаються AI (Claude 3.7 Sonnet) з валідацією:

- `constitutional` — Конституція
- `criminal` — Кримінальне право
- `defense_mobilization` — Оборона/мобілізація
- `border_migration` — Кордон/міграція
- `other` — Інше (використовується рідко)

**Правило:** "Other" дозволено тільки для кадрових/технічних документів. Для важливих актів (закони, кодекси, постанови) AI має визначити конкретну категорію.

---

## Jobs & Resume

### Job Stages

1. `fetched` — дані завантажено з Rada API
2. `canonical_built` — canonical JSON побудовано
3. `r2_uploaded` — canonical завантажено в R2
4. `ai_enrichment_done` — AI enrichment завершено
5. `embeddings_started/progress/done` — embeddings генеруються
6. `qdrant_upsert_started/progress/done` — chunks upsert в Qdrant
7. `supabase_updated` — registry оновлено
8. `done` — імпорт завершено

### Resume Workflow

Якщо імпорт перервався (timeout, помилка):

1. Знайти running job:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts jobs list --running
   ```

2. Перевірити прогрес:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts jobs inspect --job-id <uuid>
   ```

3. Продовжити:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts add --nreg "2341-14" --resume
   ```

**Важливо:** Resume автоматично пропускає вже виконані етапи (R2 upload, AI enrichment) і продовжує з embeddings/qdrant.

---

## Act Group (багаточастинні акти)

Система автоматично визначає групи для багаточастинних актів:

- **act_group_key** — детермінований ключ групи
- **act_is_part** — чи є документ частиною групи
- **act_part_label** — label частини ("Частина перша", "Том ІІ")

**Приклад:** КУпАП може складатися з кількох документів, але вони матимуть однаковий `act_group_key` для агрегації в RAG.

---

## R2 Storage Policy

**Canonical keys:** `legislation/{storage_category}/{encoded_nreg}.json`

**AI Cache (безпечний prefix):**
- `legislation/_lexery/ai_cache/parse_plan/{content_hash}.json` — AI parse plans

**⚠️ НЕ ЧІПАТИ:**
- `legislation/ActCatalogResolver/cache/...` (кеш мікросервісу)
- `legislation/DocListDB rada gov updater log/...` (логи мікросервісу)
- Supreme Court bucket (окремий bucket)

**Важливо:**
- storage_category стабільний (не змінюється при перекласифікації)
- category (semantic) може змінюватися, але canonical НЕ переноситься між папками

---

## Category & Storage Category

**Важливо:** У Supabase є два різні поля:

- **`category`** — semantic taxonomy slug EN (для пошуку/фільтрації)
  - Приклади: `border_migration`, `criminal`, `defense_mobilization`
  - Завжди taxonomy slug (не UA, не "інше")
  - Може змінюватися при перекласифікації

- **`storage_category`** — R2 folder name (стабільний)
  - Приклади: `migration`, `criminal`, `defense`
  - Не змінюється при перекласифікації (backward compatibility)
  - Парситься з r2_key для існуючих документів

**Repair categories:**
```bash
# Нормалізувати одну категорію
pnpm tsx scripts/legislation/admin-cli.ts repair categories --nreg "57-95-п" --force-ai

# Всі документи
pnpm tsx scripts/legislation/admin-cli.ts repair categories --all
```

## Act Group

**Семантика:**
- **Одиночні акти:** `act_group_key = NULL`, `act_is_part = false`
- **Multi-part акти:** `act_group_key = stable hash`, `act_is_part = true`, `act_part_label = "статті 1-212"`

**Приклад:** КУпАП складається з двох документів:
- 80731-10 (статті 1-212-24) → `act_group_key="куп-...hash..."`, `act_part_label="статті 1 - 212-24"`
- 80732-10 (статті 213-330) → `act_group_key="куп-...hash..."`, `act_part_label="статті 213 - 330"`

**Repair act groups:**
```bash
pnpm tsx scripts/legislation/admin-cli.ts repair act-groups --all
```

## Verify & Repair

**Verify консистентність:**
```bash
pnpm tsx scripts/legislation/admin-cli.ts verify --nreg "2341-14"
```

**Repair невідповідності:**
```bash
pnpm tsx scripts/legislation/admin-cli.ts repair consistency --nreg "2341-14"
```

## Troubleshooting

### Документ не індексується

1. Перевірити статус:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts inspect --nreg "2341-14"
   ```

2. Перевірити помилки:
   - `last_sync_error` в Supabase
   - `error_message` в jobs

3. Спробувати resume:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts add --nreg "2341-14" --resume
   ```

### Chunks = 0 для важливого документа

1. Перевірити parsing strategy:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts inspect --nreg "57-95-п"
   ```

2. Якщо strategy=fallback і chunks=0 → перевірити TXT content

3. No-empty-index policy має спрацювати автоматично для постанов/наказів

### Category = "other" або UA значення

1. Перевірити чи category валідна:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts verify --nreg "..."
   ```

2. Виправити через repair:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts repair categories --nreg "..." --force-ai
   ```

3. Якщо все ще "other" для важливого документа — перевірити AI enrichment:
   - `summary`, `keywords`, `topics` в Supabase
   - Можливо AI не отримав достатньо контексту

4. Переіндексувати з --force:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts update --nreg "..." --force
   ```

### Act Group не працює для multi-part актів

1. Перевірити чи detectPartLabel спрацював:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts inspect --nreg "80731-10"
   ```

2. Виправити через repair:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts repair act-groups --nreg "80731-10"
   ```

3. Тестувати КУпАП:
   ```bash
   pnpm tsx scripts/legislation/admin-cli.ts test-kupap
   ```

---

## Файли та звіти

- **Runs:** `scripts/legislation/runs/`
- **Corpus reports:** `scripts/legislation/runs/corpus_report_*.md`
- **KKU test reports:** `scripts/legislation/runs/kku_2341_14_run_*.json`
