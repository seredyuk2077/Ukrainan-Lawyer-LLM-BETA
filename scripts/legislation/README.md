# Legislation RAG — Скрипти імпорту

Ця папка містить скрипти для імпорту та обробки нормативно-правових актів з rada.gov.ua.

## 📋 Статус: Production-Ready ✅

**Дата:** 2026-01-21  
**Архітектура:** Supabase (registry) + R2 (canonical) + Qdrant (retrieval)

**Завершені Phases:**
- ✅ PHASE 1: Diagnostics + Risk Register
- ✅ PHASE 2: Parsing Hardening (розширені стратегії, no-empty-index)
- ✅ PHASE 3: Controlled AI (Taxonomy V1, caching, deduplication)
- ✅ PHASE 4: Timeout/Resume/Progress (job tracking, progressive commits)
- ✅ PHASE 5: Act Group (багаточастинні акти)
- ✅ PHASE 6: Real World Test (ККУ 2341-14) — 943 chunks, indexed ✅
- ✅ PHASE 7: Corpus Tests + Batch Report Generator

Детальна архітектура: [docs/legislation-rag/ARCHITECTURE_AS_IS_TO_BE.md](../../docs/legislation-rag/ARCHITECTURE_AS_IS_TO_BE.md)  
Operational Guide: [OPERATIONAL_GUIDE.md](./OPERATIONAL_GUIDE.md)

## 📁 Структура

```
scripts/legislation/
├── README.md              # Цей файл
├── PHASE2.md              # Документація Phase 2
├── config.ts              # Конфігурація та завантаження env
├── radaClient.ts          # Клієнт для роботи з rada.gov.ua API (ТІЛЬКИ API)
├── openDataPortalClient.ts # Клієнт для Open Data Portal (datasets, passports)
├── radaDocIndex.ts        # Швидкий lookup індекс документів (Open Data Portal)
├── docIndex.ts            # Legacy discovery (deprecated, використовується radaDocIndex)
├── pilot_fetch.ts         # CLI для тестування завантаження одного документа
├── find_nreg.ts           # CLI для пошуку nreg за назвою (legacy)
├── cli_lookup.ts          # CLI для швидкого lookup документів (РЕКОМЕНДОВАНО)
└── utils/
    ├── nreg.ts            # Canonical nreg helpers
    └── rawFetch.ts        # Детермінований RAW fetch результат
```

## 🚀 Як запускати скрипти

### Передумови

1. Встановити залежності:
   ```bash
   pnpm install
   ```

2. Налаштувати змінні оточення (`.env` в корені проєкту):
   - `SUPABASE_LEGISLATION_URL`
   - `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY`
   - `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   - `R2_LEGISLATION_BUCKET` (або default: "legislation")
   - `qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB`
   - `qdrant_clusterAPI_LEXERY_LEGISLATION_DB`
   - `OPEN_ROUTER_API_RAG`

### Admin CLI (Legislation RAG)

**Основні команди:**

```bash
# Імпорт
pnpm tsx scripts/legislation/admin-cli.ts add --nreg "2341-14"
pnpm tsx scripts/legislation/admin-cli.ts update --nreg "2341-14" --force

# Jobs & Resume
pnpm tsx scripts/legislation/admin-cli.ts jobs list
pnpm tsx scripts/legislation/admin-cli.ts jobs resume --job-id <uuid>

# Діагностика
pnpm tsx scripts/legislation/admin-cli.ts inspect --nreg "2341-14"
pnpm tsx scripts/legislation/admin-cli.ts search --query "кримінальна відповідальність"

# Тестування
pnpm tsx scripts/legislation/admin-cli.ts test-kku
pnpm tsx scripts/legislation/admin-cli.ts test-corpus --file test/corpus_nregs.txt --report
```

**Детальніше:** [OPERATIONAL_GUIDE.md](./OPERATIONAL_GUIDE.md)

### Legacy CLI (deprecated)

```bash
# Перевірка готовності інфраструктури
pnpm tsx scripts/legislation/admin-cli.ts status

# Імпорт одного документа
pnpm tsx scripts/legislation/admin-cli.ts add --nreg "254к/96-вр"

# Batch імпорт
echo -e "254к/96-вр\n123/45" > nregs.txt
pnpm tsx scripts/legislation/admin-cli.ts add-batch --file nregs.txt --concurrency 2

# Оновлення документа (тільки якщо змінився content_hash)
pnpm tsx scripts/legislation/admin-cli.ts update --nreg "254к/96-вр"

# Видалення документа (з архівуванням canonical)
pnpm tsx scripts/legislation/admin-cli.ts remove --nreg "254к/96-вр" --confirm

# Детальна інформація про документ
pnpm tsx scripts/legislation/admin-cli.ts inspect --nreg "254к/96-вр"

# Retrieval sanity test
pnpm tsx scripts/legislation/admin-cli.ts search --query "право власності" --topk 5

# Повне очищення (з подвійним підтвердженням)
pnpm tsx scripts/legislation/admin-cli.ts purge-all --i-know-what-im-doing
```

**Runs directory:** Кожна операція створює папку `scripts/legislation/runs/...` з report, enrichment, logs.

### Legacy команди

#### Швидкий lookup документів (РЕКОМЕНДОВАНО)

```bash
# Пошук за назвою
pnpm tsx scripts/legislation/cli_lookup.ts --query="Конституція України" --limit=5

# Пошук за nreg
pnpm tsx scripts/legislation/cli_lookup.ts --nreg="254к/96-вр"

# Примусове оновлення індексу
pnpm tsx scripts/legislation/cli_lookup.ts --query="Конституція" --refresh
```

**Що робить:**
- Використовує Open Data Portal каталог (`zak` → `docs` → `doc.txt`)
- Завантажує та кешує індекс документів (289k+ записів)
- Швидкий lookup за назвою або nreg (1-8 секунд)
- Автоматичне оновлення кешу (TTL 6 годин)

**Приклади:**
```bash
# Конституція України
pnpm tsx scripts/legislation/cli_lookup.ts --query="Конституція України"

# Кримінальний кодекс
pnpm tsx scripts/legislation/cli_lookup.ts --query="Кримінальний кодекс України"

# Податковий кодекс
pnpm tsx scripts/legislation/cli_lookup.ts --query="Податковий кодекс України"
```

#### Тестовий завантаження документа (pilot)

```bash
# Завантажити документ за nreg
pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=<nreg>

# Приклад (використовуйте nreg з cli_lookup):
pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=254к/96-вр
```

**Що робить:**
- Завантажує JSON з rada.gov.ua API
- Якщо JSON не містить контенту, завантажує TXT fallback
- Зберігає raw відповідь в `tmp/rada_raw/<nreg>.json`
- Виводить короткий звіт про документ

#### Парсинг в canonical формат (майбутнє)

```bash
pnpm tsx scripts/legislation/parser.ts --nreg=<nreg>
```

## 📂 Структура вихідних файлів

```
tmp/
├── rada_raw/              # Сирі відповіді з API
│   └── <nreg>.json
└── canonical/             # Canonical JSON формат
    └── <nreg>.canonical.json
```

## 🔧 Конфігурація

Всі налаштування знаходяться в `config.ts`:
- Базові URL API
- Ліміти та затримки
- Налаштування логування

## 📚 Документація

Повна архітектурна документація знаходиться в:
- `docs/legislation-rag/ARCHITECTURE_AS_IS_TO_BE.md` — архітектура міграції
- `docs/legislation-rag/R2_POLICY.md` — політика R2 (prefix, guardrails)
- `docs/legislation-rag/` — повна документація системи
- `docs/RADA_API_DOCUMENTATION.md` — документація API rada.gov.ua

## 🏗️ Архітектура

- **Supabase:** Registry/Control Plane (метадані, статуси, версії, jobs)
- **R2:** Source of Truth (canonical JSON)
- **Qdrant:** Data Plane (embeddings + retrieval)

Детальніше: [ARCHITECTURE_AS_IS_TO_BE.md](../../docs/legislation-rag/ARCHITECTURE_AS_IS_TO_BE.md)

## ⚠️ Важливо

1. **Rate limiting:** API має ліміт 60 запитів/хвилину. Скрипти автоматично дотримуються паузи.
2. **Токени:** Токен діє 24 години. Не запитуйте токен перед кожним запитом.
3. **tmp/ папка:** Всі тимчасові файли зберігаються в `tmp/`, яка ігнорується git.

## 🐛 Troubleshooting

### Помилка "Token expired"
- Токен автоматично оновлюється. Якщо помилка повторюється, перевірте доступ до API.

### Помилка 429 (Too Many Requests)
- Зменште частоту запитів або збільште паузу між запитами.

### Помилка 404 (Document not found)
- Перевірте правильність `nreg`.
- Деякі документи можуть бути недоступні через API.

