# Промпт для Deep Research: повна архітектурна матриця Lexery Legal AI Agent (з орієнтацією на Figma)

**Призначення:** отримати **максимально деталізовану графічну архітектурну матрицю** Lexery Legal AI Agent у форматі, готовому до перегляду в чаті та (за можливості) до перенесення в окремий листок Figma для зручного навігування. Результат має охопити **все**: кожен блок з block-chain map, усі колонки матриці заповнені, без порожніх клітинок і без спрощень.

---

## Контекст і джерела

Ти маєш доступ до всього контексту чату. **Обов’язково опирайся на:**

1. **`plan.md`** — основний архітектурний документ: розділи 1–8, внутрішній алгоритм (§7), Appendix A0–A9, блоки Online (Gateway → Orchestrator → Memory → Retrieval Engine → Reasoner → Writer → Verifier), Offline DocListDB Updater, Offline LLDBI Ingestion, модулі на кшталт IntentClassifier, LegalDomainTagger, Ambiguity Detector, Synonymizer, Hypothesis Builder, Plan Builder, Candidate Act Discovery (рівні A/B/C), CrossEncoderReranker, CoverageCritic, QueryRefiner, StopPolicy, CanonicalSnippetLoader / R2SnippetLoader, WebNavigator (Router-only), ActIngestionOrchestrator, Memory Manager (підкомпоненти), Reasoner, Writer, Verifier.
2. **`answer.md`** — попередній Deep Research: вже є block-chain maps (Online U1–U12, Offline DocListDB T0/O1–O6, Offline LLDBI T6/O7–O12) і матриця блоків з колонками Purpose, Inputs, Outputs, Storage side-effects, Dependencies, Secrets & Config, Failure Modes, Retries/Timeouts, Observability, Test Hooks. Використовуй їх як базову структуру і **розширюй/деталізуй**, не спрощуючи.
3. **Контекст репо:** Online — Brain-сервіс, API `/v1/runs`, стрімінг; DocListDB Updater — `scripts/legislation/.../UpdaterDB/`, cron, Rada, Qdrant `legislation-catalog-index`, R2 state/locks; LLDBI — `Lexery Legislation DB Infra/`, R2 `legislation/{category}/{nreg}.json`, Qdrant `lexery_legislation_acts`, `lexery_legislation_chunks`, Supabase `legislation_documents`, `legislation_import_jobs`; Act Catalog Resolver — Cloudflare Worker.

---

## Твоя головна задача

Зробити **одну велику, повну архітектурну матрицю** у **графічному/структурованому форматі**, яку зручно переглядати в чаті і (якщо підключено інструмент Figma) перенести в окремий листок Figma під назвою **«Lexery Legal AI Agent — Повна архітектурна матриця»**.

Порядок дій:

1. **Спочатку** — максимально деталізовано вивести **в форматі Deep Research** саму матрицю та блок-чейн карти (див. правила нижче). Тобто спочатку ти **тут, у відповіді**, повністю розписуєш усе в будь-якому зручному текстовому/графічному форматі (ASCII-діаграми, Markdown-таблиці, структуровані списки тощо).
2. **Далі** — якщо в цьому чаті у тебе є доступ до **інструменту Figma**: створи окремий листок (frame/page) з назвою **«Lexery Legal AI Agent — Повна архітектурна матриця»** і там дуже зручно реалізуй:
   - **Блок-чейн карти** (Online Serving, Offline DocListDB Updater, Offline LLDBI Ingestion) — у вигляді читабельних блок-схем (кожен блок з ID і короткою назвою, стрілки потоку).
   - **Матрицю блоків** — таблицю, де кожен рядок = один блок з карти; колонки: Block ID, Purpose, Inputs, Outputs, Storage side-effects, Dependencies, Secrets & Config, Failure Modes, Retries/Timeouts, Observability, Test Hooks / Injectables. Можна зробити один великий фрейм-таблицю або картки по блоках з посиланнями на блоки на картах.
   Якщо Figma **немає** — достатньо вивести все в чаті у максимально структурованому вигляді (ASCII + Markdown), щоб потім можна було вручну перенести в Figma або інший інструмент.
3. **Обсяг:** матриця має охопити **всі** блоки з усіх трьох потоків (Online U1–U12, Offline DocList T0/O1–O6, Offline LLDBI T6/O7–O12), плюс за потреби — підблоки з plan.md (наприклад, окремі рядки для IntentClassifier, DomainTagger, Reranker, CoverageCritic, CanonicalSnippetLoader, ActIngestionOrchestrator тощо), якщо вони мають чітку відповідальність і контракт (inputs/outputs). Мета — **повністю все**, максимально деталізовано.

---

## Жорсткі правила для блок-чейн карт

- **Три окремі карти:** (1) **Online Query Processing** — від [U1] Gateway до [U12] Deliver; (2) **Offline DocListDB Updater** — від [T0] Cron до [O6] Update Catalog Index (і [O1] Store Canonical якщо в цьому потоці); (3) **Offline LLDBI Ingestion** — від [T6] Import Job Trigger до [O12] Mark Indexed.
- **Символи:** тільки ASCII: `|`, `v`, `->`, `[ ]`, `( )`, `-`. Напрямок — зверху вниз. Один блок — один рядок з позначкою типу `[ID] Коротка назва`.
- **Паралельні гілки:** одна вертикальна лінія вниз, від неї `|----->` до паралельних блоків, потім збіг у наступний блок через `v`.
- **Не об’єднуй** різні компоненти в один бокс «тощо». Кожен логічний крок = окремий блок з унікальним ID. ID з карт мають **точно** збігатися з Block ID у матриці.

---

## Жорсткі правила для матриці блоків

- **Один блок з block-chain map = один рядок у матриці.** Якщо на картах з’являються додаткові підблоки (наприклад, [U2a] IntentClassifier, [U2b] DomainTagger) — для кожного свій рядок.
- **Усі колонки обов’язково заповнені** для кожного рядка. Набір колонок:
  - **Block ID**
  - **Purpose** (призначення)
  - **Inputs**
  - **Outputs**
  - **Storage side-effects**
  - **Dependencies**
  - **Secrets & Config**
  - **Failure Modes**
  - **Retries / Timeouts**
  - **Observability (Logs/Metrics)**
  - **Test Hooks / Injectables**
  Якщо інформації немає в документації — пиши явно: **«Не описано в документації»** або **«TBD: [конкретне питання для вирішення]»**. Порожніх клітинок не залишай.
- **Конкретні значення:** файлові шляхи (`scripts/legislation/...`, R2 prefix `legislation/DocListDB rada gov updater log/`), назви колекцій Qdrant (`lexery_legislation_chunks`, `legislation-catalog-index`), змінні середовища (`OPENROUTER_API_KEY`, `QDRANT_API_KEY`), таймаути (напр. 5 с, 30 с), ендпоінти API, поля БД — замість загальних фраз типу «тощо», «e.g.».
- **Block ID** у першій колонці має **точно** відповідати ID на block-chain картах.

---

## Формат виводу в чаті (Deep Research)

1. **Заголовок:** «Повна архітектурна матриця Lexery Legal AI Agent».
2. **Блок-чейн карти** — три повні ASCII-діаграми (Online, Offline DocListDB, Offline LLDBI), з усіма блоками з plan.md та answer.md, без пропусків.
3. **Матриця блоків** — одна велика Markdown-таблиця (або розбита на три таблиці за потоками), де рядків стільки, скільки блоків на картах; усі 11 колонок заповнені; значення взяті з plan.md, answer.md та контексту репо.
4. **Опційно:** короткий підсумок «Як це використати в Figma» — якщо ти реально створив листок у Figma, опиши що де розміщено; якщо ні — як найзручніше перенести таблицю та діаграми в Figma вручну (наприклад, один фрейм на карту, один фрейм на таблицю, шрифти/відступи для читабельності).

---

## Критерій готовності

Результат вважається готовим, коли:

- Є **усі три** block-chain карти з унікальними ID для кожного кроку.
- Матриця містить **рядок для кожного блоку** з карт (і для додаткових підблоків, якщо ти їх виніс окремими блоками).
- **Жодної порожньої клітинки** в матриці; скрізь або конкретне значення, або явний текст «Не описано в документації» / «TBD: …».
- Якщо доступний Figma — створено листок **«Lexery Legal AI Agent — Повна архітектурна матриця»** з блок-схемами та таблицею/картками, зручними для перегляду. Якщо ні — текст у чаті структурований так, щоб його можна було без втрат перенести в Figma або інший візуальний інструмент.

Почни з аналізу plan.md та answer.md, потім виведи спочатку повні блок-чейн карти, потім повну матрицю блоків. Після цього — за наявності інструменту Figma — створи листок і перенеси туди візуалізацію. Результат має бути максимально деталізованим і повним, без скорочень і без пропусків блоків або колонок.
