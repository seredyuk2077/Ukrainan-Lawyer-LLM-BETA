# DEPRECATED: Vectorize Catalog DB

> **Статус:** deprecated (2026‑01‑21) — Cloudflare Vectorize більше **не використовується** у проді DocListDB.  
> Актуальний каталог актів живе в **Qdrant** (`legislation-catalog-index`) і обслуговується `UpdaterDB` + `act-catalog-resolver` Worker.

Нижче збережена історична документація (as-is), щоб не втратити контекст.

---

# Vectorize Catalog DB

**Дата створення:** 2026-01-14  
**Статус:** ✅ Створено та налаштовано  
**Призначення:** Vector Database для семантичного пошуку по каталогу законодавчих документів

---

## 📋 Огляд

**Vectorize Catalog DB** — це Cloudflare Vectorize індекс, який містить метадані всіх документів з каталогу Rada Open Data Portal (~289k документів). Використовується для семантичного пошуку документів, які відсутні в основній БД, щоб AI могла знайти кандидатів для on-demand імпорту.

### Призначення

- **Discovery:** AI робить semantic search по каталогу → знаходить кандидат(ів) за запитом користувача
- **On-demand import:** Отримує `nreg`/`dokid` → ініціює імпорт акту в основну БД (Supabase + R2)
- **Metadata filtering:** Фільтрація за типом, органом, статусом, роком

---

## 🔧 Технічні параметри

### Назва індексу

```
legislation-catalog-index
```

### Параметри індексу

- **Dimensions:** `768` (достатньо для каталогу, не використовуємо 1536)
- **Metric:** `cosine` (косинусна схожість)
- **Region:** Автоматично визначається Cloudflare

### Metadata Indexes

Створені індекси для швидкої фільтрації (максимум 10, використано 4):

1. **`type`** (string) — тип документа
2. **`organ`** (string) — орган, що видав документ
3. **`status`** (string) — статус документа
4. **`year`** (number) — рік видання (витягнутий з `datred`)

---

## 📊 Data Contract (Контракт даних)

### Vector ID

**`vector_id` = `nreg`** (номер реєстрації)

**Обґрунтування:**
- ✅ Стабільний унікальний ключ
- ✅ Не змінюється протягом життєвого циклу документа
- ✅ Використовується для upsert (idempotency)

### Metadata Schema

Кожен вектор містить наступні метадані:

```typescript
interface CatalogVectorMetadata {
  // Обов'язкові поля
  nreg: string;        // Номер реєстрації (primary key, vector_id)
  nazva: string;       // Назва документа
  dokid?: number;      // ID документа (опціонально)
  
  // Поля для фільтрації (індексовані)
  type: string;        // Тип документа (нормалізований, перший тип з масиву)
  organ: string;       // Орган (нормалізований, перший орган з масиву)
  status: string;      // Статус документа (string representation)
  year: number;        // Рік видання (витягнутий з datred: YYYYMMDD → YYYY)
  
  // Додаткові поля (не індексовані)
  datred?: string;     // Дата редагування (YYYYMMDD)
  minjust?: boolean;   // Реєстрація в Міністерстві юстиції
}
```

**Обмеження:**
- Metadata має бути ≤10KiB на вектор
- Тільки прості типи (string, number, boolean)
- Масиви не підтримуються напряму (нормалізуємо до першого значення)

### Embedding Text Template

Текст, який піде в embedding для генерації векторів:

```
{nazva} | Тип: {type} | Орган: {organ} | Дата: {datred}
```

**Приклад:**
```
Про захист прав споживачів | Тип: Закон України | Орган: Верховна Рада України | Дата: 20250125
```

**Обґрунтування:**
- Назва (`nazva`) — найважливіша частина для semantic search
- Тип та орган — допомагають розрізняти схожі документи
- Дата — для контексту актуальності

**Альтернативний формат (якщо потрібно більше контексту):**
```
Документ: {nazva}
Тип: {type}
Видавник: {organ}
Дата редагування: {datred}
Статус: {status}
```

---

## 🔐 Налаштування середовища

### Необхідні змінні оточення

Додайте в `.env` (в корені проекту):

```bash
# Cloudflare Vectorize API
# Отримайте API token з Cloudflare Dashboard: https://dash.cloudflare.com/profile/api-tokens
# Потрібні права: Account.Cloudflare Vectorize:Edit
VECTOR_DB_API=your_cloudflare_api_token_here

# Опціонально (якщо не вказано, буде отримано автоматично з API)
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

### Перевірка доступу

Перевірте, що API token має права на Vectorize:

```bash
# Через скрипт
pnpm tsx "scripts/legislation/Documentation List DB/deprecated/vectorize/createIndex.ts"

# Або через curl (якщо знаєте Account ID)
curl -X GET "https://api.cloudflare.com/client/v4/accounts/{account_id}/vectorize/indexes" \
  -H "Authorization: Bearer $VECTOR_DB_API" \
  -H "Content-Type: application/json"
```

---

## 🚀 Створення та перевірка індексу

### Створення індексу

Використовуйте скрипт для створення індексу (idempotent — якщо індекс вже існує, пропустить):

```bash
pnpm tsx "scripts/legislation/Documentation List DB/deprecated/vectorize/createIndex.ts"
```

Скрипт автоматично:
1. Отримає Account ID (якщо не вказано в env)
2. Перевірить чи існує індекс
3. Створить індекс з правильними параметрами
4. Створить metadata indexes
5. Виведе інформацію про створений індекс

### Перевірка існування індексу

**Через скрипт:**
```bash
pnpm tsx "scripts/legislation/Documentation List DB/deprecated/vectorize/createIndex.ts"
# Якщо індекс існує, виведе інформацію про нього
```

**Через Cloudflare API (якщо знаєте Account ID):**
```bash
curl -X GET "https://api.cloudflare.com/client/v4/accounts/{account_id}/vectorize/indexes/legislation-catalog-index" \
  -H "Authorization: Bearer $VECTOR_DB_API" \
  -H "Content-Type: application/json"
```

**Через wrangler CLI (якщо встановлено):**
```bash
npx wrangler vectorize list
npx wrangler vectorize info legislation-catalog-index
```

**Результат перевірки (приклад):**
```json
{
  "created_on": "2026-01-14T18:43:09.317263Z",
  "modified_on": "2026-01-14T18:43:09.317263Z",
  "name": "legislation-catalog-index",
  "description": "Catalog index for legislation documents from Rada Open Data Portal...",
  "config": {
    "dimensions": 768,
    "metric": "cosine"
  }
}
```

---

## 📝 Використання імпортером

### Контракт для майбутнього імпортера

Імпортер буде:

1. **Читати `doc.txt`** з Open Data Portal:
   - Формат: TSV (табуляція), Windows-1251
   - Колонки: `dokid, nreg, nazva, status, types, organs, empty, minjust, datred`
   - ~289k рядків

2. **Нормалізувати дані:**
   - `types` (масив/рядок) → `type` (перший тип, string)
   - `organs` (масив/рядок) → `organ` (перший орган, string)
   - `datred` (YYYYMMDD) → `year` (YYYY, number)
   - `status` (number) → `status` (string representation)

3. **Генерувати `embedding_text`:**
   ```
   {nazva} | Тип: {type} | Орган: {organ} | Дата: {datred}
   ```

4. **Генерувати embeddings:**
   - Використовувати модель з dimensions=768
   - Наприклад: `text-embedding-3-small` (1536 dims → truncate до 768) або `@cf/baai/bge-base-en-v1.5` (768 dims)

5. **Upsert у Vectorize:**
   ```typescript
   const vectors = [
     {
       id: nreg,  // vector_id = nreg
       values: embedding,  // масив з 768 чисел
       metadata: {
         nreg,
         nazva,
         dokid,
         type,
         organ,
         status,
         year,
         datred,
         minjust,
       }
     }
   ];
   
   await vectorizeIndex.upsert(vectors);
   ```

### Naming Conventions

- **Index name:** `legislation-catalog-index` (kebab-case)
- **Vector ID:** `nreg` (як є, без нормалізації)
- **Metadata keys:** camelCase (`nreg`, `nazva`, `dokid`, `type`, `organ`, `status`, `year`, `datred`, `minjust`)

### Idempotency

Upsert операція автоматично idempotent:
- Якщо вектор з `id=nreg` вже існує → оновлюється
- Якщо не існує → створюється
- Використовувати `nreg` як `id` гарантує унікальність

---

## 🔍 Приклади використання

### Semantic Search (майбутній API)

```typescript
// Приклад використання в Edge Function або API
const query = "захист прав споживачів";
const queryEmbedding = await generateEmbedding(query);

const results = await vectorizeIndex.query({
  vector: queryEmbedding,
  topK: 10,
  returnMetadata: true,
  filter: {
    type: "Закон України",  // опціональна фільтрація
    year: { $gte: 2020 },    // опціональна фільтрація
  }
});

// results.matches містить:
// - id (nreg)
// - score (cosine similarity)
// - metadata (nreg, nazva, type, organ, status, year, ...)
```

### Фільтрація за metadata

```typescript
// Фільтр за типом
filter: { type: "Закон України" }

// Фільтр за роком
filter: { year: { $gte: 2020, $lte: 2025 } }

// Фільтр за статусом
filter: { status: "1" }

// Комбінований фільтр
filter: {
  type: "Закон України",
  year: { $gte: 2020 },
  status: "1"
}
```

---

## 📚 Пов'язана документація

- **Документація каталогу:** [`docs/legislation-rag/Documentation RADA List DB/README.md`](../Documentation%20RADA%20List%20DB/README.md)
- **Верифікація джерел:** [`docs/legislation-rag/Documentation RADA List DB/verification.md`](../Documentation%20RADA%20List%20DB/verification.md)
- **План імпортера:** [`scripts/legislation/Documentation List DB/plan.md`](../../../scripts/legislation/Documentation%20List%20DB/plan.md)

---

## ⚠️ Важливі примітки

1. **Не запускати масовий імпорт** на цьому етапі (тільки створення індексу)
2. **Не виводити API ключі** у логах/файлах/документації
3. **Metadata обмеження:** ≤10KiB на вектор, тільки прості типи
4. **Dimensions:** 768 (не 1536) — достатньо для каталогу
5. **Metadata indexes:** максимум 10, використано 4 (type, organ, status, year)

---

## ✅ Статус

- ✅ Індекс створено: `legislation-catalog-index`
- ✅ Dimensions: 768
- ✅ Metric: cosine
- ✅ Створено: 2026-01-14
- ⚠️  Metadata indexes: потрібно створити через wrangler CLI (див. нижче)
- ✅ Документація створена
- ⏳ Імпортер (наступний етап)

### Створення Metadata Indexes

Metadata indexes можна створити через `wrangler` CLI (якщо встановлено):

```bash
npx wrangler vectorize create-metadata-index legislation-catalog-index --property-name=type --type=string
npx wrangler vectorize create-metadata-index legislation-catalog-index --property-name=organ --type=string
npx wrangler vectorize create-metadata-index legislation-catalog-index --property-name=status --type=string
npx wrangler vectorize create-metadata-index legislation-catalog-index --property-name=year --type=number
```

**Альтернатива:** Metadata indexes можуть створюватися автоматично при першому upsert з відповідними metadata полями.

---

**Документація готова до використання** ✅

