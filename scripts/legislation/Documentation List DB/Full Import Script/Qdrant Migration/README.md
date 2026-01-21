## Qdrant Setup (DocListDB) — створення колекції + payload indexes

Ця папка містить утиліту для **створення/перевірки Qdrant колекції** для **DocListDB (каталог `doc.txt`)**.

**Статус (prod):** Cloudflare Vectorize **не використовується**.  
Якщо у вас історично був Vectorize індекс — скрипт може (опційно) зняти “паспорт” через Cloudflare API, але це **не потрібно** для налаштування Qdrant.

### Що робить скрипт

`create_qdrant_collection.ts`:

- Створює в Qdrant колекцію:
  - `vectors.size = 768`
  - `distance = Cosine`
  - назва за замовчуванням: `legislation-catalog-index`
- Створює **payload indexes** для ключових полів, які реально використовує production-імпортер (фільтри/audit/test)
- Опційно робить **smoke-test**: upsert 10 точок → vector search → filter scroll → delete-by-ids cleanup
- (Опційно) може зняти “паспорт” legacy Vectorize індексу (read-only) якщо присутній `VECTOR_DB_API`

### Безпека

- (Опційно) **не модифікує/не видаляє** Cloudflare Vectorize індекс (тільки GET).
- У Qdrant **не** робить масових імпортів.
- Smoke-test видаляє **тільки ті IDs**, які сам вставив.

---

## Запуск

### 1) Встановити залежності пакета імпортера

З кореня репозиторію:

```bash
npm install --prefix "scripts/legislation/Documentation List DB/Full Import Script"
```

### 2) Переконатися, що `.env` містить ключі

Використовується repo-root `.env` (або будь-який `.env` знайдений “вгору” від поточного каталогу).

Потрібні:

- **Qdrant:**
  - `QDRANT_API` (як **URL**) **або** `QDRANT_URL`
  - (опційно) `QDRANT_API_KEY`
  - Примітка: якщо `QDRANT_API` у вас виглядає як `uuid|...` — це **API key**, тоді потрібно задати `QDRANT_URL`
    (або передати `--qdrant-url` при запуску).
- **Smoke-test embeddings (як у production імпортері):**
  - `OPEN_ROUTER_API_RAG`
  - (опційно) `OPENROUTER_EMBEDDING_MODEL`

Опційно (legacy, не потрібно для Qdrant):
- `VECTOR_DB_API`
- `CLOUDFLARE_ACCOUNT_ID`

### 3) Створити колекцію + індекси (idempotent)

```bash
npx --prefix "scripts/legislation/Documentation List DB/Full Import Script" tsx \
  "scripts/legislation/Documentation List DB/Full Import Script/Qdrant Migration/create_qdrant_collection.ts" \
  create
```

Якщо `QDRANT_URL` не в env, можна передати URL напряму:

```bash
npx --prefix "scripts/legislation/Documentation List DB/Full Import Script" tsx \
  "scripts/legislation/Documentation List DB/Full Import Script/Qdrant Migration/create_qdrant_collection.ts" \
  create --qdrant-url "https://<your-qdrant-host>:6333"
```

### 4) Прогнати smoke-test (10 точок)

```bash
npx --prefix "scripts/legislation/Documentation List DB/Full Import Script" tsx \
  "scripts/legislation/Documentation List DB/Full Import Script/Qdrant Migration/create_qdrant_collection.ts" \
  create --smoke-test
```

---

## Як перевірити, що колекція створена

- Успішний запуск створює/оновлює файл `qdrant_schema_report.json` у цій папці.
- За потреби можна перевірити через Qdrant UI/REST:
  - `GET /collections/<collection_name>`

