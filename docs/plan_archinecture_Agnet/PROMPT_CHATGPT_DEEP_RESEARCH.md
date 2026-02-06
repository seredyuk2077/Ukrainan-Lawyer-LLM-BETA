# Промпт для ChatGPT Deep Research: аналіз архітектури Lexery Legal Agent

**Призначення:** отримати структурований Deep Research звіт по архітектурі (Findings, Options, Recommendation, Checklist), заземлений у сирому документі `plan.md` і реальному контексті репо (DocListDB UpdaterDB, LLDBI, R2 state/locks, Qdrant, OpenRouter).



**Контекст репо (для прив’язки промпт до реального коду):**

- **Online serving:** Lexery Legal AI Agent Brain — мікросервіс: Gateway → Orchestrator → Memory Manager, Retrieval Engine (LLDBI 1536d + DocListDB 768d), Reasoner, Writer, Verifier; API `/v1/runs`, стрімінг подій; білінг, Azure.
- **Offline data plane:**
  - **DocListDB Daily Updater:** `scripts/legislation/Documentation List DB/UpdaterDB/` — cron (GitHub Actions `rada-doclistdb-updater.yml`, щодня 02:17 UTC) → Rada feeds (`r.txt`, `nn`, опц. backstop `n`) → fetch card JSON `/laws/card/<nreg>.json` → normalize + delta (compare з Qdrant payload) → embeddings через **OpenRouter** endpoint, dim=768 → upsert Qdrant колекція **`legislation-catalog-index`**; дедуп: `retrieve(id=dokid)` + fallback `scroll` по `dokid`; state/lock/run reports у **Cloudflare R2** (prefix `legislation/DocListDB rada gov updater log/`): `state.json`, `locks/daily.lock` (TTL, exit 0 якщо lock молодий), `runs/<run_id>.json`; флаги `--dry-run`, `--selftest`, `--backstop`.
  - **LLDBI pipeline:** `scripts/legislation/Lexery Legislation DB Infra/` — Rada/Supabase → canonical JSON → R2 `legislation/{category}/{nreg}.json` → Qdrant `lexery_legislation_acts`, `lexery_legislation_chunks` (1536d); Supabase `legislation_documents`, `legislation_import_jobs`.
- **Act Catalog Resolver API:** Cloudflare Worker у `Documentation List DB/Act Catalog Resolver API/` — vector search по `legislation-catalog-index`, опц. rerank.

---

## Критерії якісної архітектури (Definition of Done)

Використовуй ці критерії як орієнтир: чи документ і реалізація їх задовольняють, і де є прогалини.

**A. Контекст і межі**  
Мета системи (1–2 абзаци): для кого, які задачі (Q&A по праву, пошук норм, генерація договорів), які гарантії (цитати/посилання, обмеження відповідальності). Scope / Non-goals. Ключові обмеження: бюджет, латентність, масштаб, приватність, ризики галюцинацій.

**B. Повна карта пайплайну (end-to-end)**  
Єдиний життєвий цикл даних: джерело → інжест → нормалізація → сховище → індексація → retrieval → генерація → логування/аудит. Дві паралельні траси: **Offline/Data plane** (оновлення баз: daily updater, LLDBI import) і **Online/Serving plane** (запит користувача → відповідь). Кожен блок: ID, відповідальність, owner, SLA/латентність, залежності.

**C. Контракти, дані, схеми**  
Контракти API (вхід/вихід, коди помилок). Source of truth для: document card (DocListDB), embeddings (dim, модель), full-text (R2), метадані (Supabase). Ідемпотентність і дедуп: ключі/ID, уникання дублів у Qdrant (у UpdaterDB: retrieve + scroll fallback).

**D. Надійність, безпека, спостережуваність**  
Failure modes, retry/backoff/locking (у updater: lock file + TTL, exit 0). Secrets і trust boundaries. Observability: метрики, structured logs, run reports (R2 `runs/<run_id>.json`). Тест-план: self-test, dry-run, e2e (`--dry-run`, `--selftest`).

**E. Еволюція**  
Roadmap, точки розширення (наприклад Supreme Court case-law RAG як плагін).

**Формат документу (2 частини):**  
(1) **Block-chain map** — ASCII, 1–2 екрани: Online і Offline (правила нижче).  
(2) **Матриця блоків** — один рядок на кожен блок, усі колонки заповнені, без спрощень (правила нижче).  
(3) **Детальний текст** — Overview, System Context, End-to-End Flows, Components, Data Model, Security, Reliability, Observability, Deployment, Testing, Gaps/TODO, Appendix.

---

## Як будувати матриці та алгоритмічні ланцюжки (правила архітектора)

Цей розділ **обов’язково виконувати** при генерації block-chain map і матриці блоків. Ігнорування цих правил призводить до некорисного результату.

### 1. Алгоритмічний ланцюжок (block-chain map) — як оформлювати

**Призначення:** один погляд показує повний потік даних/контролю від входу до виходу. Це не «схема для краси» — це контракт: кожен бокс = окремий компонент з чіткою відповідальністю.

**Правила побудови:**

- **Символи:** використовуй тільки ASCII: `|` (вертикальна лінія), `v` (стрілка вниз), `->` (стрілка вправо), `[ ]` (блок), `( )` (підпис), `-` для горизонтальних ліній. Без Unicode-стрілок і без складних рамок — тільки так схема коректно відображається в будь-якому редакторі та в Markdown.
- **Напрямок потоку:** завжди зверху вниз. Вхід (User/Cron) — зверху, вихід (Response/Logging або R2 state) — знизу.
- **Один блок — один рядок з позначкою:** формат `[ID] Коротка назва (уточнення якщо потрібно)`. Наприклад: `[S1] API Gateway`, `[E1] Embeddings (OpenRouter, 768d)`. ID мають бути унікальними (S1, A1, R1, D1, N1 тощо) і потім використовуватися в матриці як Block ID.
- **Паралельні гілки:** якщо з одного блоку виходять кілька наступних паралельно, рисуй так:
  ```
  [A1] Orchestrator
    |-----> [R1] Retriever
    |-----> [C1] Context Builder
    |-----> [L1] LLM
    |
    v
  [P1] Post-process
  ```
  Тобто одна вертикальна лінія вниз і від неї горизонтальні `|----->` до кожного паралельного блоку; потім усі знову сходяться в один наступний блок через `v`.
- **Розділення Online / Offline:** дві окремі карти або один файл з чіткою горизонтальною лінією-роздільником (`---` або `========`) і підписом "(ONLINE)" та "(OFFLINE)". Не змішуй обидва потоки в одній схемі — так губиться чіткість.
- **Довжина:** одна карта — не більше 1–2 екранів (приблизно 25–40 рядків). Якщо блоків багато, групуй підблоки під одним позначенням лише якщо вони дійсно один логічний крок (наприклад «Normalize + Hash/Delta» — один блок N1).
- **Вирівнювання:** тримай `[` і `]` по одній вертикалі для зручності читання; відступи однакові (наприклад 2 пробіли для вкладень).

**Помилки, яких уникати:**  
Не об’єднуй кілька різних компонентів в один бокс «тощо» або «інше». Не замінюй блоки на опис текстом — кожен крок має бути боксом з ID. Не використовуй діаграми в іншому форматі (Mermaid, PlantUML) замість ASCII у цьому завданні — ASCII є обов’язковим для сумісності та простоти правок.

### 2. Матриця блоків — як робити максимально детальною

**Призначення:** матриця — це «один рядок = один блок з карти». Вона дає повний контроль: що входить, що виходить, де зберігається, від чого залежить, як падає, як ретраїться, що логується, як тестувати. **Спрощення або пропуск рядків/колонок робить архітектуру неповною і не застосовуваною.**

**Жорсткі правила:**

- **Один блок з block-chain map = один рядок у матриці.** Якщо на карті 18 блоків (Online + Offline разом) — в матриці має бути 18 рядків. **Заборонено:** об’єднувати кілька блоків в один рядок «і інше», «Retriever + Reranker + Context», «всі кроки Offline». **Дозволено:** окремий рядок для [R1] Retriever, окремий для [RR] Reranker, окремий для [C1] Context Builder.
- **Усі колонки заповнені.** Для кожного рядка має бути заповнена кожна колонка (Purpose, Inputs, Outputs, Storage side-effects, Dependencies, Secrets, Failure modes, Retries/Timeouts, Observability, Test hooks). Якщо чогось немає в документі — пиши явно: «не описані в документі» або «немає (stateless)», а не залишай порожнім. Для компонентів з репо (UpdaterDB, Gateway тощо) бери значення з контексту: наприклад Dependencies = «Rada API, Qdrant, OpenRouter, R2», Secrets = «QDRANT_API_KEY, OPEN_ROUTER_API_RAG, R2_*», Failure modes = «timeout Rada, 429, Qdrant unavailable», Retries = «backoff на 429/5xx», Observability = «runs/<run_id>.json у R2, structured logs».
- **Конкретні значення, не плейсхолдери.** Заборонено в матриці: «тощо», «наприклад», «e.g.», «TBD» без явного «TBD: [що саме вирішити]». Дозволено: «R2: state.json, locks/daily.lock, runs/<run_id>.json», «Qdrant: legislation-catalog-index», «timeout 60000 ms», «exit code 0 якщо lock молодий».
- **Block ID у першій колонці** має точно збігатися з ID на block-chain map ([S1], [A1], [D1], [E1] тощо), щоб була пряма відповідність «карта ↔ матриця».
- **Колонки — повний набір.** Мінімум: Block ID | Purpose | Inputs | Outputs | Storage side-effects | Dependencies | Secrets | Failure modes | Retries/Timeouts | Observability | Test hooks. Якщо додаєш колонки (наприклад SLA, Owner) — заповнюй їх для всіх рядків.
- **Markdown-таблиця:** використовуй синтаксис `| ... |`; для довгих текстів у клітинці можна переносити рядок як `<br>` або скоротити формулювання, але не видаляй рядок блоку і не об’єднуй клітинки.

**Помилки, яких уникати:**  
Не «економь» місце: матриця на 5 рядків при 15 блоках — некоректно. Не пиши «див. документ» замість конкретики в клітинці — винеси в документ один раз і в матриці дай коротке посилання типу «(§ Gateway)». Не замінюй Failure modes / Retries на «стандартні» без вказівки, які саме (timeout, backoff, exit code).

### 3. Якісна планка результату

Архітектура, яку ти генеруєш (карта + матриця + Findings/Recommendation), має бути **готовою до застосування**: по ній можна перевіряти реалізацію, онбордити нових розробників, приймати рішення про зміни. Тому:

- **Block-chain map:** після аналізу документу ти **обов’язково виводиш** повну ASCII-карту Online і повну ASCII-карту Offline (або одну з чітким розділенням), з усіма блоками з документу/репо, без пропусків.
- **Матриця блоків:** ти **обов’язково виводиш** повну таблицю: рядків стільки, скільки блоків на карті; усі колонки заповнені; значення взяті з документу або з контексту репо (шляхи, назви колекцій, env vars, таймаути). Не допускається «скорочена матриця» або «приклад кількох рядків».
- **Текст:** Findings, Options, Recommendation — без «можна розглянути» без конкретики; кожна рекомендація має мати кроки та артефакти (що змінити, де, який файл/таблиця).

Якщо обмеження довжини відповіді не дозволяє вмістити повну матрицю в один повідомлення — виведи її частинами (спочатку Online блоки, потім Offline) або зроби окремий підрозділ «Appendix: Full Block Matrix» і заповни його повністю.

---

## Шаблон block-chain map і матриці (для звірки з документом)

**Block-chain map (приклад структури):**

```
[U1] User/UI
  |
  v
[S1] API Gateway (Workers/Edge Function)
  |
  v
[A1] Agent Orchestrator
  |-----> [R1] Retriever (Qdrant: DocListDB cards / LLDBI chunks)
  |-----> [RR] Reranker (optional)
  |-----> [C1] Context Builder (citations, snippets, Memory ContextPack)
  |-----> [L1] LLM (OpenRouter / OpenAI)
  |
  v
[P1] Post-process (Verifier, формат, посилання, disclaimers)
  |
  v
[U2] Response + Logging/Tracing
------------------------------------------------------------
(OFFLINE DATA PLANE — DocListDB)
[T0] Cron (GitHub Actions daily)
  |
  v
[D1] Rada Feeds (r.txt, nn, backstop n)
  |
  v
[D2] Fetch Card JSON (/laws/card/<nreg>.json)
  |
  v
[N1] Normalize + Hash/Delta (compare Qdrant payload)
  |
  v
[E1] Embeddings (OpenRouter endpoint, dim=768)
  |
  v
[V1] Upsert Qdrant (legislation-catalog-index, dedup: retrieve+scroll)
  |
  v
[O1] State/Locks/Run reports -> Cloudflare R2
```

**Матриця блоків (мінімум колонок):**

| Block ID | Purpose | Inputs | Outputs | Storage side-effects | Dependencies | Secrets | Failure modes | Retries/Timeouts | Observability | Test hooks |
|----------|---------|--------|---------|----------------------|--------------|---------|---------------|------------------|---------------|------------|

Deep Research має перевірити, чи документ/реалізація покривають кожен блок з карти і рядок у матриці для Online та Offline plane.

---

## Текст промпт для Deep Research (копіюй від рядка нижче до «Кінець промпт для Deep Research»)

---

**Role:** Ти виконуєш Deep Research по архітектурі продукту **Lexery Legal AI Agent** — юридичний RAG-агент (Q&A по нормах, пошук актів, генерація консультацій з цитуванням). Тобі надано **сирий архітектурний документ** (план): огляд компонентів, Gateway, Memory Manager, Retrieval Engine (LLDBI + DocListDB), Reasoner/Writer/Verifier, пайплайн, state machine, білінг, Azure, інваріанти (evidence-only, web firewall, provenance), multi-tenancy, versioning, failure modes, observability, security, evals, UX trust, стандартизовані схеми (StreamEvent, Citation, EvidencePack, RunRecord), stop conditions, конфіг-профілі, migration beta→prod, а також Appendix B (таксономія помилок, ємність, state machine, API versioning, feature flags, аудит, DR, runbooks, контрактні тести, локалізація, матриця доступу, rate limits, health checks, промпти, ClaimGraph vs EvidencePack, ContextPack overflow, cancel run, idempotency, soft vs hard limits).

**Критично — правила архітектора (дотримуйся неуштульно):**

- **Block-chain map:** Тільки ASCII: `|`, `v`, `->`, `[ ]`, `( )`. Один блок = один рядок з унікальним ID ([S1], [A1], [D1] тощо). Потік зверху вниз. Паралельні гілки: `|----->`. Online і Offline — окремо або з чітким роздільником. Не об’єднуй різні компоненти в один бокс; не замінюй блоки текстом.
- **Матриця блоків:** Один рядок у таблиці = один блок з карти (кількість рядків = кількості блоків). **ЗАБОРОНЕНО** спрощувати, об’єднувати кілька блоків в один рядок, виводити «приклад» або «тощо». Усі колонки (Block ID, Purpose, Inputs, Outputs, Storage side-effects, Dependencies, Secrets, Failure modes, Retries/Timeouts, Observability, Test hooks) заповнені для кожного рядка; порожні клітинки не допускаються — пиши «не описані в документі» або конкретику з репо. У клітинках — тільки конкретні значення (шляхи, env vars, таймаути, назви колекцій), без «наприклад», «тощо», «TBD» (окрім явного «TBD: [що]»). Результат має бути придатний для прямого використання як архітектурний документ.

**Контекст репозиторію (фактичний код і пайплайни):**

- **Online:** Brain — Gateway (API), Orchestrator, Memory Manager (Supabase mm_* + Qdrant memory + R2), Retrieval Engine (LLDBI: lexery_legislation_chunks/acts, 1536d, R2 canonical; DocListDB: legislation-catalog-index, 768d; Act Catalog Resolver API), Reasoner, Writer, Verifier. Контракти: POST /v1/runs, стрім подій (state, progress, cost_so_far_usd, citations_count, need_user_clarification), RunRecord, EvidencePack, ContextPack.
- **Offline — DocListDB Daily Updater:**  
  - Шлях: `scripts/legislation/Documentation List DB/UpdaterDB/`.  
  - Запуск: GitHub Actions workflow `rada-doclistdb-updater.yml` (cron `17 2 * * *`).  
  - Потік: Rada feeds (`r.txt`, `nn`, опційно backstop `n`) → fetch card JSON `https://data.rada.gov.ua/laws/card/<nreg>.json` → normalize → **compare з існуючим Qdrant payload** (skip якщо identical → no embeddings/upsert) → для змін: embeddings (**OpenRouter** `https://openrouter.ai/api/v1/embeddings`, model text-embedding-3-small, **768 dimensions**) → **batch upsert** у Qdrant колекція **`legislation-catalog-index`**.  
  - Дедуплікація в Qdrant: спочатку `retrieve(id=dokid)`; якщо не знайдено — **scroll** filter по `dokid`, потім upsert з знайденим point id, щоб не плодити дублі.  
  - State/lock/reports: **Cloudflare R2**, bucket і prefix (наприклад `R2_BUCKET=legislation`, `R2_PREFIX=legislation/DocListDB rada gov updater log/`). Ключі: `state.json`, `locks/daily.lock` (якщо lock молодший за TTL → **exit code 0**, без повторного запуску), `runs/<run_id>.json` (run report).  
  - CLI: `npm run sync`; `--dry-run` (no embeddings, no upsert); `--selftest` (коли нема кандидатів — insert/retrieve/delete тест у Qdrant); `--backstop` (30-day feed); `--max-docs N`, `--skip-retrieve`.
- **Offline — LLDBI (Lexery Legislation DB Infra):** Rada/Supabase → canonical build → R2 `legislation/{category}/{rada_nreg}.json` → Qdrant `lexery_legislation_acts`, `lexery_legislation_chunks` (1536d), Supabase `legislation_documents`, `legislation_import_jobs`. Окремий pipeline від DocListDB; інший embedding простір (1536 vs 768).
- **Act Catalog Resolver API:** Cloudflare Worker — vector search по `legislation-catalog-index`, опційно LLM rerank; використовується Online-площиною для резолву запитів у nreg/dokid.

**Завдання Deep Research:**

1. **Context briefing (коротко):**  
   Підсумуй ціль продукту (для кого, які задачі), ключові обмеження (бюджет, латентність, якість відповідей, цитування, приватність) та scope/non-goals з документу.

2. **Аналіз двох площин:**  
   - **Online serving:** від запиту користувача до відповіді: Gateway → Orchestrator → Memory (ContextPack) + Retrieval (EvidencePack) → Reasoner → Writer → Verifier → response + logging/tracing. Оціни повноту контрактів, state machine, failure handling, білінг, observability.  
   - **Offline data plane:** оновлення баз. **DocListDB:** cron → Rada feeds → card JSON → normalize + **Qdrant compare** → embeddings (OpenRouter 768d) → **upsert** у `legislation-catalog-index`; **R2 state/lock/runs**. **LLDBI:** імпорт canonical → R2 + Qdrant (1536d) + Supabase. Оціни: single points of failure, race conditions (lock TTL, concurrency group у workflow), ризики дублів/розсинхрону індексів (retrieve+scroll fallback), деградація при недоступності Rada/OpenRouter/Qdrant/R2.

3. **Знайти та задокументувати:**  
   - **Single points of failure** і **bottlenecks** (по обох площинах).  
   - **Race conditions** і **locking:** чи достатньо `locks/daily.lock` + TTL та `cancel-in-progress: false` у workflow; чи можливі подвійні upsert або втрата state.  
   - **Ризики дублів і розсинхрону:** Qdrant upsert/dedup (dokid, retrieve+scroll), консистентність R2 state vs Qdrant vs Supabase (для LLDBI).  
   - **Security gaps:** розміщення секретів (GitHub Actions secrets, wrangler, env), trust boundaries, injection surface (user input у запити/ембедінги).  
   - **Observability gaps:** яких метрик/логів/алертів бракує для Online (run, step, cost, latency) і для Offline (processed/upserted/failed, run report у R2, діагностика при падінні cron).

4. **Вихід структурований — обов’язково:**

   **A) Findings**  
   Список: **проблема** → **наслідок** → **доказ/посилання на місце в архітектурі або коді** (наприклад «UpdaterDB: при падінні після embeddings але до upsert state не оновлюється → наступний run може повторити embeddings»; «Brain: відсутній circuit breaker для DocListDB resolver»).

   **B) Options**  
   Для кожної критичної проблеми — **мінімум 2 варіанти** рішення з trade-offs (вартість, складність, ризик, час впровадження).

   **C) Recommendation**  
   **Один** рекомендований шлях по пріоритетам (що робити першим для beta/prod) і **поетапний план** впровадження (короткі кроки з артефактами).

   **D) Checklist**  
   Список перевірок перед/після змін на проді: конфіги, секрети, lock TTL, тести (dry-run, selftest), моніторинг run reports у R2, health checks Brain, тощо.

5. **Вимоги до формулювань:**  
   - Використовуй **конкретні назви** з документу та репо: UpdaterDB, R2 state/locks/runs, Qdrant `legislation-catalog-index`, `lexery_legislation_chunks`/`acts`, retrieve+scroll fallback, OpenRouter embeddings endpoint, Rada feeds (r.txt, nn, n), card JSON, lock TTL, exit code 0, `--dry-run`, `--selftest`, Gateway, EvidencePack, ContextPack, RunRecord, circuit breaker, billing_ledger.  
   - Уточнюючі питання став лише там, де відповідь **блокує** конкретне рішення; інакше опирайся на документ і типовий prod-контекст.

6. **Перевірка на відповідність Definition of Done:**  
   Оціни, наскільки поточна архітектура (документ + описані пайплайни) відповідає критеріям A–E вище і формату документу (block-chain map, матриця блоків, детальний текст). Якщо чогось не вистачає — додай до Findings і Recommendation (наприклад «немає єдиної матриці блоків для Offline plane» → запропонувати заповнити шаблон).

7. **Обов’язковий вихід: block-chain map(s) і повна матриця блоків (як справжній архітектор):**

   **Block-chain map(s):**  
   Твоя відповідь **обов’язково** містить повні ASCII-діаграми (не «приклад», не «скорочено»):
   - **Online plane:** від [U1] User до відповіді/логування, з усіма блоками: Gateway, Orchestrator, Retriever (LLDBI + DocListDB), Reranker, Context Builder (Memory ContextPack), LLM, Post-process (Verifier), Response + Logging. Кожен блок з унікальним ID ([S1], [A1], [R1], [RR], [C1], [L1], [P1] тощо). Паралельні гілки — через `|----->`. Тільки ASCII: `|`, `v`, `->`, `[ ]`, `( )`.
   - **Offline plane (DocListDB):** від [T0] Cron до [O1] R2 state/locks/runs: Rada Feeds, Fetch Card JSON, Normalize + Compare Qdrant, Embeddings (OpenRouter 768d), Upsert Qdrant (legislation-catalog-index), State/Locks/Run reports R2. Кожен крок — окремий блок з ID ([D1], [D2], [N1], [E1], [V1], [O1]).
   - **Offline plane (LLDBI):** окрема коротка карта або підблок: canonical build → R2 → Qdrant (lexery_legislation_acts/chunks) + Supabase.
   Дотримуйся правил з розділу «Як будувати матриці та алгоритмічні ланцюжки»: один блок — один рядок з ID, напрямок зверху вниз, без Unicode, без об’єднання різних компонентів в один бокс.

   **Матриця блоків:**  
   Твоя відповідь **обов’язково** містить **повну** таблицю блоків:
   - **Один рядок = один блок з block-chain map.** Якщо на карті 15 блоків (Online) + 7 блоків (Offline DocListDB) + 4 блоки (Offline LLDBI) — в матриці має бути 26 рядків (або дві окремі таблиці: Online і Offline, але в кожній — по одному рядку на кожен блок). **ЗАБОРОНЕНО:** спрощувати, об’єднувати кілька блоків в один рядок, виводити «приклад кількох рядків», замінювати рядки на «тощо» або «інші компоненти».
   - **Усі колонки заповнені** для кожного рядка: Block ID | Purpose | Inputs | Outputs | Storage side-effects | Dependencies | Secrets | Failure modes | Retries/Timeouts | Observability | Test hooks. Не залишай порожніх клітинок; якщо значення немає в документі — пиши явно «не описані в документі» або «немає (stateless)». Для блоків з репо підставляй конкретику з контексту: шляхи (R2 prefix, Qdrant collection), env vars (QDRANT_API_KEY, OPEN_ROUTER_API_RAG), таймаути (60000 ms), механізми (retrieve+scroll, lock TTL, exit code 0).
   - **Конкретні значення:** без «наприклад», «тощо», «TBD» у клітинках матриці (окрім явного «TBD: [що вирішити]»). Результат має бути придатний для прямого використання як архітектурний документ — по ньому можна перевіряти реалізацію і онбордити розробників.
   Якщо обмеження довжини відповіді не дозволяє вмістити повну матрицю в один блок — виведи її в окремому підрозділі «Appendix: Full Block Matrix» частинами (спочатку всі Online, потім всі Offline) і заповни **кожен** рядок і **кожну** колонку.

**Формат відповіді:**  
Markdown з розділами: 1) Context briefing, 2) **Block-chain map(s)** (повні ASCII-діаграми Online і Offline), 3) **Матриця блоків** (повна таблиця, один рядок на блок, усі колонки заповнені), 4) Findings, 5) Options, 6) Recommendation (з планом кроків), 7) Checklist, 8) Відповідність DoD (коротко). Використовуй нумерацію та підзаголовки для швидкого сканування. Карта і матриця — не опційні, а обов’язкові частини виводу; без них архітектура вважається неповною.

---

Кінець промпт для Deep Research
