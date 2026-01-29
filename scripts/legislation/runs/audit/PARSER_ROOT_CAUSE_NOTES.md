# Parser Root Cause Notes — Structural Consistency Analysis

**Дата:** 2026-01-26  
**Мета:** Зрозуміти де саме може статися зсув у pipeline

---

## 1. Pipeline Flow

### 1.1 Canonical Structure (buildCanonical.ts)

**Source of Truth для номера статті:**
- `canonical.content.articles[].number` — номер статті (string)
- `canonical.content.articles[].title` — заголовок статті
- `canonical.content.articles[].content` — повний текст статті

**Source of Truth для тексту статті:**
- `canonical.content.articles[].content` — повний текст статті
- `canonical.content.chunks[].text` — текст chunk (може бути частиною статті)

**Mapping:**
- `canonical.content.chunks[].article_number` — номер статті для chunk
- `canonical.content.chunks[].chunk_index` — порядковий номер chunk

**Потенційні місця зсуву:**
1. `parseUnits.ts` — якщо неправильно витягує номер з stru/txt
2. `buildCanonical.ts` — якщо неправильно мапить units → articles → chunks
3. `chunking.ts` — якщо неправильно прив'язує chunk до article_number

---

### 1.2 Chunking (chunking.ts)

**Логіка:**
- `createChunksFromUnits(units, context)` — створює chunks з units
- Для кожного unit:
  - Якщо unit короткий (< 1000 токенів) → 1 chunk
  - Якщо unit довгий → розбиваємо на частини з overlap
- `article_number` встановлюється тільки для `unit.unit_type === 'article'`
- `unit_number` та `unit_type` НЕ передаються в canonical chunks

**Потенційні місця зсуву:**
1. Якщо unit має `unit.number = "115"`, але `unit.unit_type !== 'article'` → `article_number = null`
2. Якщо chunks розбиваються неправильно → chunk може належати іншій статті

---

### 1.3 Importer → Qdrant (importer.ts)

**Payload формування:**
```typescript
payload: {
  article_number: chunk.article_number || null,  // Тільки для articles
  // unit_number, unit_type НЕ передаються
}
```

**Потенційні місця зсуву:**
1. Якщо `chunk.article_number` неправильний → payload буде неправильний
2. Якщо `chunk.article_number` null для point-based документів → не можна перевірити consistency

---

### 1.4 Qdrant Payload (qdrantRagClient.ts)

**Поточні поля:**
- `article_number: string | null` — номер статті (тільки для articles)
- `chunk_index: number` — порядковий номер chunk
- `json_path: string` — шлях в canonical JSON

**Відсутні поля (потрібні для structural consistency):**
- `unit_number: string | null` — універсальний номер unit (article/point/section)
- `unit_type: string | null` — тип unit (article/point/section)
- `unit_id: string | null` — стабільний ID unit (для mapping)

---

## 2. MRE Results (ККУ + КУпАП)

**Результат:** ✅ Всі 15 перевірок OK
- canonical ↔ Qdrant payload узгоджені
- `article_number` в payload відповідає canonical
- Зсуву немає

**Висновок:** Structural consistency працює правильно. Проблема в audit-parser-integrity — він перевіряє текст на наявність "Стаття N", а не structural consistency.

---

## 3. Root Cause: Audit Logic

**Поточна проблема:**
- audit-parser-integrity перевіряє чи текст містить "Стаття N"
- Але chunks можуть не містити "Стаття N" в тексті (якщо це частина статті або якщо title формується по-іншому)
- Це false positive — structural consistency OK, але audit падає

**Рішення:**
1. Переробити audit-parser-integrity на structural consistency mode
2. Додати `unit_number`, `unit_type` в payload для кращої перевірки
3. Перевіряти mapping canonical ↔ Qdrant payload, а не текст

---

## 4. Потрібні зміни

### 4.1 Додати поля в CanonicalChunk
```typescript
export interface CanonicalChunk {
  chunk_index: number;
  article_number: string | null;
  unit_number?: string | null;  // НОВЕ
  unit_type?: string | null;    // НОВЕ
  text: string;
  title?: string;
  token_count: number;
}
```

### 4.2 Додати поля в ChunkPayload
```typescript
export interface ChunkPayload {
  // ... existing fields
  unit_number?: string | null;  // НОВЕ
  unit_type?: string | null;    // НОВЕ
}
```

### 4.3 Оновити importer.ts
Передавати `unit_number` та `unit_type` з chunks в payload.

### 4.4 Переробити audit-parser-integrity
Перевіряти structural consistency (canonical ↔ Qdrant payload), а не текст.

---

**Оновлено:** 2026-01-26
