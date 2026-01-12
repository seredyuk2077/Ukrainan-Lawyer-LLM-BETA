# Legislation RAG — Скрипти імпорту

Ця папка містить скрипти для імпорту та обробки нормативно-правових актів з rada.gov.ua.

## 📋 Статус: Phase 2 Complete ✅

**Дата:** 2025-12-28  
**Готовність до Phase 3 (DB Design):** ✅ READY

Детальний опис Phase 2: [docs/legislation-rag/PHASE2.md](../../docs/legislation-rag/PHASE2.md)

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

2. Налаштувати змінні оточення (якщо потрібно):
   - Створити `.env` файл в корені проєкту
   - Додати необхідні змінні (за потреби)

### Команди

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
- `docs/legislation-rag/` — повна документація системи
- `docs/RADA_API_DOCUMENTATION.md` — документація API rada.gov.ua

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

