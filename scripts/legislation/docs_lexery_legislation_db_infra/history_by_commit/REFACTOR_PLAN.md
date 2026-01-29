# План Великого Рефакторингу Імпортера

**Дата:** 2026-01-25  
**Статус:** 🟡 ПЛАНУВАННЯ

---

## Мета

Зробити імпортер стабільним, детермінованим, і правильним для будь-яких документів з rada.gov.ua:
1. Правильна ідентифікація (nreg, canonical URL, редакції)
2. Правильне визначення типу документа
3. Витяг і відображення чинності (validity)
4. Стабільна нумерація статей/частин/пунктів (без зсувів)
5. Правильна структура (без редакційних приміток як структурних вузлів)

---

## Поточні Проблеми (з аналізу коду)

### ✅ Добре (не потребує змін):
- Номер статті береться з `item.stru || item.number`, а не з індексу масиву
- Парсинг структури з `stru` масиву працює правильно

### ⚠️ Потенційні проблеми:
1. **Fallback нумерація** (`parseUnitsAdvanced.ts:54`): `number: struNumber || String(units.length + 1)` — може дати зсув
2. **Відсутність validity extractor** — чинність не витягується і не зберігається
3. **Немає полів validity в БД** — потрібно додати `validity_status`, `valid_from`, `valid_to`, `status_note`
4. **Canonical resolver** — не перевіряє redirects, не "прибиває" редакцію
5. **Metadata extractor** — doc_type визначається з заголовка як primary (має бути з метаданих)

---

## План Рефакторингу

### КРОК 1: Структура для Аудиту ✅
- [x] Створити шаблон audit record
- [x] Створити команду `audit-documents`
- [ ] Провести ручний аудит 190 документів (по 10-20 за раз)

### КРОК 2: Класифікація Багів
- [ ] Зібрати всі типи багів з аудиту
- [ ] Розподілити по класах (A/B/C/D/E)
- [ ] Визначити root cause для кожного класу

### КРОК 3: Рефакторинг Імпортера

#### 3.1 Fetcher (нова функція)
**Файл:** `scripts/legislation/lib/fetcher.ts` (новий)

```typescript
interface FetchResult {
  request_url: string;
  response_status: number;
  final_url_after_redirect: string;
  timestamp: string;
  json_data: any;
  txt_data: string | null;
  content_hash: string;
}
```

**Функціональність:**
- Тягне raw HTML/JSON з rada.gov.ua
- Логує request_url, response_status, final_url_after_redirect
- Зберігає raw snapshot або content_hash для відтворення
- Обробляє redirects і фіксує final URL

#### 3.2 Canonical Resolver (нова функція)
**Файл:** `scripts/legislation/lib/canonicalResolver.ts` (новий)

```typescript
interface CanonicalResult {
  nreg_canonical: string;
  doc_id_source: string;
  edition_date: string | null;
  canonical_url: string;
}
```

**Функціональність:**
- Визначає canonical identifier + canonical URL
- "Прибиває" редакцію: latest редакція vs історична
- Перевіряє redirects і визначає правильний canonical URL

#### 3.3 Metadata Extractor (рефакторинг)
**Файл:** `scripts/legislation/canonical/buildCanonical.ts`

**Зміни:**
- doc_type НЕ з заголовка як primary, а з метаданих сторінки/картки
- Заголовок — fallback
- Додати confidence + explanation trace ("why this type")
- Використовувати `jsonData.typ`, `jsonData.organs` як primary source

#### 3.4 Validity Extractor (НОВИЙ модуль) ⭐
**Файл:** `scripts/legislation/canonical/extractValidity.ts` (новий)

```typescript
interface ValidityResult {
  status: 'ACTIVE' | 'REPEALED' | 'NOT_IN_FORCE' | 'PARTIALLY_IN_FORCE' | 'UNKNOWN';
  valid_from: string | null;
  valid_to: string | null;
  status_note: string | null;
  source_status_text: string | null;
  source_status_location: string | null;
}
```

**Функціональність:**
- Витягує чинність зі джерела (jsonData.status, jsonData.txt)
- Нормалізує в enum
- Витягує valid_from / valid_to якщо є
- Зберігає source_status_text / source_status_location для дебагу

**Джерела чинності:**
- `jsonData.status` (якщо є)
- Текст документа (пошук: "втратив чинність", "не набрав чинності", "чинний", "нечинний")
- Метадані сторінки

#### 3.5 Normalizer (рефакторинг)
**Файл:** `scripts/legislation/canonical/normalizer.ts` (новий або розширення)

**Функціональність:**
- Unicode normalization (NFKC)
- Прибрати NBSP/soft hyphen
- Уніфікувати тире/лапки
- Нормалізація пробілів і переносів так, щоб парсер структури був стабільний

#### 3.6 Structure Parser (критичний рефакторинг) ⭐
**Файл:** `scripts/legislation/canonical/parseUnits.ts`

**Зміни:**
- ✅ НІКОЛИ не нумеруй статті по позиції (вже так)
- ⚠️ Виправити fallback: `number: struNumber || String(units.length + 1)` → не використовувати індекс
- Додати поля:
  - `number_value_structured` (підтримка 115-1, 115¹)
  - `order_key` (для сортування без зсувів)
- Вилучити з "структурних вузлів":
  - Редакційні примітки
  - "втратив чинність"
  - Виноски
  - Технічні заголовки

**Критично:** Перевірити що `item.stru` або `item.number` завжди використовується, а не індекс масиву.

#### 3.7 Chunker (рефакторинг)
**Файл:** `scripts/legislation/canonical/chunking.ts`

**Зміни:**
- Чанкуй так, щоб кожен chunk мав:
  - `anchors: article_number / section/chapter labels`
  - `stable path: e.g. "ККУ > Розділ ... > Стаття 115 > Частина 1"`
- Chunk boundaries не повинні відривати номер від контенту

#### 3.8 Validator (легкий, інваріанти)
**Файл:** `scripts/legislation/canonical/validator.ts` (новий)

**Інваріанти:**
- Якщо в тексті є "Стаття 115" => має бути вузол article=115
- Якщо validity = NOT_IN_FORCE => не можна показувати як ACTIVE
- Якщо doc_type confidence низький => лог + маркувати для ручної перевірки

### КРОК 4: Додати Поля Validity в БД

**Міграція:**
```sql
ALTER TABLE legislation_documents
  ADD COLUMN IF NOT EXISTS validity_status TEXT CHECK (validity_status IN ('ACTIVE', 'REPEALED', 'NOT_IN_FORCE', 'PARTIALLY_IN_FORCE', 'UNKNOWN')),
  ADD COLUMN IF NOT EXISTS valid_from DATE,
  ADD COLUMN IF NOT EXISTS valid_to DATE,
  ADD COLUMN IF NOT EXISTS status_note TEXT,
  ADD COLUMN IF NOT EXISTS source_status_text TEXT,
  ADD COLUMN IF NOT EXISTS source_status_location TEXT;
```

**Оновити:**
- `importer.ts` — заповнювати нові поля
- API / UI — показувати validity

### КРОК 5: Reimport Всіх 190 Документів

**Команда:**
```bash
# Для кожного документа:
pnpm tsx scripts/legislation/admin-cli.ts update --nreg "<nreg>" --force
```

**Або batch:**
```typescript
// Створити команду update-all
```

### КРОК 6: Ручна Повторна Перевірка

- Пройти всі 190 документів вручну
- Поставити ✅ у after_fix_check
- Якщо щось не ок — зафіксувати новий баг-клас

### КРОК 7: Особливий Фокус — Зсув Статей

**Перевірити вручну:**
- ККУ: стаття 115 має бути 115
- Ще 2-3 великі кодекси
- Перевірка 5-10 статей по вибірці

**Root cause має бути чітко описаний:**
- Відступи/виноски/редакції не рахуються як статті
- 115-1/115¹ правильно парсяться і сортуються

---

## Пріоритети

1. **КРИТИЧНО:** Validity Extractor + поля в БД (КРОК 3.4 + 4)
2. **КРИТИЧНО:** Structure Parser — виправити fallback нумерацію (КРОК 3.6)
3. **ВАЖЛИВО:** Canonical Resolver (КРОК 3.2)
4. **ВАЖЛИВО:** Metadata Extractor — doc_type з метаданих (КРОК 3.3)
5. **ПОКРАЩЕННЯ:** Fetcher, Normalizer, Validator

---

## Наступні Кроки (зараз)

1. ✅ Створити структуру для аудиту
2. ⏳ Почати ручний аудит (10-20 документів)
3. ⏳ Класифікувати баги
4. ⏳ Почати рефакторинг з Validity Extractor
