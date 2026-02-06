# **Архітектура мікросервісу Lexery Legal AI Agent**

## **Основні компоненти та огляд системи**

**Lexery Legal AI Agent** – це окремий мікросервіс, що приймає запити від фронтенду (через бекенд) і самостійно виконує всі етапи обробки запитів. Бекенд передає лише метадані (ідентифікатор користувача, перевірки доступу, налаштування чату, прикріплені файли тощо), а сам мікросервіс опікується логікою роботи, пошуком інформації та генерацією відповіді. Система включає такі ключові блоки:

- **Gateway (API-інтерфейс запитів)** – отримує запит користувача, перевіряє права доступу та ліміти (за планом користувача), передає у внутрішню чергу на обробку.
- **Memory Manager (Менеджер пам’яті)** – зберігає історію розмови та контекст, забезпечує «розумну пам’ять» для конкретного користувача, і загалом. (тобто те що стосується суто клієнта - зберігається в памяті суто клієнта, правильно структурується і тд, а коли Ai внаслідок довгих роздумів і виконання складної задачі приходить до якогось виснову X правовідносини = Y акту, то вона це записує в свою загальну память. (семантичне та тривале зберігання важливих фактів, автопідвантаження контексту). Використовує як векторний пошук (наприклад, Qdrant), так і символьні резервні сховища (Supabase/PostgreSQL) для метаданих. Пам’ять структурована по користувачу і по «проектах/справах» (memory spaces), що дозволяє ізолювати контексти різних справ. Наприклад, концепція Cortex (Cursor) пропонує **гнучку пам’ять зі семантичним пошуком** та механізмами версіювання контексту, що ідеально підходить для наших завдань. Менеджер пам’яті відповідає за чистку зайвого контексту (ігнорування нерелевантних повідомлень), стиск (генерація сумарних описів) та відновлення/передавання контексту при необхідності (наприклад, при продовженні розмови чи переході до нової теми).
- **Retrieval Engine (Движок пошуку інформації)** – відпо­відає за збір релевантних документів і фрагментів перед тим, як формувати відповідь. Складається з двох основних джерел інформації:
    - **LLDBI (Lexery Legislation DB)** – наша законодавча база (Supabase + R2 + Qdrant), де зберігаються повні тексти актів (у R2) та їх векторні репрезентації (Qdrant, дві колекції: *acts* та *chunks*). Для кожного запиту створюється ембедінг (OpenAI text-embedding-3-small, 1536 вимірів) і виконується пошук схожих фрагментів у цій базі. Система може фільтрувати по номеру акту або статті та ранжувати результати. За необхідності Qdrant повертає посилання на JSON-структури у R2 (через ключ **`r2_key`** і **`json_path`**), звідки довантажуються тексти. Такий Retrieval-Augmented Generation (RAG) підхід довів свою ефективність у легальних системах.
    - **DocListDB (Каталог актів)** – допоміжна база даних метаданих (записи про акти, їх назви і картки), індексована окремо (векторні ембедінги 768 вимірів). Якщо стандартний пошук по текстах недостатньо релевантний, компонент робить запит до цього сервісу, доповнюючи запит синонімами та розширеннями. Наприклад, використовується LLM для генерування синонімів ключових слів чи фраз, а потім ще один векторний пошук по *legislation-catalog-index*. Результати додатково ранжуються (за потреби LLM-ом) і підтягуються повні тексти з LLDBI для подальшого аналізу. Важливо: ця колекція векторів не поєднана з основною (різні виміри), тож ми спочатку запитуємо її, а потім – при потребі – LLDBI.
- **LLM Orchestrator (Координатор моделей і генерації)** – відповідає за виклик великих мовних моделей для формування відповіді. Має кілька завдань:
    1. **Обробка запиту**: перший крок – аналізує питання користувача (можливо, розбиває складне питання на підзадачі, як у «agentic retrieval» підходах) і формує запити до системи пам’яті та BД.
    2. **Збір контексту**: отримавши з Memory Manager та Retrieval Engine релевантні факти, тексти законів чи попередні повідомлення, будує prompt для LLM. Заклик включає системні інструкції (дотримання правового стилю, вказівки щодо форми відповіді), сам запит і вибраний контекст (витримки з актів, резюме з пам’яті).
    3. **Генерація відповіді**: залучає одну або декілька моделей (див. нижче «Менеджер моделей»). Можливо використання multi-pass: спочатку згенерувати чорнетку відповіді, потім «самоконтроль» чи уточнення, чи знаходяться всі потрібні норми (агент може сам сказати «мені потрібні ще документи», спрацює ще один пошук), і вже остаточний LLM-ви­від.
    4. **Пост-обробка**: після отримання чернетки виконується перевірка формату відповіді, виділення чи форматування посилань на закони, мовні корекції тощо. Можлива додаткова верифікація (наприклад, окремим запитом до RAG перевірити вказані факти).
- **Менеджер моделей і тарифів** – логіка вибору оптимальної моделі залежно від плану/ліміту користувача. Наприклад, якщо ліміт залишається достатнім, використовуємо флагманські моделі (GPT-4 через Azure OpenAI, Anthropic Claude Advanced тощо) для максимальної якості. Якщо наближаємося до ліміту (наприклад, $5 або $10 план), підміняємо моделі на дешевші (GPT-3.5 Turbo, Google Flan-UL2, локальні LLaMA/Mistral) згідно з політикою. Така автоматична зміна моделей заощаджує кошти і підтримує плавний досвід (аналог «Cursor auto mode»). Підхід гібридного маршруту (keyword + semantic) рекомендований Azure як оптимальний для RAG.

Модельний стек може включати:

- **LLM для генерації**: GPT-4 Turbo або GPT-4 (Azure), GPT-3.5 Turbo, Anthropic Claude 3/4 (за можливості), Google PaLM/Flan, локальні моделі LLaMA 2/3, Mistral, Llama.cpp для швидких відповідей. Оптимізація: дорогі моделі – лише у критичних випадках.
- **EMBEDDING-моделі**: OpenAI text-embedding-3-small (1536 вимірів) для LLDBI, та text-embedding-3-small із нижчим конфігом (768) для DocList. За потреби можна використовувати свої моделі (HuggingFace sentence-transformers) або Azure Cognitive search embedding.

Важливою складовою є **гібридний пошук**: як зазначає Microsoft, використання ключових слів та векторної релевантності підвищує точність пошуку. Тобто ми поєднуємо семантичний запит (через embeddings + Qdrant) з ключовим пошуком (наприклад, через додаткові фільтри чи key-terms).

## **Менеджер пам’яті (Memory Manager)**

Менеджер пам’яті відповідає за обробку всього попереднього контексту бесіди та знань. Функції:

- **Довготривале зберігання важливого** – кожна пара «запит–відповідь» аналізується і при необхідності заноситься у сховище пам’яті (наприклад, Qdrant). Там же зберігаються витягнуті факти/контексти: можна робити фактові флеш-карти (LLM-вибірки) чи просто фрагменти. Це схоже на «flexible memory» – запам’ятовуємо будь-що без фіксованих схем, з можливістю семантичного пошуку пізніше.
- **Контекстна конденсація** – коли переписка стає великою, система періодично зумовлює LLM стиснути попередні повідомлення у коротке резюме і зберегти його. Це знижує витрату токенів.
- **Семантичний пошук у пам’яті** – при новому запиті менеджер робить запит у векторну пам’ять, щоб знайти схожі попередні питання/факти (наприклад, «що ми вже обговорювали про X»). Якщо є релевантні конверсейшн-чатики або збережені факти, вони додаються до контексту відповіді. Так само це «семантичний пошук з многостратегією» (Semantic Search with multi-strategy): крім векторних ембедінгів, можна застосувати ключові слова з основного діалогу.
- **Автоматичне відновлення контексту** – при новому з’єднанні або переносі між пристроями, сервіс може за ідентифікатором підвантажувати історію (розмовний контекст) з бази.
- **Очищення** – наприклад, якщо користувач переходить до нової теми чи створює нову «справу», старий контекст може архівуватися. Так зберігається лише доречна інформація. Ізоляція пам’яті за користувачем/справою унеможливлює «перетік» фактів між різними чатами.

Таким чином реалізовується «розумна пам’ять»: гнучка, семантично пошукова система, що автоматично вирішує, що і як зберігати. Подібно до Cortex/Cursor, забезпечується нативна підтримка багатотенантності й історії змін.

## **Пошук за легальними базами та каталогом**

**1. LLDBI (Legislation DB)**. Цей компонент відповідає за пошук норм і фрагментів у повних текстах законів. При надходженні запиту він формує ембедінг (1536-D) і виконує:

- Пошук у **lexery_legislation_chunks** (зберігаються фрагменти текстів) за cosine-подібністю. Можливі додаткові фільтри по category, document_type тощо.
- Якщо запит явно містить номер статті або акту, це враховується (збільшується ваговість результатів з відповідними payload-атрибутами).
- Отримуємо список релевантних чанків (йдуть у відповідь LLM), плюс з Qdrant payload витягуються **`r2_key`** і **`json_path`** для повного контексту тексту з R2 (canonical JSON).
- **Наприклад:** запит “Які права має найманий робітник згідно з КЗпП” може привести до пошуку схожих статей КЗпП у Qdrant. Потім LLM отримає витримки з цих статей, щоб сформулювати відповідь.

Зауважимо, що цей RAG-процес підтверджений практикою: юридичні системи (як Harvey) використовують спеціалізовані векторні БД для RAG по юридичних текстах. Витягуємо лише найрелевантніше, щоб не перевантажувати LLM непотрібним сміттям (Azure радить повертати лише найбільш релевантні фрагменти).

**2. DocListDB (Act Catalog Resolver)**. Якщо за першим пошуком контексту виявилось недостатньо або треба знайти додатковий нормативний акт, запускається пошук по каталогу метаданих. Спочатку LLM-ом чи спеціальним алгоритмом розширюємо запит (збираємо синоніми ключових слів, юридичну термінологію). Потім відправляємо цей розширений запит до Act Catalog Resolver (постороннього сервісу, який робить векторний пошук по *legislation-catalog-index*). Отримані назви та ключі документів дозволяють визначити, які нові акти варто завантажити/довантажити з LLDBI. Після цього ці акти шукаються знову через LLDBI (або прямо туди зберігаються нові). Додатково можна при необхідності застосувати повторний ранжування (re-ranker) на основі LLM.

**Гібридний підхід:** як рекомендує Microsoft, для збільшення точності комбінуємо «ключевий + векторний» пошук. У нашій реалізації це може означати: спочатку векторний пошук знаходить кандидати, а потім фільтрація/ререйтинг за ключовими збігами або навпаки – запит LLM генерує точні ключові фрази (ключові слова), які ми додаємо до ембедінгу-пошуку.

## **Підбір моделей та контроль лімітів**

Менеджер моделей враховує **план користувача** та спожиті ресурси:

- **Стратегія «грубої економії»**: при низькому використанні API або високому плані (Premium) віддаємо перевагу GPT-4 чи Claude Opus для максимально якісних і детальних відповідей. Коли обсяг спожитого дедалі більший або користувач на обмеженому плані ($5–$10/міс.), автоматично переключаємось на швидші/дешевші моделі (GPT-3.5 Turbo, Google Flan T5, локальні LLaMA2). При цьому алгоритмічно мінімізується втрата якості: наприклад, для довгих навчальних запитів можна перше формулювання отримати на потужних, а короткі уточнення – на швидших.
- **Адаптивне кодування**: можна використовувати різний рівень деталізації відповіді (якість LLM) залежно від жорсткості ліміту. Наприклад, план $30 дозволяє уточнення з розгалуженим reasoning, а $5 — видачу ключової інформації лаконічніше.
- **Моніторинг**: Система відслідковує поточне використання (затрачені токени/запити, в грошовому еквіваленті). Якщо користувач «виїдає» ліміт надто швидко, модельний менеджер негайно переводить запити на дешевші backends (словно «маяк» про економію). Цей механізм нагадує підхід Cursor Auto Mode: система сама слідкує за баланcом якості і витрат, плавно переключаючись між моделями.

## **Інтеграція та інфраструктура (розгортання)**

- **Розробка локально**: архітектуру кодуємо і тестуємо на локальній машині (Node.js/TypeScript, Python). Для векторного пошуку використовуємо Qdrant (можна піднімати Docker-контейнер або SaaS). Supabase залишається основою даних (LegislationDocuments, import_jobs тощо). Автоматичні скрипти імпорту LLDBI та DocListDB продовжують працювати без змін.
- **Хостинг на Azure**: після тестування переносимо мікросервіс на Azure. Варіанти:
    - **Azure App Service/Functions або Docker-контейнери на Kubernetes** для самого агент-сервісу.
    - **Azure OpenAI** для доступу до GPT-4/GPT-3.5 (використовуємо ключі Azure OpenAI, якщо замість OpenAI API).
    - **Azure Cognitive Search** може замінити частину Qdrant (але ми вже маємо Qdrant – можемо розгорнути Qdrant Enterprise на Azure).
    - **Azure Blob Storage** замість R2 (як бакет для зберігання JSON актів). Секрети зберігаються у Key Vault (аналог env змінних).
    - **Azure Functions** можуть забезпечити Act Catalog Resolver та синхронізацію з Rada (щоб оновлювати DocListDB).
- **Сервісна взаємодія**: бекенд продукту після релізу викликатиме API цього мікросервісу, передаючи тільки ID користувача, запит та метадані. Агент відповідає структурованим об’єктом (відповідь користувачу, оновлені ліміти/баланси).

## **Сценарії роботи**

- **Типовий запит «питання-відповідь»**: користувач формулює запит. Система бере context з пам’яті (якщо є), формує ембедінг-запит і шукає ключові документи в LLDBI. Потім LLM генерує відповідь на основі знайденого контенту. Якщо LLM вирішує, що має недостатньо даних (наприклад, немає ключової норми), він може повторно запросити пошук (або ми автоматично запускатимемо додаткове RAG за ключовими словами з відповіді). Нарешті відповідь повертається користувачу і зберігається у пам’яті.
- **Сценарій «мало даних – активуємо DocListDB»**: якщо перший RAG-прохід дав мало результатів або релевантність низька, агент генерує уточнюючий запит з більш широкими синонімами і посилає його до Act Catalog. Знайдені акти підвантажуються і додаються в контекст, після чого LLM перегенерує відповідь.
- **Довге дослідження/робота над документом**: якщо користувач надсилає великий документ (документ чи декілька актів), спочатку застосовується модуль парсингу. Він конвертує файл у текст (наприклад, pdf→text, ділить на частини), створює ембедінги й додає в локальний контекст (можливо, через LLDBI). Потім агент аналізує зміст і формує висновки. Така обробка може відбуватися «пізніше» (за словами замовника) – але архітектура вже готова для додавання Document Parser.
- **Мультимовна підтримка**: основна мова – українська, але LLM може працювати і з англійською. Запити українською обробляються стандартно. Якщо в тексті зустрічаються англійські юридичні терміни чи цілий англомовний документ (рідко, 1 раз із 1000), система або викликає відповідну модель (GPT-4 чудово працює з багатьма мовами) або попередньо перекладає тексти для коректного пошуку у базі.
- **Перевірка консистентності**: після генерації можна запустити внутрішній «QA-чан» – наприклад, переслати відповідь LLM знову у QA-систему, щоб перевірити, чи дотримано усі деталі запиту і чи формулювання правильні.
- **Оновлення пам’яті**: кожну кінцеву відповідь/резюме та знайдені норми агент додає до пам’яті. Якщо в пам’яті не було потрібної норми, тепер він її «згадує» назавжди.

## **Висновок**

Таким чином, архітектура Lexery Legal AI Agent має модульну побудову: гейтвей запросів → пам’ять та історія → RAG-пошук у спеціалізованих БД → генерація LLM → валідація/пост-обробка. Такий підхід відповідає кращим практикам “enterprise-grade RAG” у юридичній сфері. Модельний менеджер і механізм пам’яті забезпечують гнучкість, а продумана система запитів і fallback-ланок гарантує релевантність і точність відповідей. Усе це розгорнуто як окремий сервіс (microservice) із чітким API для подальшої інтеграції в продукт і масштабування на Azure.

---

## Документ: Azure Host + Gateway (API) для LEXERY Brain

### 0) Чи “влізе” Brain у free-план Azure (суто робота сервісу)

Є два практичні варіанти, які **реально можуть працювати майже безкоштовно** для закритої beta, якщо трафік невеликий (а в beta він зазвичай невеликий):

### ВАРІАНТ A — Azure Container Apps (Consumption)

- **Free grant щомісяця**: **180,000 vCPU-seconds**, **360,000 GiB-seconds**, **2 млн requests** на підписку.
- Критично: ставимо **min replicas = 0** (scale-to-zero), тоді платите/споживаєте тільки коли є запити.

**Груба оцінка:**

якщо один запит “тримає” контейнер активно ~20 секунд і ви виділяєте 0.5 vCPU / 1 GiB:

- 1 запит ≈ 10 vCPU-s і 20 GiB-s
- free grant 180k vCPU-s ≈ 18,000 таких “20-секундних” запитів на місяць (дуже грубо)
    
    У beta ви зазвичай далеко нижче цього.
    

### ВАРІАНТ B — Azure Functions (Consumption)

- **Free grant щомісяця**: **1 млн requests** + **400,000 GB-s**.
- Плюси: ідеально як **легкий Gateway**. Мінуси: довгі стріми/довгі задачі менш зручні, ніж у Container Apps.

### Azure “Free account” нюанс

Якщо ви **новий клієнт**, Azure дає **$200 кредиту на 30 днів** + набір безкоштовних сервісів на 12 місяців і “always free” квоти.

Для вас це означає: у beta ви точно “проскочите”, а далі вже буде pay-as-you-go, але все одно з free-grant на Container Apps/Functions.

### Про Azure API Management

APIM — класна штука як “професійний” gateway, але для безкоштовного beta можна обійтись без нього. У APIM Consumption є “included” діапазон до 1M API operations на підписку (в прайсі це показано як включені 0–1M).

Я би **не робив ставку на APIM** у перший тиждень beta: зайва складність. Краще — простий gateway в Container Apps/Functions, а APIM додати, коли вже буде прод-бекенд і реальні вимоги.

---

## 1) Рекомендована Azure-топологія саме для Brain (beta → prod)

### 1.1 Beta-мінімум (щоб влізти в free grant і швидко стартанути)

- **Azure Container Apps (Consumption)**: один застосунок `lexery-brain`
    - містить **Gateway + Orchestrator** в одному сервісі (поки що)
    - ingress: HTTPS
    - min replicas: 0
- Secrets: **Container Apps secrets** (поки)
- Logs: стандартні Container Apps logs (поки)

Це майже завжди достатньо для закритої beta, де мало юзерів.

### 1.2 “Нормальна” прод-архітектура (додається поступово)

- **Gateway** (public) → **Orchestrator** (internal) → **Workers** (async jobs)
- Queue: **Azure Service Bus** (довгі імпорти, doc-review, long research)
- Secrets: **Azure Key Vault**
- Observability: **Application Insights + Log Analytics**
- Security: private networking / allowlist бекенду

---

# 2) Gateway (API) — призначення і строгі правила

## 2.1 Роль Gateway

Gateway — це “передня дверка” Brain. Він:

1. **приймає** запит лише від продуктового бекенду (або через підписаний токен),
2. **валідує** формат/ліміти/ідемпотентність,
3. **виділяє бюджет** на ран (залежно від плану),
4. **створює Run** (з correlation id),
5. **передає** його в Orchestrator (inline або через queue),
6. **стрімить** події користувачу (через бекенд або напряму, залежно від вашої схеми).

> Важливо: Gateway НЕ робить “інтелект”. Він не пише відповіді. Він лише керує запитом і запуском пайплайна.
> 

---

## 2.2 Вхідні дані (що Gateway отримує від продуктового бекенду)

### A) Auth / Access envelope

- `Authorization`: JWT або HMAC-signed token (видає ваш Product Backend)
- `X-Request-Id`: correlation id від бекенду (або генерується gateway)
- `Idempotency-Key`: щоб повторний retry від фронта/бекенду не створив 2 run-и

### B) User routing metadata

- `user_id` (обов’язково)
- `tenant_id` / `workspace_id` (якщо є multi-tenant)
- `chat_id` (поточний чат)
- `project_id` або `folder_id` (для “памʼяті проєктів” — **передається тільки ідентифікатор**)

### C) Limits / Plan (must-have)

Backend **вже вирішив**, що користувач може працювати, і передає:

- `plan_tier`: `beta5 | beta10 | beta30 | internal`
- `monthly_budget_usd_remaining`
- `hard_limits`:
    - `max_cost_per_run_usd`
    - `max_runs_per_day`
    - `web_allowed` (true/false)
    - `deep_allowed` (true/false)
    - `max_imports_per_day`
- `policy_flags`:
    - `citations_required` (true/false)
    - `privacy_mode` (PII masking strict)
    - `store_memory` allowed/disabled (інколи потрібне)

### D) Chat settings

- `language`: `uk` (default), `en` optional
- `verbosity`: `short/standard/long`
- `answer_style`: `memo | checklist | step-by-step | contract-draft | qa`
- `jurisdiction`: `UA` (default)

### E) User input payload

- `message`: текст користувача
- `attachments[]`: **не файл**, а *вказівник*:
    - `file_id`
    - `mime_type`
    - `size_bytes`
    - `sha256`
    - `download_url` (тимчасовий signed URL) **або** “backend will proxy file bytes”
    - `ingestion_hint` (pdf/word/text/image)
- `client_context` (опційно): device, locale, timezone

---

## 2.3 Вихідні дані Gateway (що повертає одразу)

Gateway робить “fast ack”, щоб UI не чекав:

- `run_id`
- `status`: `queued | running`
- `stream_url` (якщо Brain стрімить напряму)
- `estimated_mode`: `standard | saver | deep` (попередній роутинг)
- `budget_reserved_usd` (опційно)

---

# 3) Що Gateway робить всередині (детальний ланцюг)

## 3.1 Валідації (must-have)

1. **Auth validation**
    - перевірити підпис токена
    - перевірити issuer = ваш бекенд
    - перевірити audience = lexery-brain
2. **Schema validation**
    - message не пустий, не > N символів
    - attachments не > M штук, кожен < max size
3. **Idempotency**
    - якщо `Idempotency-Key` уже бачили → повернути попередній `run_id`
4. **Rate limiting**
    - per user / per tenant
5. **Budget check**
    - якщо `monthly_budget_remaining <= 0` → повернути “budget exhausted policy response”
6. **Run budget reservation**
    - резервуємо `max_cost_per_run_usd` або менше (залежно від залишку)
    - фіксуємо це в “run ledger” (щоб пайплайн не вилетів за бюджет)

## 3.2 Run record (що створюється Gateway)

`RunRecord` мінімум:

- `run_id`
- `user_id`, `chat_id`, `project_id`
- `created_at`
- `mode`: standard/saver/deep (попередньо)
- `limits_snapshot`: копія лімітів на момент запуску (важливо для відтворюваності)
- `status`: queued/running/completed/failed
- `trace_pointer` (де логи/події)

**Де зберігати RunRecord у beta?**

Можна прямо в Supabase (швидше інтегрувати), а вже потім перенести в Azure storage/cosmos.

## 3.3 Передача далі

Gateway формує `RunEnvelope` і передає у:

- **inline Orchestrator** (для коротких задач)
- або **Service Bus queue** `brain-runs` (для long tasks, imports, research)

**Правило:** якщо прогнозована тривалість > X секунд або є attachments → відправляємо у queue.

---

# 4) Стрімінг (щоб “вау” і контроль)

Gateway/Orchestrator має стрімити події типу:

- `state`: “classify”, “cache_retrieve”, “doclist_resolve”, “import”, “write”, “verify”
- `progress`: % або “step i/n”
- `cost_so_far_usd`
- `citations_count`
- `need_user_clarification` (якщо зупинилися)

---

# 5) Безпека (мінімум для beta, без параної)

**Beta-min security:**

- Brain endpoint приймає запити тільки з:
    - allowlist IP бекенду **або**
    - тільки з валідним signed JWT
- PII logs: за замовчуванням “redact”, не логити raw attachments
- Timeout + max body size

**Prod security (пізніше):**

- Private networking (VNet), APIM, mTLS, WAF

---

# 6) Алгоритмічний ланцюжок у форматі “коду” (діаграма + псевдоалгоритм)

```
                       (Azure)
┌────────────────┐      HTTPS       ┌─────────────────────────────┐
│ Frontend (UI)  │ ───────────────► │ Product Backend (future)     │
└────────────────┘                  │ - auth, plans, files         │
                                    │ - issues signed JWT          │
                                    └─────────────┬───────────────┘
                                                  │  RunCreateRequest
                                                  │  + limits snapshot
                                                  ▼
                                     ┌─────────────────────────────┐
                                     │ LEXERY Brain Gateway (API)   │
                                     │ (Container Apps OR Functions)│
                                     ├─────────────────────────────┤
                                     │ 1) verify JWT / allowlist    │
                                     │ 2) schema validate           │
                                     │ 3) idempotency check         │
                                     │ 4) rate limit                │
                                     │ 5) reserve budget            │
                                     │ 6) create RunRecord          │
                                     └─────────────┬───────────────┘
                                                   │
                          short run (inline)       │        long run (async)
                          ┌─────────────────────────┘        ┌─────────────────────────┐
                          ▼                                  ▼
              ┌─────────────────────┐            ┌─────────────────────────────┐
              │ Orchestrator (sync) │            │ Service Bus Queue: brain-runs│
              └─────────────────────┘            └─────────────┬───────────────┘
                                                               ▼
                                                   ┌─────────────────────────┐
                                                   │ Orchestrator (worker)   │
                                                   └─────────────────────────┘

Streaming back:
Gateway/Orchestrator  ── SSE/WebSocket ──► Backend/UI

```

```
function POST /v1/runs(req):
  assert verify_auth(req.Authorization)
  validate_schema(req.body)
  rid = req.headers["X-Request-Id"] ?? new_uuid()
  idem = req.headers["Idempotency-Key"]

  if run_exists(idem):
    return 200 { run_id: existing_run_id, status: existing_status }

  enforce_rate_limit(user_id)
  if req.limits.monthly_budget_remaining <= 0:
    return 402 { error: "budget_exhausted", next_steps: "upgrade / wait" }

  run_budget = min(req.limits.max_cost_per_run_usd, req.limits.monthly_budget_remaining)
  run_id = new_run_id()

  store RunRecord(run_id, user_id, chat_id, project_id, limits_snapshot, run_budget)

  mode = pre_route_mode(req)  // standard/saver/deep (preliminary)
  if likely_long(req):        // attachments OR expected > X sec
     enqueue(ServiceBus, "brain-runs", {run_id, rid})
     return 202 { run_id, status: "queued", mode, stream: "/v1/runs/{run_id}/events" }
  else:
     start_orchestrator_inline(run_id)
     return 202 { run_id, status: "running", mode, stream: "/v1/runs/{run_id}/events" }

```

---

## 7) Висновок для цього етапу

- **Так**, Brain (суто compute) **може вміститись у free-grant Azure** на Container Apps або Functions для закритої beta, якщо:
    - `min replicas = 0`
    - ви не тримаєте “always-on” дорогі штуки
    - трафік невеликий
        
        (Free-grant цифри: Container Apps: 180k vCPU-s + 360k GiB-s + 2M requests ; Functions: 1M requests + 400k GB-s )
        

---

## Memory Manager для LEXERY Brain — цілі та принципи

### Цілі (must)

1. **Контекст без повторів**: юрист не пояснює заново те, що вже сказав у цьому чаті/справі.
2. **Ізоляція справ/проєктів**: памʼять “справа А” не протікає в “справу Б”.
3. **Керований контекст**: не забиваємо вікно моделі; є алгоритм packing’у.
4. **Відтворюваність**: будь-яку відповідь можна пояснити: “який контекст був підставлений”.
5. **Безпека/конфіденційність**: юристи принесуть кейси з ПД/комерційною таємницею — памʼять не повинна робити “сюрпризів”.
6. **MVP-WOW**: “памʼятає справу”, “перемикає справи”, “запамʼятовує стиль/уподобання”, “пропонує зберегти важливий факт” (1-клік).

### Не-цілі (для beta)

- “Глобальна колективна памʼять” між різними користувачами **за замовчуванням вимкнена** (ризик витоку/юридичні ризики). В бета — максимум **opt-in бібліотека шаблонів/плейбуків** без персональних фактів.
- Повний “Cursor-level” long-horizon memory з deep semantic recall по всіх історіях — **поступово**, через фіче-флаги.

---

## 1) Високорівнева архітектура (сховище + модулі)

### 1.1 Сховище (твій реалістичний стек під beta)

- **Supabase Postgres (Free 500MB)** — “джерело правди” для:
    - профілів/налаштувань
    - справ/чатів
    - метаданих повідомлень
    - дайджестів/саммарі
    - “memory items” (довготривалі факти/нотатки/уподобання)
- **Cloudflare R2** — великі тексти:
    - повні “assistant answers” якщо великі
    - вкладення юристів (pdf/docx)
    - архіви/експорти історії
- **Qdrant** — семантичний пошук по памʼяті (опційно на старті, але архітектурно закладено):
    - embeddings для memory items / summaries / (опційно) messages

> Про 500MB: для закритого тесту 20–50 юристів це зазвичай ок, особливо якщо **offload великих повідомлень в R2**. Supabase Free “500MB database” згадується в описах планів.
> 

### 1.2 Memory Manager як модуль Brain

Memory Manager — **внутрішній компонент** Orchestrator’а (або окремий internal service в рамках brain), який надає:

- **Memory Read API**: зібрати контекст для конкретного run
- **Memory Write API**: записати повідомлення/дайджест/оновлення профілю
- **Background Jobs**: сумаризація, витяг фактів, індексація в Qdrant, cleanup

---

## 2) Таксономія памʼяті (що саме ми “памʼятаємо”)

### 2.1 Рівні (scopes)

1. **Session/Conversation memory** (в межах чату)
2. **Case/Project memory** (в межах справи/папки)
3. **User memory** (персональні налаштування, стиль, довготривалі нотатки)
4. **Team/Global memory** (лише opt-in, тільки “шаблони/плейбуки” без кейс-фактів)

### 2.2 Типи обʼєктів памʼяті

- **UserProfile**: мова/стиль/рівень/спеціалізація/формат цитувань.
- **CaseDigest** (WOW): “короткий бриф справи” + open questions + ключові акти.
- **ConversationSummary**: rolling summaries сегментів розмови.
- **MemoryItem** (довготривале):
    - preference (коротко/структуровано, стиль)
    - stable fact (контрагенти, роль, ціль консультації) — **тільки з підтвердженням**
    - case fact (дати/суми/події) — **з підтвердженням**
    - glossary (визначення термінів у цьому кейсі)
    - constraints (обмеження/ризики/вимоги)
- **AttachmentIndex**: метадані та результати парсингу файлів (але сам файл — в R2)

---

## 3) Схема даних (логічна, без SQL-коду)

> Ключова вимога: **Supabase — тільки “контрольні записи + індекси + маленькі тексти”**. Великі тексти → R2. Семантика → Qdrant.
> 

### 3.1 Таблиці (Supabase)

### `mm_users`

- user_id
- created_at
- status (active/blocked)
- default_language (uk/en)
- privacy_mode (strict/standard)

### `mm_user_profile`

- user_id (PK)
- specialization (array)
- experience_level
- response_prefs: citation_style, detail_level, format, tone
- auto_detected_signals (легкі сигнали без приватних кейсів)

### `mm_cases`

- case_id (PK)
- user_id
- title, type (litigation/contract/research/consultation)
- status (active/archived)
- **case_digest_current** (короткий текст 1–2KB)
- **case_digest_struct** (JSON: parties[], key_dates[], issues[], acts[])
- last_activity_at

### `mm_conversations`

- conversation_id (PK)
- user_id
- case_id nullable (null = general)
- title
- last_message_at
- message_count
- **rolling_summary_current** (короткий текст)
- **rolling_summary_struct** (JSON: facts/open_questions/decisions/acts)

### `mm_messages`

- message_id (PK)
- conversation_id
- role (user/assistant/system)
- content_inline (TEXT, **тільки якщо малий**)
- content_r2_key (nullable)
- content_excerpt (для швидкого перегляду/FTS)
- token_count_est
- created_at
- metadata_json (model_used, cost_usd, retrieval_refs, safety flags)

### `mm_summaries`

- summary_id (PK)
- conversation_id
- range_start_message_id / range_end_message_id
- summary_text (TEXT, 1–3KB)
- summary_struct (JSON)
- embedding_ref (optional pointer to Qdrant point id)
- created_at

### `mm_memory_items`

- item_id (PK)
- user_id
- scope_type: user|case|conversation
- scope_id (nullable)
- item_type: preference|fact|constraint|glossary|note
- content_text (коротко: 0.2–1KB)
- content_struct (JSON optional)
- status: proposed|confirmed|rejected|expired
- confidence
- sensitivity: public|private|secret
- provenance: source (conversation_id, message_ids, attachment_id)
- embedding_ref (optional)
- created_at / updated_at
- supersedes_item_id (versioning)

### `mm_run_context_snapshots` (відтворюваність)

- run_id (PK)
- conversation_id
- assembled_context_manifest (JSON: які шматки памʼяті були включені)
- token_budget_plan (JSON)
- created_at

### 3.2 R2 (Cloudflare)

- `mm/messages/{conversation_id}/{message_id}.txt` (якщо великий)
- `mm/attachments/{user_id}/{file_id}` (оригінали)
- `mm/archives/{user_id}/{export_id}.jsonl` (експорти)
- (опційно) `mm/summaries/full/{conversation_id}/...` для довгих

### 3.3 Qdrant (одна колекція, НЕ по юзерам)

Колекція: `lexery_memory_semantic_v1` (1536 dims — як у LLDBI chunks, щоб простіше)

Payload фільтри:

- user_id
- scope_type + scope_id
- object_type: message|summary|memory_item|attachment_note
- object_id
- status (for memory_item)
- timestamps, sensitivity

> Важливо: не робити “N колекцій на користувача” — це створить операційний кошмар. Одна колекція + фільтри.
> 

---

## 4) Модулі Memory Manager (внутрішня архітектура)

### 4.1 Core компоненти

1. **Context Assembler (Context Packer)**
    - бере user/case/conversation state
    - додає релевантні memory items
    - додає summaries + recent messages
    - повертає “ContextPack” в рамках token budget
2. **Memory Writer**
    - запис message meta + (опційно) blob в R2
    - фіксує run snapshot (manifest)
    - ставить події в outbox для background tasks
3. **Summarizer**
    - rolling summary для conversation
    - case digest updater (для case chats)
4. **Memory Extractor (Candidates)**
    - витягує “кандидати памʼяті” з розмови (preferences/facts)
    - dedup + conflict detection
    - створює `mm_memory_items` зі статусом **proposed** (WOW: UI “запам’ятати?”)
5. **Semantic Indexer (Qdrant Adapter)**
    - embeddings для memory items / summaries / (опц.) messages
    - graceful fallback якщо Qdrant недоступний
6. **Retention & Cleanup**
    - офлоад старих великих текстів в R2
    - expiry rules
    - архівація completed cases
7. **Privacy & Governance**
    - policy engine: що можна запамʼятовувати без підтвердження
    - redaction правил (PII)
    - delete/export APIs

---

## 5) Алгоритмічний ланцюжок (Run-time) — “як Cursor, але для юриста”

### 5.1 На старті кожного run (перед викликами моделей)

**Вхід:** user_id, conversation_id, case_id?, user_message, plan/limits snapshot

**Кроки (строго):**

1. **Load Minimal State**
- user_profile
- case_digest_current (якщо case_id)
- conversation rolling_summary_current
- last N messages (наприклад 12–20) + їх excerpts
1. **Decide Context Strategy (cheap classifier)**
- тип запиту: quick Q/A vs drafting vs long research vs doc review
- чи треба “memory recall” beyond last N?
- на основі budget: `standard` vs `saver`
1. **Retrieve Memory Items**
- confirmed items в scope user + case + conversation
- якщо потрібно “recall”: semantic search (Qdrant) по summaries/items (і тільки потім messages)
1. **Pack Context**
- збираємо **ContextPack** за токен-бюджетом:
    - Profile (дуже коротко)
    - CaseDigest (коротко)
    - RollingSummary (коротко)
    - Top memory items (5–15)
    - Recent messages (N)
    - Retrieved older nuggets (до 5–10)
- фіксуємо manifest в `mm_run_context_snapshots`
1. **Повертаємо ContextPack Orchestrator’у**

### ContextPack — обовʼязкова структура (щоб не було хаосу)

- `profile_block` (≤ 300–600 токенів)
- `case_block` (≤ 600–1200)
- `conversation_summary_block` (≤ 600–1200)
- `memory_items_block` (≤ 600–1200)
- `recent_messages_block` (≤ 1500–3000)
- `retrieved_history_block` (≤ 600–1200)

> Це і є головна “анти-забивка” контексту: **кожен блок має квоту**.
> 

---

### 5.2 Після відповіді (write path)

1. **Persist Messages**
- user message: content_inline (майже завжди)
- assistant message:
    - якщо короткий → inline
    - якщо довгий (> X символів або > Y KB) → R2 blob + excerpt + pointer
1. **Write Run Metadata**
- cost, model_used, retrieval evidence pointers, safety flags
1. **Emit Outbox Events** (асинхронно)
- maybe_summarize(conversation_id)
- maybe_update_case_digest(case_id)
- maybe_extract_memory_candidates(conversation_id, last_messages_range)
- maybe_index_semantics(object_ids)

---

## 6) Асинхронні ланцюги (Background) — щоб не гальмувати UX

### 6.1 Rolling Summaries (Conversation)

Тригер:

- message_count % K == 0 (наприклад кожні 20–40)
- або якщо recent_messages_block > budget
- або якщо user повернувся через 2–7 днів (“реанімувати контекст”)

Результат:

- `mm_summaries` новий сегмент
- оновлення `mm_conversations.rolling_summary_current` (коротко)
- опційно embeddings summary в Qdrant

### 6.2 Case Digest (WOW)

Тригер:

- кожні N повідомлень у case-conversation
- або коли модель виконала drafting/research
- або коли юрист додав attachment

CaseDigest (короткий):

- “про що справа”
- “які питання”
- “які факти встановлені/спірні”
- “які акти вже використали”
- “які open questions”

Це дає вау: “Продовжимо справу” → AI відповідає як асистент, який реально “веде кейс”.

### 6.3 Memory Candidates (proposed → confirmed)

Тригер:

- коли зʼявилися ознаки:
    - preference (“пиши коротко”, “дай алгоритм”)
    - стабільні факти (роль користувача, предмет кейсу)
    - glossary/terms (“під ‘контрагентом’ маємо на увазі …”)

Політика:

- **Preferences**: можна auto-confirm з високою впевненістю.
- **Case facts**: тільки proposed (потрібен 1-клік confirm).
- **Sensitive facts**: proposed + sensitivity=secret.

UI WOW:

- “Запам’ятати: ви хочете відповіді списком кроків? ✅/❌”
- “Запам’ятати факт для цієї справи: дата звільнення 12.01.2026? ✅/❌”

---

## 7) Моделі (через OpenRouter) — строго по задачах памʼяті

Тут важливо: **Memory Manager використовує LLM не для “правової відповіді”, а для стиснення/структуризації.** Тому:

- low-temp
- structured output (JSON)
- бюджетні моделі за замовчуванням
- Sonnet 4.5 — лише там, де реально треба якість/надійність структури

### 7.1 Рекомендований набір моделей

1. **Classifier / Router (cheap)**
- швидко визначити тип запиту і чи потрібен deep recall
1. **Summarizer (quality/cost balance)**
- для rolling summaries і case digest
- **Claude Sonnet 4.5** — дуже доречно як “головний summarizer”, якщо дозволяє бюджет (він прямо рекомендується Anthropic як баланс).
- якщо треба економити — переключаємо на дешевшу.
1. **Extractor (facts/preferences)**
- витяг “кандидатів пам’яті” з мінімальним галюном
- строгий JSON
1. **Embedding**
- `text-embedding-3-small` (як у вашому LLDBI) для memory semantic index (1536)
- (або інша мультимовна, але краще узгодити з існуючим стеком)

### 7.2 Budget gates (як у Cursor auto mode)

Memory Manager отримує з Gateway: `max_cost_per_run_usd`, `monthly_remaining`.

Правила:

- якщо remaining високий → summaries/extractors працюють “always on”
- якщо remaining низький → summaries рідше, extractor лише на явні тригери, semantic indexing тільки summaries/items (не messages)

---

## 8) “WOW для beta” — що робити зараз (не ламаючи майбутнє)

### MUST WOW (робимо одразу)

1. **Case isolation + CaseDigest**
2. **Resume after days**: conversation rolling summary + “останнє що робили/відкриті питання”
3. **Preferences memory** (авто): стиль відповіді, формат, мова
4. **1-клік memory proposals** (мінімум для фактів у справі)

### Nice-to-have (фіче-флаг)

1. **Semantic recall** через Qdrant по summaries/items (не по всіх messages)

### Потім

1. embeddings для всіх messages
2. глобальні патерни між юзерами (тільки opt-in + анонімізація)

---

## 9) Фейли та фолбеки (щоб “ніде не впертись”)

### 9.1 Qdrant недоступний

- Context Assembler працює тільки з:
    - rolling summary
    - last N messages
    - confirmed memory items з SQL
        
        Функціональність “semantic recall” вимикається автоматично.
        

### 9.2 R2 недоступний

- Assistant великий текст:
    - або тимчасово inline (обрізано до ліміту)
    - або зберегти як “pending upload” і дозалити пізніше
- В UI краще показати попередження “архів тимчасово недоступний”, але не ламати чат.

### 9.3 Summarizer падає/дорого

- Немає summary — не страшно:
    - підставляємо більше recent messages
    - тригеримо summarization пізніше
- Головне: “не блокувати відповідь”.

### 9.4 Дублікати/конкурентні записи

- Idempotency на message write: `client_message_id`/`run_id` unique
- Outbox pattern: події на summarization/extraction пишемо в таблицю `mm_outbox`, воркер обробляє з lock’ом.

### 9.5 Приватність

- За замовчуванням:
    - **нічого не йде в “global memory”**
    - memory proposals для фактів — тільки confirmed з юзером
    - “secret” items ніколи не використовуються поза scope

---

## 10) Алгоритмічна діаграма (стрілки/блоки)

```
User message
   │
   ▼
Orchestrator ───────────────► Memory Manager / Context Assembler
   │                                  │
   │                                  ├─ Load profile (SQL)
   │                                  ├─ Load case_digest + rolling_summary (SQL)
   │                                  ├─ Load last N messages (SQL + R2 pointers)
   │                                  ├─ Load confirmed memory items (SQL)
   │                                  ├─ (optional) semantic recall (Qdrant)
   │                                  └─ ContextPack (token-budgeted) + snapshot
   │
   ▼
LLM pipeline (RAG etc.)
   │
   ▼
Assistant response
   │
   ▼
Memory Writer
   ├─ store message meta (SQL)
   ├─ store big blob (R2) if needed
   ├─ store run manifest (SQL)
   └─ emit outbox events:
        ├─ Summarize segment
        ├─ Update case digest
        ├─ Extract memory candidates (proposed)
        └─ Semantic index (Qdrant)

```

---

## 11) Чи вистачить Supabase Free 500MB саме під памʼять

Коротко: **так, для beta** якщо:

- великі відповіді/вкладення → **R2**
- в SQL — тільки excerpts + summaries + memory items
- cleanup/архівація по давності (навіть проста)

(Твої розрахунки в цілому реалістичні; головний ризик — якщо юристи дуже активні й пишуть довгі long research щодня. Тоді R2-offload вирішує більшість проблем.)

---

## 12) Мінімальний “spec” інтерфейсів Memory Manager (для розробки без блокерів)

### Read

- `get_context(user_id, conversation_id, case_id, query, limits_snapshot) -> ContextPack + Manifest`
- `get_case_digest(case_id) -> CaseDigest`
- `list_memory_items(user_id, scope)`

### Write

- `append_message(conversation_id, role, content, run_id, metadata, blob_pointer?)`
- `confirm_memory_item(item_id)` / `reject_memory_item(item_id)`
- `update_profile(user_id, prefs_patch)`

### Background

- `run_summarization(conversation_id, range)`
- `run_case_digest_update(case_id)`
- `run_memory_extraction(conversation_id, range)`
- `run_semantic_index(object_refs)`
- `retention_cleanup()`

---

## 13) Найважливіше: як це дає “ВАУ” юристам на MVP 2.0

1. **Памʼятає справу**: “продовжимо” → одразу case digest + open questions.
2. **Не плутає справи**: перемикач справ/папок.
3. **Підлаштовується**: стиль відповіді “коротко/алгоритм/з цитуванням” — запамʼятовує.
4. **Питає дозволу запамʼятати факт**: виглядає професійно й безпечно.

---

## 0) Місія Retrieval Engine

**Retrieval Engine = “доказова машина”**. Його єдина ціль: **зібрати Evidence Pack** (структурований набір фрагментів нормативних актів/судової практики/документів користувача), з гарантованим походженням і контрольованою якістю.

### Строгі правила (критично для юридичного домену)

1. **Фінальна відповідь** (Writer) може базуватися **лише** на:
    - canonical-текстах з **R2 (LLDBI)**,
    - (пізніше) canonical-джерелах судової практики (ваш case-law RAG),
    - прикріплених документах користувача (з provenance).
2. **Web-assisted discovery** дозволений **лише** як “сигнал маршрутизації/словник”, **не як доказ**.
3. Retrieval Engine **ніколи не “пояснює право”** — він лише готує матеріали для Reasoner/Writer/Verifier.

---

## 1) Вхід/вихід Retrieval Engine

### Вхід (Request)

- `user_query` (текст)
- `conversation_context` (із Memory Manager): короткий контекст сесії/справи, преференси (стиль, деталізація), важливі факти (якщо є)
- `constraints`:
    - бюджет/план (ліміти $/токени/ітерації)
    - latency target (наприклад: fast <3–6s, deep <30–90s)
    - мова (uk / en)
- `workspace`:
    - `case_id` / `project_id` (ізоляція)
    - список already-pinned acts (акти, які юзер “закріпив” у справі)
- `attachments` (пізніше): файли, витягнуті тексти/таблиці з бекенду

### Вихід (Evidence Pack + Trace)

**EvidencePack**

- `answerability`: {score, missing_aspects[], ambiguity_flags[]}
- `act_candidates`: список актів (LLDBI + DocListDB), з поясненням “чому”
- `evidence_items[]`:
    - `source_type`: legislation | case_law | user_doc
    - `source_id`: (для legislation) `rada_nreg + content_hash` (або інший стабільний ключ)
    - `title`, `jurisdiction`, `validity_status`, `act_date`, `document_type`
    - `extracts[]`: {text, article_number, chunk_id/json_path, relevance_score, citation_stub}
- `recommended_next_steps` (для Planner/Reasoner): що перевірити, які суміжні акти/процедури підтягнути
- **жорстка гарантія**: кожен extract має provenance (R2 key + json_path/чанк)

**RetrievalTrace**

- покроковий лог: які індекси, які запити, які моделі, які пороги, скільки часу/токенів/грошей
- потрібен для білінгу і дебагу “чому агент помилився”

---

## 2) Джерела та індекси (ваш контекст)

### 2.1 LLDBI (основний “cache” законодавства)

- **Qdrant**:
    - `lexery_legislation_chunks` (1536d) — основне місце пошуку норм
    - `lexery_legislation_acts` (1536d) — “акт-індекс” для швидкого підбору актів із cache
- **R2**: canonical JSON `legislation/{category}/{encoded_nreg}.json` (джерело фрагментів)
- **Supabase**: `legislation_documents` (метадані, validity, qdrant_status, aliases/topics/keywords тощо)

### 2.2 DocListDB (каталог/резолвер по всій Rada-базі)

- **Qdrant**: `legislation-catalog-index` (768d)
- **Resolver API**: `POST /catalog/resolve` → кандидати `rada_nreg` (+ rerank optional)
- призначення: “знайди, *який акт взагалі потрібен*, коли LLDBI cache не покриває запит”

> Важливо: **1536d і 768d — різні простори**, їх не змішуємо. Це окремі retriever-и.
> 

### 2.3 (Паралельно/скоро) Supreme Court case law RAG

Retrieval Engine має бути плагінним: додамо `CaseLawRetriever` як ще одне джерело EvidencePack, але з тим самим контрактом provenance.

### 2.4 Web-assisted discovery (fallback)

Не джерело права. Лише:

- витяг термінів/синонімів
- “ймовірні назви актів/порядків/класифікаторів”
- “що за тема/галузь/тип правовідносин”

---

## 3) Компоненти Retrieval Engine (модульна архітектура)

### 3.1 Query Understanding Layer (безпечно, швидко, дешево)

**Модулі:**

1. `IntentClassifier`
    - визначає: Q&A / procedure / drafting / doc-review / research / enforcement path
2. `LegalDomainTagger`
    - галузь: трудове/кримінальне/цивільне/адміністративне/корпоративне/податкове…
3. `Entity & Citation Extractor`
    - витягує: “ст. 115”, “ККУ”, “ЗУ про …”, органи (МВС, ДПС), ролі (поліцейський)
4. `Ambiguity Detector`
    - “мобілізація” → кілька актів; “оскарження дій поліції” → різні процедури

**Вихід:** `QueryProfile` (структура) + `RoutingFlags`.

> Це ключ до “вау”: юрист бачить, що агент *розуміє тип задачі* і *не лізе одразу в хаос*.
> 

---

### 3.2 Legal Navigator (pre-RAG без веба)

Це ваш “каталог-спочатку” шар.

**Функції:**

- `Synonymizer / Query Expander` (юридичні синоніми, скорочення, варіанти назв актів)
- `Hypothesis Builder`: 3–7 гіпотез “які акти можуть регулювати”
- `Plan Builder`: план пошуку:
    1. перевірити cache (LLDBI acts/chunks),
    2. якщо не вистачає — DocListDB,
    3. якщо і там “сміття” — web-assisted discovery,
    4. імпортувати кандидати в LLDBI, повторити chunk-search.

**Вихід:** `SearchPlan` з пріоритетами.

---

### 3.3 Candidate Act Discovery (3 рівні)

**Рівень A — прямі посилання (best path)**

- якщо в запиті є `рада_nreg`, або чітка назва, або “ККУ ст.115” → одразу формується список актів + підняті статті

**Рівень B — LLDBI cache act-index**

- embedding запиту (1536d) → `lexery_legislation_acts` → top-K актів
- фільтри: `validity_status`, `document_type`, `category` (якщо QueryProfile дав підказку)

**Рівень C — DocListDB resolver**

- якщо B не дав актів/або confidence низький → `/catalog/resolve`
- але **перед цим**: агресивна синонімізація + “юридична нормалізація” (щоб DocListDB працював краще)
- результат: 10–50 `rada_nreg` кандидатів (з оцінками)

---

### 3.4 Act Acquisition (імпорт у LLDBI як “підтягування доказів”)

Це міст між DocListDB і LLDBI.

**Модуль: `ActIngestionOrchestrator`**

- отримує список `rada_nreg`
- перевіряє в `legislation_documents`: чи акт уже є (по `rada_nreg`), чи indexed, чи здоровий sync
- якщо нема → ставить задачі імпорту (внутрішня черга / job runner)
- політика:
    - **fast mode**: імпортуємо 1–3 акти (найкращі), решту відкладемо
    - **deep mode**: імпортуємо 5–15 актів партіями

> Важливо для UX: у бета-режимі юрист має відчути “агент сам дістає потрібний акт”.
> 

---

### 3.5 Chunk Retrieval (основний RAG по нормах)

**Модуль: `LegislationChunkRetriever`**

- embedding (1536d) → `lexery_legislation_chunks`
- retrieval strategy:
    - `K1`: широкий забір (наприклад 40–80 chunk hits)
    - `Dedup`: по (act, article_number, chunk_index)
    - `Heuristics Boost`:
        - якщо в запиті “ст. N” → піднімаємо chunk де `article_number == N`
        - якщо запит про процедуру → піднімаємо chunk з “порядок/строк/подання/оскарження”
    - `Filter`: validity, category, doc_type, act_group_key (якщо є)

**Результат:** `RawHits[]` (без текстів) → далі `R2SnippetLoader`.

---

### 3.6 Evidence Assembly (витягуємо canonical фрагменти)

**Модуль: `CanonicalSnippetLoader`**

- для кожного hit бере `r2_key + json_path` (або chunk payload) → дістає точний фрагмент з canonical JSON
- додає:
    - `citation_stub` (акт, стаття, частина/пункт якщо є)
    - `version markers` (content_hash, дата редакції якщо доступно)
- нормалізує текст (без “води”, чистий уривок)

**Результат:** `EvidenceItem.extracts[]`

---

### 3.7 Rerank + Coverage Control (те, чого зараз не вистачає “простому RAG”)

Тут ваша вимога “як Harvey/Cursor: мінімізувати помилки”.

**Модулі:**

1. `CrossEncoderReranker` або `LLM-Reranker`
    - переранжовує extracts відносно запиту + QueryProfile
    - відкидає “сміття” (наприклад про “звітування перед громадськістю” замість “оскарження дій поліції”)
2. `CoverageCritic`
    - перевіряє, чи покриті ключові аспекти запиту:
        - “підстава/норма”
        - “процедура/строки/орган”
        - “наслідки/відповідальність”
3. `QueryRefiner`
    - якщо coverage слабкий: пропонує, *як переформулювати запит до retriever-ів* (синоніми, терміни, інші акти)
4. `StopPolicy`
    - обмеження по ітераціях/часу/бюджету

**Ключ:** retrieval не “падає”, а **сам себе виправляє** 1–2 ітерації.

---

### 3.8 Web-assisted discovery (fallback #3)

Вмикається **лише** коли:

- LLDBI chunks не дали релевантного evidence (нижче порогу)
- DocListDB дає кандидатів, але вони “не про те”
- CoverageCritic каже “бракує контексту: назва документа/класифікатор/постанова/наказ”

**Модуль: `WebNavigator (Router-only)`**

- робить пошук (API провайдера)
- парсить топ-N сторінок
- витягує **лише**:
    - можливі назви актів
    - ключові терміни (словник)
    - “ймовірно регулює: …”
- повертає `WebHints`:
    - `candidate_act_titles[]`
    - `keywords[]`
    - `possible_document_types[]`
    - `procedure_clues[]` (типу “це робиться через … орган” — але без “як істина”)

**Далі:** ці `WebHints` ідуть назад у `QueryRefiner` → DocListDB → Ingestion → LLDBI chunks.

> І принципово: Writer/Final Answer **не бачить веб-уривки**.
> 

---

## 4) Моделі (реальні) + політики вартості

Ви прямо сказали: **Opus 4.5 обережно (дорого)**. Для retrieval-пайплайна нам Opus майже ніколи не потрібен.

### Базовий набір (під OpenRouter)

- **Router / Classifier / Critic (cheap-fast):** “малий/дешевий” клас (типу 4o-mini-рівня)
- **Main retrieval reasoning (balanced):** OpenAI **GPT-4o** (швидко/надійно)
- **Deep rerank / hard critic (за потреби):** Claude **Sonnet 4.5** (точніший “суддя релевантності”, але дорожчий)
- **Ultra дорогий режим (рідко):** (якщо у вас реально буде) “chatgpt-4o-latest” дорожчий і ще й має оголошену дату “going away” на OpenRouter у лютому 2026 — я б не будував на ньому ядро

**Орієнтир по цінах (на OpenRouter, щоб закласти політики):**

- GPT-4o: старт від **$2.50/M input** і **$10/M output**
- Claude Sonnet 4.5: старт від **$3/M input** і **$15/M output**

> Висновок: **retrieval-пайплайн** має максимум 1 “дорогу” перевірку (Sonnet) лише тоді, коли cheap+GPT-4o дали нестабільний результат.
> 

---

## 5) Контроль якості (те, що дає “вау” юристам)

### 5.1 Retrieval Confidence Model (внутрішній скоринг)

Ви вводите **єдину метрику “можна відповідати / рано відповідати”**:

- `relevance_top1`
- `coverage_score`
- `source_diversity` (не 10 шматків з одного й того самого абзацу)
- `act_confidence` (правильність підібраного акту)
- `freshness/validity` (чинність)

**Політика:**

- якщо `coverage_score < threshold`: запуск ітерації
- якщо 2 ітерації не допомогли: або web-assisted, або уточнююче питання юзеру (але красиво: “уточніть X, бо є 2 режими застосування норми…”)

### 5.2 Анти-“сміття” фільтри

- якщо chunk не містить **жодного** з ключових термінів або близьких (після синонімізації) — понижуємо
- якщо запит про “оскарження/відповідальність”, а chunk про “загальні принципи/звітність” — штраф
- якщо акт підозріло “не той тип” (напр. наказ МВС замість закону/кодексу для загальної норми) — понижуємо, але не відкидаємо повністю

---

## 6) Кешування та швидкість

### 6.1 Кеш “Act resolution”

- ключ: `hash(normalized_query + domain_tag + user_profile_tags)`
- значення: top актів (nreg) + “чому”
- TTL: 24–72 год (бо запити повторюються)

### 6.2 Кеш “Evidence snippets”

- ключ: `(rada_nreg, content_hash, chunk_id)`
- значення: витяг тексту
- TTL: довгий (доки content_hash не змінився)

### 6.3 Паралельність

В одному запиті можна паралелити:

- query understanding
- LLDBI act-index search
- DocListDB resolve (умовно, якщо LLDBI слабкий — запускаємо speculative)
- canonical snippet loading (batch)

---

# 7) ВНУТРІШНІЙ АЛГОРИТМ (ланцюжок у форматі “коду/блоків”)

```
function RETRIEVE_EVIDENCE(request):
  input:
    user_query, memory_context, constraints(budget, latency), pinned_acts, case_id

  # 1) Understand
  QueryProfile = IntentClassifier + DomainTagger + EntityExtractor + AmbiguityDetector

  # 2) Build Search Plan (no web)
  SearchPlan = LegalNavigator.build_plan(user_query, QueryProfile, pinned_acts)

  # 3) Candidate acts (3 tiers)
  ActsA = DirectCitationsResolver(user_query)                         # "ККУ ст.115" etc
  ActsB = LLDBI_ActIndex.search(user_query_embedding_1536, filters)   # cache-only
  if confidence(ActsA+ActsB) low:
      ExpandedQuery = Synonymizer.expand(user_query, QueryProfile)
      ActsC = DocListDB.resolve(ExpandedQuery)                        # global catalog 768d

  ActCandidates = merge_rank(ActsA, ActsB, ActsC)

  # 4) Acquire missing acts into LLDBI (budget-aware)
  Missing = filter_not_in_LLDBI(ActCandidates)
  ImportQueue = pick_top(Missing, mode=constraints.latency/budget)
  ActIngestionOrchestrator.enqueue(ImportQueue)

  # 5) Retrieve chunks from LLDBI
  ScopeActs = pinned_acts + top_cached_acts + imported_ready_acts
  RawHits = LLDBI_Chunks.search(user_query_embedding_1536, scope=ScopeActs, K=80)

  # 6) Assemble canonical evidence
  Extracts = CanonicalSnippetLoader.load(RawHits)   # R2 -> exact snippets

  # 7) Rerank + Dedup + Coverage
  Ranked = Reranker.rank(user_query, Extracts, QueryProfile)
  Evidence = select_top(Ranked, target=12..24, diversity_constraints)

  Coverage = CoverageCritic.score(user_query, Evidence, QueryProfile)
  if Coverage < threshold and iterations_left:
      RefinedQuery = QueryRefiner.suggest(user_query, Evidence, QueryProfile)
      goto step 3 (with RefinedQuery)

  # 8) If still low -> Web-assisted (router-only)
  if Coverage still low and WebAllowed and iterations_left:
      WebHints = WebNavigator.extract_hints(user_query, QueryProfile)
      RefinedQuery2 = QueryRefiner.merge_hints(user_query, WebHints)
      goto step 3 (DocListDB-first)

  # 9) Output Evidence Pack
  return EvidencePack(Evidence, ActCandidates, Coverage, Trace)

```

---

# 8) ЗОВНІШНЄ МІСЦЕ Retrieval Engine У ЗАГАЛЬНІЙ АРХІТЕКТУРІ “МОЗКУ”

```
[API Gateway / Auth / Limits]
          |
          v
[Conversation Orchestrator]
          |
          +--> [Memory Manager] ----> (context pack)
          |
          +--> [Retrieval Engine] --> (Evidence Pack + Trace)
          |
          +--> [Reasoner] ----------> (legal reasoning строго з Evidence)
          |
          +--> [Writer] ------------> (українська юридична мова, формат)
          |
          +--> [Verifier] ----------> (жодного твердження без evidence)
          |
          v
      [Response + Citations + UI cards]

```

**Retrieval Engine стоїть рівно між “пам’яттю” і “мисленням/письмом”** — і це правильно: він “постачає докази”, а не “вигадує”.

# Appendix: Критичні інваріанти, прогалини та “не забудь” для Beta → Prod

## A0. Архітектурні інваріанти (Non-negotiables)

Ці правила мають бути **в одному місці** в документі та повторюватися як “контракт” між модулями:

1. **Evidence-only для фінальної відповіді**
    
    Writer/Reasoner можуть робити висновки **тільки** з `EvidencePack` (LLDBI canonical + provenance) + підтверджений user context (Memory).
    
    Будь-яке твердження без evidence → або **позначка “припущення / потрібні уточнення”**, або **заборонено**.
    
2. **Web = scaffolding only (firewall)**
    
    Web-модуль повертає **тільки WebHints** (терміни/назви актів/синоніми), **без абзаців** і без “пояснень”.
    
    Writer **ніколи** не бачить веб-контент. Router/Critic може бачити WebHints.
    
3. **Token/cost caps на кожному етапі**
    
    Для кожного run є: `max_total_cost_usd`, `max_llm_calls`, `max_retrieval_loops`, `max_tokens_out`.
    
    Якщо caps досягнуті → graceful degrade: коротко, з уточненнями, або saver-mode.
    
4. **Provenance скрізь**
    
    Будь-який фрагмент тексту з актів/доків має мати: `source_id`, `content_hash`, `r2_key`, `json_path`, `snippet_id`.
    

---

## A1. Multi-tenancy / ізоляція даних (критично для прод, але закладаємо в beta)

Навіть якщо beta “маленька”, заклади правильні ключі:

- **Tenant boundary**: кожен запис у Supabase (memory, runs, traces, files) має `tenant_id`/`workspace_id`.
- **Row Level Security (RLS)** у Supabase: доступ по `tenant_id + user_id`.
- **Qdrant payload filter**: `tenant_id`, `user_id`, `scope_type`, `scope_id` — обов’язково (щоб не “витекла” пам’ять).
- **R2 key namespace**: `tenant/{tenant_id}/mm/...`, `tenant/{tenant_id}/lldbi/...`
- **Нульові перетини** між користувачами: global learning (якщо буде) тільки **opt-in** і тільки на “знеособлених шаблонах”.

---

## A2. Data lifecycle: retention / delete / export (щоб не зловити блокер)

Мінімум правила:

1. **User export** (для юриста це вау + довіра):
    - Export conversation/case в `.docx/.pdf/.jsonl` з citations і evidence list.
    - Лінк на export з R2, з TTL.
2. **Right-to-delete / privacy mode**:
    - `privacy_mode=true` → не створювати proposed memory items, не індексувати семантично, не логити контент (лише метрики).
    - Delete user → знести: Supabase rows + R2 blobs + Qdrant points (по `user_id/tenant_id`) + кеші.
3. **Retention policy**:
    - messages: 90–180 днів (beta) або configurable
    - summaries/digests: довше
    - attachments: TTL або manual archive
    - traces: коротко (7–30 днів) + агрегати метрик довше

---

## A3. Версіонування: даних, промптів, пайплайнів (без цього буде хаос)

Додай в документ **один “Versioning” розділ**:

### A3.1 Prompt & policy versioning

- `prompt_version`, `policy_version`, `retrieval_profile_version` зберігаються в `RunRecord`.
- Це дозволяє робити **регресійні тести** і пояснювати “чому вчора відповідь була інша”.

### A3.2 Data schema versioning

- `schema_version` в mm_* таблицях (або в metadata), щоб міграції не ламали бета-дані.

### A3.3 Legal content versioning (дуже важливо)

Для LLDBI/актів:

- `rada_nreg`
- `content_hash` (canonical тексту/структури)
- `effective_date` / `valid_from` / `valid_to` (або хоч би “редакція станом на …”)
- `ingested_at`
- **Правило**: retrieval має віддавати **редакцію** і явно показувати: “станом на дату”.

> Навіть якщо valid_from/valid_to ти прибираєш в іншій таблиці — тут потрібна мінімальна “редакційність”, інакше юристи підловлять.
> 

---

## A4. Billing ledger & cost reservation (щоб auto-mode не вбивав бюджет)

Окремий підрозділ:

1. **Ledger**:
    
    `billing_ledger(run_id, user_id, step_name, model_id, tokens_in, tokens_out, cost_usd, created_at)`
    
    Запис **після кожного кроку**.
    
2. **Reservation before run**:
    - Planner оцінює `expected_cost_usd`
    - Gateway/Orchestrator робить `reserve_cost_usd` (soft)
    - якщо ліміт не дозволяє — одразу saver-mode або просимо підтвердження (в UI).
3. **Hard stop**:
    
    якщо `cost_so_far + next_step_estimate > max_total_cost_usd` → degrade/abort з поясненням.
    
4. **Cost transparency events** у стрімі: `cost_so_far_usd`, `mode`, `degrade_reason`.

---

## A5. Надійність: exactly-once, outbox, конкуренція

Це те, що реально ламає прод:

- **Idempotency**: `idempotency_key` → той самий `run_id`.
- **Outbox pattern** (Supabase таблиця `mm_outbox` або `brain_outbox`):
    
    всі background-таски (summarize, memory extraction, import acts) створюють outbox-подію; воркер бере з lock/lease.
    
- **Exactly-once billing**: ledger event має унікальний ключ `(run_id, step_id)` щоб не нарахувати двічі.
- **Timeout + retries**: для кожного tool-call: `timeout_ms`, `max_retries`, `retry_backoff`.
- **Circuit breaker**: якщо Qdrant/R2 падає — не зупиняти відповідь, а включати fallback.

---

## A6. Безпека: мінімум для beta + що закласти під prod

Коротко, але в одному місці:

### A6.1 Secrets & ключі

- OpenRouter key, Qdrant key, R2 credentials — **ніколи** не в логах
- rotation policy (хоча б manual)

### A6.2 Network boundary

- Beta: allowlist backend origin + JWT
- Prod: VNet/private networking, APIM, WAF, rate limits, mTLS (пізніше)

### A6.3 PII redaction у логах

- логувати **тільки метадані** (tokens, cost, latency, ids)
- контент — лише в secure storage, а в traces — excerpt або hash

---

## A7. Evaluation & regression (щоб не “попливла” якість)

Додай підрозділ “Evals” (це must, інакше будь-який рефактор зламає retrieval):

1. **Golden set**: 50–200 типових запитів юристів (по галузях)
2. **Metrics**:
- citation coverage (% сильних тверджень з evidence id)
- retrieval pass rate (critic PASS 1st/2nd)
- hallucination flags (verifier fail rate)
- avg cost/run, p95 latency
1. **Nightly regression**: проганяємо golden set на поточних prompt_version + retrieval_profile_version
2. **Human review loop** (beta): 1–2 юристи оцінюють 20 відповідей/тиждень, зберігаємо як labeled data.

---

## A8. UX-довіра (вау-ефект, який юристи реально відчують)

Щоб “вау” було не фейкове:

- **Evidence panel** (навіть простий): “Норми, які використані” → список актів/статей → розгорнути snippet
- **Редакція / дата**: “станом на …” або “редакція акту …”
- **Confidence + уточнення**: якщо двозначно — показати 2–3 кандидати й попросити уточнити (це виглядає як професіоналізм)
- **Export**: “Експорт консультації в Word” (дуже сильне вау для юристів)

---

## A9. Стандартизовані структури (щоб не плодити різні формати)

Додай **один** блок з canonical schemas (псевдотипи):

### A9.1 StreamEvent

- `event_type`: state|progress|cost|warning|need_clarification|final
- `state`: classify|plan|memory|retrieve|doclist|import|reason|verify|write|deliver
- `progress`: step_i/step_n
- `cost_so_far_usd`, `citations_count`, `mode`, `degrade_reason?`
- `message?` (user-friendly текст)

### A9.2 Citation

- `source_type`: legislation|case_law|user_doc
- `rada_nreg?`, `act_title?`, `article?`
- `snippet_id`, `r2_key`, `json_path`, `content_hash`
- `quote_excerpt` (коротко)

### A9.3 EvidencePack

- `answerability`: score, missing_aspects[], ambiguity_flags[]
- `act_candidates[]`: {rada_nreg, title, why, confidence}
- `extracts[]`: {snippet_id, text, citation_stub, score, provenance}
- `trace_ref`: pointer на retrieval trace

### A9.4 RunRecord

- `run_id`, `user_id`, `tenant_id`, `conversation_id`, `case_id`
- `limits_snapshot`, `mode`, `prompt_version`, `retrieval_profile_version`
- `status`, `created_at`, `completed_at`, `trace_pointer`

---

## A10. “Stop conditions” і поведінка при недостатності даних

Це критично, бо юристам важливі чесні межі:

- Якщо після N ітерацій retrieval `coverage_score < threshold`:
    1. запропонувати уточнююче питання
    2. видати часткову відповідь (що точно відомо з evidence)
    3. чітко позначити “потрібні додаткові дані/документи”
- Заборонити: “вигадування процедур/строків” без evidence.

---

## A11. Конфіг-профілі Retrieval/LLM (щоб не хардкодити)

Окремо: `retrieval_profile` і `llm_profile`:

- `retrieval_profile: standard|deep|saver`
    - max_candidates_acts
    - max_chunks
    - rerank_enabled
    - doclist_enabled
    - webassist_enabled
    - thresholds (score, coverage)
- `llm_profile: A|B|C`
    - router_model, planner_model, reasoner_model, verifier_model, writer_model
    - max_calls, max_tokens_out

І ці профілі зберігаються в `RunRecord` як snapshot.

---

## A12. Переїзд з beta → prod без переписування

Одна секція “Migration notes”:

- Supabase free → Pro: без змін схем, лише збільшення retention / індексів
- Azure: inline → queue (Service Bus), додавання APIM, private networking
- Plugins: Case law retriever додається як ще один `source_type` в EvidencePack без зміни Writer/Verifier логіки

---

# Final checklist (коротко, щоб швидко перевірити “все накрито”)

- [ ]  Є розділ “Інваріанти” (evidence-only, web firewall, caps, provenance)
- [ ]  Є multi-tenant ізоляція (SQL, Qdrant payload, R2 namespace)
- [ ]  Є retention/delete/export + privacy_mode
- [ ]  Є versioning: prompts/policies + legal content (content_hash + редакція)
- [ ]  Є billing ledger + reservation + hard stop
- [ ]  Є outbox/exactly-once/timeout/retries/circuit breaker
- [ ]  Є security minimum + план на prod
- [ ]  Є evals + golden set + nightly regression
- [ ]  Є UX trust: evidence panel, редакція, export
- [ ]  Є стандартизовані schemas (StreamEvent, Citation, EvidencePack, RunRecord)
- [ ]  Є stop conditions і поведінка при low coverage
- [ ]  Є конфіг-профілі retrieval/llm як snapshot у RunRecord
- [ ]  Є migration notes beta→prod

## Appendix B: Операційна повнота та закриття прогалин

### B1. Таксономія помилок і реакції

**Класифікація помилок:**

- **Transient** (тимчасові): мережеві таймаути, 502/503/504, rate limiting провайдера, тимчасова недоступність залежності.
    - Реакція: `retry` з `exponential backoff + jitter`, обмеження `max_retries`, можливий `fallback` на деградований режим.
- **Permanent** (постійні): 4xx (крім 429), валідація схеми не пройшла, неправильні креденшали, “ресурс не існує”.
    - Реакція: `abort` без retry; повертати структуровану помилку клієнту; логувати причину.
- **User-correctable** (виправляється користувачем/діалогом): неоднозначний запит, низьке покриття, відсутні ключові дані (дата/контекст/юрисдикція/конкретний акт).
    - Реакція: `user_prompt` (уточнююче питання) або `partial_answer` + чіткий список “чого бракує”.

**Матриця реакцій (мінімум):**

| Тип | Джерело | Приклад | Реакція | Деградація | Що логувати |
| --- | --- | --- | --- | --- | --- |
| transient | OpenRouter | 503 / timeout | retry (<=N) | switch model / saver | provider, model_id, latency_ms, retry_count |
| transient | Qdrant | timeout / 502 | retry (<=N) | fallback: keyword/SQL-only | collection, query_hash, latency_ms |
| transient | R2 | 5xx / slow | retry (<=N) | inline excerpt / missing snippets | r2_key, op, latency_ms |
| permanent | Gateway | 400 schema | abort | — | validation_error_codes |
| permanent | Auth | 401/403 | abort | — | auth_reason |
| user-correctable | Retrieval | low coverage | ask clarify / partial | stop after loops | coverage_score, missing_aspects |
| user-correctable | DocList | ambiguous act family | ask choose candidate | — | candidates_count, top_candidates |

**Circuit breaker (одне правило):**

Після `N` послідовних фейлів до зовнішнього сервісу (OpenRouter/Qdrant/R2/DocListDB) Orchestrator активує **circuit breaker** на `cooldown` (наприклад 60–180 с): тимчасово **не викликає** залежність і працює у fallback-режимі; після cooldown — пробний виклик (half-open).

---

### B2. Ємність і орієнтири для beta

**Орієнтовні цілі/діапазони (beta):**

- **Активні користувачі**: 20–50 (TBD).
- **RPS** (Brain): 0.1–1.0 середній; пік 2–5 (TBD).
- **Max concurrent runs на інстанс**: 5–20 (залежить від моделей/таймаутів) (TBD).
- **Середня тривалість run**:
    - standard: 5–20 с
    - deep: 20–90 с
    - saver: 3–12 с
- **Зростання даних/місяць (beta, орієнтир)**:
    - Supabase (memory): 50–200 MB/міс (залежить від retention/архівації).
    - R2 (memory + exports): 0.5–5 GB/міс (залежить від attachments/exports).
    - Qdrant (memory semantic): 10k–200k points/міс (TBD).

**Що моніторити для масштабування:**

- **Черга run**: довжина/вік повідомлень (якщо queue mode), частка queued vs inline.
- **Latency p95 по станах**: `Classify`, `Retrieve`, `Import`, `Write`, `Verify`.
- **CPU/RAM контейнера**: memory pressure, throttling, рестарти.
- **Qdrant**: search latency p95, indexing lag, disk usage.
- **Supabase**: DB size, slow queries, connection saturation.
- **R2**: error rate, latency p95 на get/put.

---

### B3. Діаграма переходів станів run (state machine)

**Станів run:**

`Intake → Classify → Plan → CacheRAG → Gate → Expand → DocList → Import → Assemble → Write → Verify → Deliver`

Термінальні/службові: `failed`, `cancelled`, `timeout`.

**ASCII-діаграма (узагальнено):**

```
Intake
├─>Classify
│├─>Plan
││├─>CacheRAG
│││├─>Gate
││││├─>Expand
│││││├─>DocList (optional)
││││││├─>Import (optional)
│││││││├─>Assemble
││││││││├─>Write
│││││││││├─>Verify
││││││││││└─>Deliver
│││││││││└─> (retry/repair loop) ->Retrieve-related
││││││││└─> failed/timeout/cancelled
│││││││└─> failed/timeout/cancelled
││││││└─>Assemble (ifDocList skipped)
│││││└─>Gate (ifExpand skipped)
││││└─> failed/timeout/cancelled
│││└─> failed/timeout/cancelled
││└─> failed/timeout/cancelled
│└─> failed/timeout/cancelled
└─> failed/timeout/cancelled

```

**Дозволені переходи (правила):**

- З будь-якого стану можливі: `cancelled` (за user_cancel), `timeout` (за run_timeout), `failed` (за permanent error).
- **Retry** допускається тільки для transient: `state -> state` (повтор кроку) з лімітом `max_retries`.
- **Repair loop** (коригувальна драбина) допускається після `Verify`/`CoverageCritic`:
    - `Verify fail` → `Assemble` або `Expand/DocList` (за причиною), але з лімітом `max_retrieval_loops`.
- `Deliver` — єдиний “успішний” термінальний стан.

---

### B4. Версіонування API Brain (Gateway)

**Поточна версія:** `v1`

Ендпоїнти:

- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events` (SSE/WebSocket — залежно від реалізації)
- (optional) `DELETE /v1/runs/{run_id}` (cancel)

**Політика змін:**

- **Backward-compatible** (не змінюємо версію):
    - додавання нових *опційних* полів у request/response;
    - додавання нових типів подій у stream;
    - розширення метаданих, які клієнт може ігнорувати.
- **Breaking changes** (нова версія `v2`):
    - зміна обов’язкових полів/типів;
    - зміна семантики існуючих полів;
    - зміна формату подій, без можливості “паралельного” читання.

**Період підтримки:** стара версія підтримується `N` місяців (TBD, рекомендовано 3–6).

**Фіксація версії в RunRecord:**

`api_version: "v1"` або включення у `limits_snapshot`/`run_context_snapshot`.

---

### B5. Feature flags і поступне вмикання

**Призначення:** контрольоване ввімкнення/вимкнення можливостей без великого релізу:

- `web_assist_enabled`
- `doclist_enabled`
- `memory_semantic_recall`
- `deep_retrieval_enabled`
- `new_model_rollout_{model_id}`
- `claimgraph_enabled` (майбутнє)

**Де зберігати:**

- **Config сервісу** (ENV/конфіг файл) для глобальних флагів.
- **DB (tenant/global)** для керування per-tenant/per-plan:
    - `tenant_flags(tenant_id, flags_json, updated_at)`
    - або `plan_flags(plan_tier, flags_json)`

**Snapshot у RunRecord:**

Завжди записувати `flags_snapshot` у RunRecord, щоб run був **відтворюваним** (reproducible).

**Приклад:**

```json
"flags_snapshot":{
"web_assist_enabled":true,
"memory_semantic_recall":false,
"doclist_enabled":true,
"claimgraph_enabled":false
}

```

---

### B6. Аудит і compliance (мінімум)

**Audit log має фіксувати:**

- `run_id`, `user_id`, `tenant_id`
- `timestamp_start`, `timestamp_end`
- `prompt_version`, `retrieval_profile_version`, `api_version`
- `status` (completed/failed/aborted/cancelled/timeout)
- `cost_usd_total`, `tokens_in/out_total`, `citations_count`
- `models_used[]` (model_id, calls)
- `degrade_reason` (якщо був)

**Принцип:** контент повідомлень **не** пишеться в audit-лог. Контент зберігається в secure storage (Supabase/R2) за політикою приватності.

**Retention:** 90–180 днів (configurable).

**Експорт аудит-логу:** за запитом (інциденти/перевірки) — експорт по run_id/user_id/date-range.

---

### B7. Disaster recovery та резервні копії

**Цілі (beta-орієнтири):**

- **RTO**: < 4 год.
- **RPO**: < 1 год.

**Що бекапити:**

- **Supabase/Postgres**: щоденні резервні копії (Pg dump або вбудовані механізми), + WAL/point-in-time якщо доступно.
- **R2**: versioning або policy-based snapshot/copy (опційно).
- **Qdrant**: snapshots колекцій (LLDBI, memory semantic), мінімум щоденно.

**Частота (beta):**

- щоденно: Supabase dump + Qdrant snapshot
- опційно кожні 6–12 год: для зменшення RPO

**Порядок відновлення:**

1. Відновити **Supabase** (схеми + дані)
2. Перевірити/відновити **R2 blobs** (архіви, великі повідомлення, exports)
3. Відновити **Qdrant snapshots**
4. Перезапустити Brain, прогнати readiness checks, smoke tests `/v1/runs`
5. Верифікувати: retrieval працює, memory підставляється, billing ledger пишеться

**Runbook DR:** має бути один документ з відповідальними (ops/інженер), командами, контактами, таймлайном.

---

### B8. Runbooks (що перевіряти при інцидентах)

**1) “Retrieval повільний / не повертає результати”**

- Перевірити:
    - Qdrant latency/error rate, статус circuit breaker
    - R2 get latency (snippets)
    - LLDBI/DocListDB доступність (якщо окремі сервіси)
- Подивитися run trace:
    - `step_id`, `latency_ms`, `score_threshold`, `coverage_score`
- Дії:
    - увімкнути saver retrieval profile
    - тимчасово вимкнути doclist/webassist (feature flag)
    - знизити max_chunks / max_candidates

**2) “Вартість різко зросла”**

- Перевірити billing_ledger за період:
    - які `model_id` споживають більше
    - чи нема циклу retrieval (max_retrieval_loops)
- Дії:
    - зменшити max_llm_calls / max_tokens_out
    - форсувати saver mode на плані
    - зменшити web-assisted або rerank depth

**3) “Memory не підставляє контекст”**

- Перевірити:
    - Qdrant memory колекція доступна (semantic recall)
    - R2 доступ для blobs
    - `mm_run_context_snapshots` чи збирається ContextPack
    - стан outbox воркера (summaries/digests)
- Дії:
    - fallback: SQL-only (rolling summary + last N messages)
    - перезапуск воркера outbox
    - перевірити RLS/filters (tenant_id, user_id)

**4) “Gateway повертає 5xx”**

- Перевірити:
    - auth/валидація request schema
    - rate limit та throttling
    - черга Orchestrator (якщо queue mode) або threadpool saturation (inline)
    - таймаути до Orchestrator/LLM
- Дії:
    - знизити concurrency, увімкнути queue-only
    - збільшити timeouts на залежностях (в межах caps)
    - увімкнути деградацію (без webassist/doclist)

---

### B9. Контрактні тести (Product Backend ↔ Brain)

**Має бути:**

- Специфікація контракту (OpenAPI або еквівалент) для:
    - `POST /v1/runs`
    - `GET /v1/runs/{id}/events`
- Приклади:
    - **Success**: standard run → final answer + citations + cost
    - **402 budget_exhausted**: запит не стартує або стартує saver + попередження (обрати один шлях)
    - **429 rate_limit**: `Retry-After` + причина
- Формальні правила:
    - idempotency поведінка
    - streaming event schema стабільний

**Хто виконує:**

- Product Backend перед релізом проганяє контрактні тести проти staging Brain.
- Будь-яка зміна контракту → оновити тест + (за потреби) версію API.

---

### B10. Локалізація системних повідомлень

**Мова відповіді:** `uk` (default), `en` — з chat settings.

**Системні повідомлення (errors/prompts/stream messages) мають бути:**

- керовані **кодами** (наприклад `ERR_BUDGET_EXHAUSTED`, `PROMPT_NEED_CLARIFICATION`)
- джерело рядків — один каталог/ресурс:
    - `i18n/uk.json`, `i18n/en.json`
- не хардкодити текст у бізнес-логіці.

**В stream event** поле `message` локалізується згідно `language` у request.

---

### B11. Матриця доступу (хто що бачить)

**Ролі:**

- **Користувач**: свої чати/справи/run, свої exports.
- **Tenant admin**: агреговані метрики по tenant, керування flags/tiers, **без доступу** до контенту інших юзерів.
- **Lexery ops**: метрики/алерти/трейси (без контенту); доступ до контенту тільки через формальну процедуру (інцидент/запит/логування доступу).

**Правило ізоляції:**

- Supabase: RLS `tenant_id + user_id`
- Qdrant: payload filter `tenant_id + user_id` (обов’язково)
- R2: namespace per tenant + signed URLs (TTL) або backend proxy.

---

### B12. Rate limits по планах (tiers)

**Приклад таблиці (TBD значення):**

| plan_tier | max req/min | max concurrent runs/user | max_run_duration_sec |
| --- | --- | --- | --- |
| beta5 | 10–30 | 1 | 30–60 |
| beta10 | 30–60 | 2 | 60–90 |
| beta30 | 60–120 | 3–5 | 120 |
| internal | 200+ | 10 | 180 |

**Перевищення:**

- `429 Too Many Requests` + `Retry-After`
- У стрімі/відповіді: код ліміту + локалізоване повідомлення.

---

### B13. Health checks Brain-сервісу

- **Liveness**: `GET /health` → 200 якщо процес живий.
- **Readiness**: `GET /ready` → 200 якщо сервіс готовий обробляти runs.
    - Мінімум readiness перевіряє:
        - Supabase connectivity (критично)
        - OpenRouter connectivity (критично)
        - Qdrant/R2 (може бути *degraded-ready*: 200 + flags `degraded_sources`, або 503 — обрати політику й зафіксувати)
- Використання: Container Apps/K8s для routing та рестартів.

---

### B14. Де зберігаються промпти (Reasoner/Writer/Verifier) і як версіонуються

**Зберігання (обрати і зафіксувати):**

- **Варіант 1 (простий)**: файловий репозиторій у сервісі:
    - `prompts/{role}/{prompt_version}.md`
- **Варіант 2 (керований)**: таблиця `prompt_templates`:
    - `prompt_version`, `role`, `body`, `created_at`, `is_active`

**Версіонування і rollback:**

- `prompt_version` записується в RunRecord.
- Зміна prompt → новий `prompt_version`.
- Rollback: перемикання `is_active` або конфіг-перемикач версії без редеплою коду (для BД-варіанту).

**Структура промпту (стандарт):**

- `system_block` (політики, стиль, evidence-only)
- `developer_block` (формат, секції, цитування)
- `user_block` (запит)
- `variables`: `context_pack`, `evidence_pack`, `language`, `jurisdiction`, `constraints`.

---

### B15. ClaimGraph vs EvidencePack — коли що використовувати

- **EvidencePack**: використовується **завжди**; це контракт Retrieval → Reasoner/Verifier.
- **ClaimGraph**: опційне розширення для:
    - складних відповідей з багатьма твердженнями,
    - жорсткої верифікації “кожен claim має evidence”.
- Якщо вмикається:
    - будується **на основі EvidencePack** (без нових джерел),
    - передається в Reasoner/Verifier як `claim_graph`,
    - у beta реалізація може бути вимкнена (feature flag), але контракт зарезервований.

---

### B16. Контекстне вікно моделі та overflow ContextPack

**Правило бюджету:**

Сума блоків ContextPack + EvidencePack + службові інструкції не перевищує `token_budget_context` (наприклад 80% context window поточної моделі).

**Пріоритети обрізання (зверху вниз, останнє — обрізати):**

1. `profile_block` (мінімум) — **не обрізати нижче мінімуму**
2. `case_digest_block` (мінімум)
3. `evidence_extracts` (обмежити кількість, але не ламати provenance)
4. `recent_messages` (залишити останні N)
5. `retrieved_history` / `older_context` (обрізати першим)
6. `optional hints` (webhints/aux) — прибирати першими

**Якщо все одно не вміщається:**

- Перехід у `saver`:
    - менше evidence extracts,
    - коротший стиль відповіді,
    - без зайвих блоків.
- Крайній випадок: повідомити користувача про надмірний контекст і запропонувати:
    - новий чат,
    - уточнення,
    - фокус на конкретній справі/питанні.

---

### B17. Скасування run (user cancel)

**Підтримка:** рекомендовано підтримувати в beta (мінімально).

**Механізм:**

- `DELETE /v1/runs/{run_id}` або подія cancel через стрім/канал керування.
- Orchestrator:
    - ставить `status=cancelled`,
    - припиняє старт нових кроків,
    - намагається перервати активні виклики (якщо можливо), або просто не обробляє результат.

**Бюджет:**

- списати лише те, що вже витрачено (`cost_so_far`),
- решта `reserved` розблоковується.

**Відповідь/стрім:**

- final event: `status=cancelled`, `reason=USER_CANCELLED`, `cost_usd_spent`.

---

### B18. Idempotency: область ключа

**Ключ:** `Idempotency-Key` у заголовку.

**Унікальність:**

`(tenant_id, user_id, idempotency_key)` → один run.

**Політика після завершення run (обрати і зафіксувати):**

- Рекомендовано: повторний запит з тим самим ключем **повертає той самий run_id** і результат (якщо completed) або поточний status (якщо ще running).
- TTL запису idempotency: 24–72 год (TBD).

---

### B19. М’які (soft) vs жорсткі (hard) ліміти

**Hard limits (стоп негайно або fail-fast):**

- `max_cost_per_run_usd` перевищено
- `max_llm_calls` досягнуто
- `max_retrieval_loops` досягнуто
- `run_timeout` досягнуто
- invalid auth / forbidden
- request schema invalid

**Soft limits (degrade або попередження):**

- `monthly_budget_remaining` < threshold (наприклад 20%) → saver mode
- контекст наближається до token budget → агресивне обрізання блоків
- низьке покриття після 1 ітерації → ще одна ітерація, далі уточнення

**Прозорість для UI:**

- в стрімі/результаті: `mode`, `degrade_reason`, `limits_snapshot` (скорочено), щоб UI показав “режим економії”.

---

### B20. Підсумкова перевірка «нічого не пропущено»

**Чекліст (з посиланням “у цьому Appendix B”):**

1. Є таксономія помилок і реакції? — так (B1)
2. Є орієнтири ємності для beta і що моніторити? — так (B2)
3. Є state machine з переходами і термінальними станами? — так (B3)
4. Є політика версій API Brain? — так (B4)
5. Є feature flags і snapshot у RunRecord? — так (B5)
6. Є мінімальний аудит/compliance без контенту? — так (B6)
7. Є DR/backup з RTO/RPO і порядком відновлення? — так (B7)
8. Є runbooks для ключових інцидентів? — так (B8)
9. Є контрактні тести Backend ↔ Brain? — так (B9)
10. Є локалізація системних повідомлень? — так (B10)
11. Є матриця доступу та правило ізоляції? — так (B11)
12. Є rate limits по планах і поведінка при перевищенні? — так (B12)
13. Є health checks (liveness/readiness) і політика degraded-ready? — так (B13)
14. Є місце зберігання промптів і правила версіонування/rollback? — так (B14)
15. Є позиція ClaimGraph vs EvidencePack? — так (B15)
16. Є правила overflow ContextPack і пріоритети обрізання? — так (B16)
17. Є user cancel run і наслідки для бюджету/стріму? — так (B17)
18. Є область Idempotency-Key і TTL? — так (B18)
19. Є soft vs hard limits і degrade_reason? — так (B19)
20. Є підсумкова перевірка, що все накрито? — так (B20)