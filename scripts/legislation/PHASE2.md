# Phase 2 — Стабілізація та завершення

## Статус: ✅ COMPLETE

**Дата завершення:** 2025-12-28  
**Готовність до Phase 3 (DB Design):** ✅ READY

---

## Огляд

Phase 2 забезпечує стабільну, детерміновану роботу з документами rada.gov.ua API.  
Всі компоненти працюють коректно та передбачувано.  
Система готова для проектування БД схеми та bulk імпортера.

---

## A. Document Discovery — Завершено

### Стратегія з пріоритетами

Система використовує трирівневу стратегію discovery з автоматичним fallback:

#### Priority A: ZIP каталог (PRIMARY)
- **URL:** `https://data.rada.gov.ua/open/data/doc`
- **Тип:** ZIP архів з повним каталогом документів
- **Статус:** ✅ Реалізовано
- **Особливості:**
  - Автоматичне завантаження та розпакування
  - Парсинг CSV/TSV/JSON файлів з архіву
  - Кешування ZIP та розпакованих даних
  - Підтримка ETag/Last-Modified для оновлень
- **Обмеження:**
  - Може повертати 403 Forbidden (потрібна реєстрація IP)
  - Якщо недоступний → автоматичний fallback на Priority B

#### Priority B: HTML парсинг (SECONDARY)
- **URL:** `https://data.rada.gov.ua/laws/main/a`
- **Тип:** HTML сторінки з пагінацією
- **Статус:** ✅ Реалізовано
- **Особливості:**
  - Парсинг HTML з витягуванням nreg та назв
  - Автоматична пагінація (`/laws/main/a/page2`, `/laws/main/a/page3`, ...)
  - Завантаження до 50 сторінок (≈50,000 документів)
  - Rate limiting (7 сек між запитами)
- **Обмеження:**
  - Повний каталог (289,079 документів) потребує ~289 сторінок
  - За замовчуванням обмежено до 50 сторінок для швидкості
  - Якщо недоступний → автоматичний fallback на Priority C

#### Priority C: TSV fallback (LAST RESORT)
- **URL:** `https://data.rada.gov.ua/laws/main/r.tsv`
- **Тип:** TSV файл з оновленими документами
- **Статус:** ✅ Реалізовано
- **Особливості:**
  - Швидке завантаження (один файл)
  - Парсинг TSV з витягуванням nreg з URL
  - Кешування локально
- **Обмеження:**
  - Містить тільки **оновлені** документи (не повний каталог)
  - Старі документи (напр. Конституція) можуть бути відсутні

### Кешування

- **Локація:** `tmp/rada_index/`
- **Файли:**
  - `documents.json` — індекс документів (JSON)
  - `metadata.json` — метадані завантаження
  - `documents.tsv` — TSV кеш (якщо використано Priority C)
  - `doc.zip` — ZIP кеш (якщо використано Priority A)
- **TTL:** 24 години
- **Оновлення:** Автоматичне при застарінні або зміні ETag/Last-Modified

### Результат

✅ Пошук "Конституція України" працює через Priority B (HTML парсинг)  
✅ Система автоматично вибирає найкращий доступний джерело  
✅ Fallback працює коректно якщо PRIMARY недоступний

---

## B. NREG Handling — Завершено

### Canonical Helpers

Всі операції з nreg використовують єдині helpers з `utils/nreg.ts`:

#### `encodeNregForUrl(nreg: string)`
- Кодує nreg для URL шляхів
- Розбиває по "/" та кодує кожен сегмент окремо
- **Приклад:** `"254к/96-ВР"` → `"254%D0%BA/96-%D0%92%D0%A0"`

#### `nregToSafeFilename(nreg: string)`
- Формує безпечне ім'я файлу
- Замінює "/" на "-" для безпеки файлової системи
- **Приклад:** `"254к/96-ВР"` → `"254к-96-ВР"`

#### `isValidNreg(nreg: string)`
- Валідує формат nreg
- Pattern: `^[0-9nprvz][0-9\/\_\-a-zа-яїіёєґА-ЯЇІЁЄҐ]{2,}$`

#### `normalizeNreg(nreg: string)`
- Нормалізує nreg (видаляє зайві пробіли)

### Використання

✅ `radaClient.ts` — використовує `encodeNregForUrl` для URL  
✅ `radaClient.ts` — використовує `nregToSafeFilename` для файлів  
✅ Всі модулі використовують однакову логіку  
✅ Немає дублікатів коду

---

## C. Canonical RAW Fetch Result — Завершено

### Структура

Детермінований результат завантаження визначений в `utils/rawFetch.ts`:

```typescript
interface RawFetchResult {
  identifiers: {
    nreg: string;        // ✅ Завжди присутній
    dokid?: number;      // ⚠️ Опціональний
  };
  metadata: {
    title: string;       // ✅ Завжди присутня
    datred: string;     // ✅ Завжди присутня (YYYY-MM-DD)
    sourceUrl: string;   // ✅ Завжди присутній
  };
  raw: {
    json?: any;         // ⚠️ Опціональний (якщо завантажено JSON)
    txt?: string;        // ⚠️ Опціональний (fallback)
  };
  structure: {
    hasStru: boolean;    // ✅ Завжди присутнє
    struCount?: number;  // ⚠️ Якщо hasStru === true
    hasText: boolean;    // ✅ Завжди присутнє
    hasContent: boolean; // ✅ Завжди присутнє
  };
  stats: {
    jsonSize: number;    // ✅ Завжди присутнє
    txtSize?: number;    // ⚠️ Якщо є TXT
    totalSize: number;   // ✅ Завжди присутнє
  };
  fetch: {
    fetchedAt: string;   // ✅ Завжди присутнє (ISO)
    format: 'json' | 'txt' | 'both'; // ✅ Завжди присутнє
    usedToken: boolean;  // ✅ Завжди присутнє
  };
}
```

### Що завжди присутнє

✅ `identifiers.nreg` — primary identifier  
✅ `metadata.title` — назва документа  
✅ `metadata.datred` — дата редакції  
✅ `metadata.sourceUrl` — URL джерела  
✅ `structure.hasStru` — наявність структури  
✅ `structure.hasText` — наявність тексту  
✅ `structure.hasContent` — наявність контенту  
✅ `stats.jsonSize` — розмір JSON  
✅ `stats.totalSize` — загальний розмір  
✅ `fetch.fetchedAt` — timestamp завантаження  
✅ `fetch.format` — формат даних  
✅ `fetch.usedToken` — використання токену

### Що опціональне

⚠️ `identifiers.dokid` — може бути відсутнім  
⚠️ `raw.json` — може бути відсутнім якщо завантажено тільки TXT  
⚠️ `raw.txt` — може бути відсутнім якщо JSON містить контент  
⚠️ `structure.struCount` — тільки якщо `hasStru === true`  
⚠️ `stats.txtSize` — тільки якщо є TXT

### Збереження

RAW результат зберігається в:
- `tmp/rada_raw/{nreg}.raw.json` — детермінований результат
- `tmp/rada_raw/{nreg}.json` — сирий JSON з API
- `tmp/rada_raw/{nreg}.txt` — TXT fallback (якщо є)

---

## D. Структура скриптів — Завершено

### Організація

```
scripts/legislation/
├── README.md              # Загальна документація
├── PHASE2.md              # Цей документ
├── config.ts              # Конфігурація
├── radaClient.ts          # API клієнт (ТІЛЬКИ API)
├── docIndex.ts            # Discovery & search (ТІЛЬКИ індекс)
├── pilot_fetch.ts         # CLI тестування
├── find_nreg.ts           # CLI пошуку
└── utils/
    ├── nreg.ts            # Canonical nreg helpers
    └── rawFetch.ts       # RAW fetch результат
```

### Розділення відповідальності

✅ `radaClient.ts` — ТІЛЬКИ API комунікація  
✅ `docIndex.ts` — ТІЛЬКИ discovery & search  
✅ `utils/nreg.ts` — ТІЛЬКИ nreg helpers  
✅ `utils/rawFetch.ts` — ТІЛЬКИ RAW результат  
✅ Немає DB логіки  
✅ Немає RAG логіки  
✅ Немає embeddings логіки

---

## E. Документація — Завершено

### Створені документи

✅ `PHASE2.md` — цей документ (повний опис Phase 2)  
✅ `README.md` — оновлено з описом скриптів  
✅ `utils/nreg.ts` — JSDoc для всіх функцій  
✅ `utils/rawFetch.ts` — JSDoc з описом структури

### Документовано

✅ Стратегія discovery з пріоритетами  
✅ Як знаходиться Конституція  
✅ Чому ZIP індекс є пріоритетним  
✅ Що завжди присутнє в RAW результаті  
✅ Що опціональне  
✅ Структура скриптів

---

## Перевірка готовності

### Тести

✅ Завантаження Конституції: `pnpm tsx scripts/legislation/pilot_fetch.ts --nreg="254к/96-ВР"`  
✅ Пошук документів: `pnpm tsx scripts/legislation/find_nreg.ts --query="Конституція"`  
✅ NREG кодування працює коректно  
✅ RAW результат детермінований  
✅ Discovery працює з fallback

### Відомі обмеження

⚠️ ZIP може бути недоступний (403) — потрібна реєстрація IP  
⚠️ HTML парсинг обмежений до 50 сторінок (для швидкості)  
⚠️ TSV fallback містить тільки оновлені документи

Ці обмеження не заважають проектуванню БД та імпортера.

---

## Висновок

**Phase 2 завершено ✅**

Система:
- ✅ Працює коректно та передбачувано
- ✅ Має чітку структуру
- ✅ Добре документована
- ✅ Готова для Phase 3 (DB Design)

**Готовність до Phase 3:** ✅ **READY**

---

**Наступні кроки:**
1. Проектування DB схеми в supabase-legislation-rag
2. Створення canonical JSON builder
3. Розробка bulk імпортера
4. Інтеграція з R2 storage

