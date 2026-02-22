# U4 — LLDBI vocabulary fields we can rely on

## Контекст

U4 та U2 потребують **дозволених значень** категорій і типів актів з LLDBI (Supabase `legislation_documents`), щоб не хардкодити списки і не будувати словники "слово → акт". Цей документ фіксує, які поля стабільні та придатні для routing/candidates.

## Джерело даних

- **Таблиця:** `legislation_documents` (Supabase Legislation DB).
- **Обмеження:** тільки read-only; жодних міграцій/бекфілів у рамках цієї фази.

## Поля, на які можна покладатися

### 1. `category` (varchar, nullable)

- **Призначення:** сімейство/галузь права для taxonomy (family key).
- **Формат:** lowercase snake_case, напр. `criminal`, `civil`, `administrative`, `labor_social`, `tax_customs`, `finance_banking`, `international_eu`.
- **Стабільність:** заповнюється при імпорті; змінюється рідко (перекласифікація).
- **Використання:** U2 AI routing — `allowed_categories`; U4 getTaxonomyCandidates — domainHint / byCategory; routing hints — family_key.
- **Статистика (на дату аудиту):** 28 унікальних значень, 255 документів (is_active=true). Топ: finance_banking, other, administrative, defense_mobilization, business_corporate.

### 2. `document_type` (varchar, nullable)

- **Призначення:** тип акту: кодекс, закон, постанова КМУ, указ президента, наказ, конвенція, рішення КСУ тощо.
- **Формат:** людсько-читаний українською, напр. "Кодекс", "Закон", "Постанова КМУ", "Указ Президента", "Рішення КСУ", "Конвенція", "Міжнародний договір".
- **Стабільність:** заповнюється з джерела (rada.gov.ua) або правилами імпорту; нові типи з’являються рідко.
- **Використання:** U2 AI routing — `allowed_document_types`; U4 — підсилення/фільтр кандидатів за типом акту (указ/постанова/КСУ) без словників по словах запиту.
- **Статистика:** 31 унікальне значення. Топ: Розпорядження КМУ, Постанова КМУ, Указ Президента, Кодекс, Закон, Рішення КСУ, Конвенція.

### 3. `storage_category` (text, nullable)

- **Призначення:** папка в R2; стабільна при рекласифікації (semantic category — в `category`).
- **Використання:** опційно для діагностики; для routing достатньо `category` + `document_type`.

### 4. Інші поля (для контексту, не для vocabulary)

- **indexed_chunks, qdrant_status:** чи акт проіндексований у Qdrant; не визначають множину дозволених категорій/типів.
- **aliases, keywords, topics:** вже використовуються в ActTaxonomyStore; не частина "vocabulary" U2 routing.
- **validity_status, document_type_slug, document_number:** корисні для майбутніх поліпшень, не обов’язкові для Phase A/B.

## Інваріанти

1. U2 AI routing classifier повертає лише значення з **allowed_categories** та **allowed_document_types**, отриманих із LLDBI (кеш vocabulary).
2. U4 не додає нових "слово → акт" або "слово → category"; підсилення кандидатів — за рахунок category/doc_type з кешу та AI-виводу.
3. При недоступності Supabase використовується snapshot з `_datasets/lldbi_vocabulary_snapshot.json` (fallback), щоб тести/запуски не залежали від мережі.

## Посилання

- Act taxonomy store: `retrieval/act-taxonomy-store.ts`
- Pipeline: `docs/architecture/app/u4/pipeline.md`
- Legislation table: MCP Supabase legislation `list_tables` / `execute_sql` (read-only).
