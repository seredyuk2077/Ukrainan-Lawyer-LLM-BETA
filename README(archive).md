# Ukrainian AI Legal Agent

Інтелектуальний помічник юриста, який автоматично знаходить, завантажує та аналізує українські закони з інтеграцією Supabase, Rada API та OpenAI.

> ⚠️ Ця документація описує поточний робочий стан проєкту. Розробка триває, API та логіка можуть змінюватися у наступних комітах (це не релізна версія).

---

## 🏗 Поточна архітектура (стан після інтеграційних оновлень)

- **Router на GPT-3.5 (окремий ключ)** — перший крок пайплайна, визначає галузь права та рекомендований `nreg` із whitelist/manual mapping.
- **Модуль вибору основної LLM** (`selectMainModel`) — перемикає між GPT-3.5 Turbo та Claude 3 Haiku (або майбутніми моделями) за env-параметрами.
- **Supabase Storage + таблиці** — централізоване сховище JSON-законів (`zu/legal-laws/...`) й метаданих (`legal_documents_storage`, `legal_articles`).
- **Lazy-завантаження з Rada API** — коли JSON відсутній у бакеті, `ensureManualLawAvailability` качає `.json/.txt`, парсить `stru` та кешує.
- **Витяг структурованих статей** — `extractRelevantArticles`, `buildSourceArticlesForDoc` формують посилання виду `п. 1 ч. 2 ст. 23`.
- **Edge Function Flow**:  
  `Router → Target Law Detection → Storage Query → (за потреби) Rada Download → Article Extraction → Main Model → Validation`.

### Інформаційний флоу
1. **Router** (GPT‑3.5, окремий ключ) визначає гілку (`branch`) і `recommended_nreg`.
2. **Target Law Detection** — об’єднання router, manual mappings та soft-search сигналів.
3. **Supabase Storage** — пошук JSON/метаданих; якщо документ відсутній, ініціюється `Rada Fetch + Cache`.
4. **Article Extraction** — вирізання потрібних частин (ч./п./пп.) + формування списку для цитування.
5. **Main LLM** — GPT‑3.5 або Claude Haiku працюють у форматі Harvey AI, відповідають лише за контент із контексту.
6. **Validation & Caching** — перевірка цитат, запис результатів у `response_cache` та `legal_articles`.

### Нові можливості (останнє оновлення)
- Двомодельна архітектура (GPT‑3.5 ⇄ Claude Haiku) з єдиним інтерфейсом.
- Переписані системні промпти (Harvey AI формат, заборона галюцинацій, бюджетні інструкції).
- Router працює на окремому GPT-3.5 ключі та посилено категоризує сімейні/житлові/мобілізаційні кейси.
- Посилене злиття Router → пошук → LLM, гарантія використання `recommended_nreg`.
- Очищена структура Supabase (перевірені дублікаті `legal_documents_storage`, кешування статей через `legal_articles`).
- Уніфікована структура тестів (`/tests/gpt`, `/tests/claude`) із повними логами інтеграційних прогонів.
- Актуалізована Edge Function (`app_78e3d871a2_chat`) із lazy-fetch, caching та валідацією.

---

## 🔍 Основні можливості
- **RAG-пошук** по локальній базі Supabase Storage (`zu/legal-laws/...`) з ручними мапінгами та soft/hard пошуком.
- **Автоматичне завантаження законів** із Rada API, нормалізація шляху та збереження метаданих у таблиці `legal_documents_storage`.
- **Розуміння структури статей** (ч. / п. / пп.) й точний витяг потрібних частин для відповіді.
- **Фронтенд** на React + Zustand з історією чатів і генератором контрактів.
- **Edge Function** `app_78e3d871a2_chat` на Deno, що поєднує класифікацію запиту, пошук, парсинг та генерацію відповіді.

---

## 🧱 Архітектура

```
┌──────────────┐       ┌──────────────────────┐       ┌───────────────────┐
│   Frontend   │ ───▶ │ Edge Function (Deno) │ ───▶ │ Supabase Storage  │
│ React + RAG  │      │ класифікація, пошук  │      │ zu/legal-laws/... │
└──────┬───────┘      │ + OpenAI             │      └───────────────────┘
       │              └──────────┬───────────┘                 ▲
       │                         │                             │
       ▼                         ▼                             │
┌──────────────┐       ┌──────────────────────┐       ┌────────┴───────┐
│   Zustand    │ ◀──▶ │  legal_documents_*   │ ◀──▶ │  Rada API      │
│ чат/сесії    │       │  metadata + cache    │       │ (on-demand)    │
└──────────────┘       └──────────────────────┘       └───────────────┘
```

### Edge Function Flow
1. Класифікація запиту (`classifyQuestionMultiStage`) + парсинг статей/частин/пунктів.
2. `detectManualLawTarget` → гарантія наявності JSON у бакеті (`ensureManualLawAvailability`).
3. `searchInStorage` → `softSearchStorageBySignals` → `legal_documents_storage`.
4. `extractRelevantArticles` (прямо з JSON або `legal_articles`) з урахуванням ч./п./пп.
5. Генерація відповіді через OpenAI з валідацією та цитуванням релевантних статей.

### Frontend Flow
1. `useChatStore` (Zustand) відповідає за локальні чати, історію, синхронізацію з Supabase.
2. `ChatInterface` викликає Edge Function напряму (Supabase URL + anon key).
3. `ChatHistory` / `ContractGenerator` працюють на тих же даних, без дублювання бекенду.

---

## 📂 Структура репозиторію

```
├── src/                        # Фронтенд (React + Tailwind + Zustand)
│   ├── components/             # UI, ChatInterface, ContractGenerator, History
│   ├── lib/                    # openai.ts, supabase.ts, documentGenerator.ts
│   ├── store/chatStore.ts      # Повна логіка чатів
│   └── pages/Index.tsx         # Основний екран застосунку
├── supabase/
│   ├── functions/app_.../      # Edge Function + deno.d.ts
│   ├── functions/tsconfig.json # Налаштування для Deno-проєкту
│   └── migrations/             # SQL-міграції (створення bucket `zu`, таблиць)
├── docs/                       # Технічна документація й звіти
├── backend/                    # Архів старих Node-скриптів (для довідки)
├── README.md                   # Цей файл
└── deploy-functions.cjs        # Хелпер для деплою Edge Function
```

---

## ⚙️ Налаштування та запуск

### Передумови
- Node.js 20+
- npm 10+ (або pnpm/yarn, якщо потрібно)
- Supabase CLI (для деплою функцій)

### Файл змінних середовища
Створіть `.env` у корені:
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

### Встановлення залежностей
```bash
npm install               # зберігає кеш локально (.npm-cache)
```

### Режим розробки
```bash
npm run dev               # http://localhost:5173
```

### Перевірки
```bash
npm run lint              # ESLint (src/)
npm run build             # Production build Vite
```

### Деплой Edge Function
```bash
npm run supabase:login
npm run deploy:chat       # supabase functions deploy app_78e3d871a2_chat
```

---

## 🔧 Інструкції для розробника

### Деплой edge-функції (Supabase CLI + MCP)
1. Увійти в Supabase CLI: `supabase login`.
2. Встановити secrets (через Dashboard або `supabase secrets set`, без префіксу `SUPABASE_`):  
   `OPENAI_API_KEY`, `OPENAI_ROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `MAIN_LLM_PROVIDER`, `MAIN_LLM_MODEL`.
3. Розгорнути: `supabase functions deploy app_78e3d871a2_chat`.
4. Перевірити в Dashboard → Functions → Logs, що нова версія активна.

### Додавання нової моделі в pipeline
1. Додати провайдера в `selectMainModel` (`supabase/functions/app_.../index.ts`).
2. Вказати system prompt + адаптацію формату повідомлень.
3. Для використання — задати `MAIN_LLM_PROVIDER` / `MAIN_LLM_MODEL` у secrets.
4. Додати інтеграційний прогін у `/tests/<provider>/...` і оновити агрегований JSON.

### Логіка Router
- Router (GPT‑3.5) працює на власному ключі та повертає `branch`, `recommended_nreg`, `confidence`, `reasoning`.
- При наявності `recommended_nreg` система **завжди** переходить у юридичний режим і примусово підтягує відповідний закон (manual mapping або storage).
- Категорії доповнені сімейними, житловими, мобілізаційними тригерами.

### Кешування Rada → Storage
- `ensureManualLawAvailability` шукає JSON у `zu/...`.
- Якщо немає — `fetchLawFromRadaDirectly` качає `.json/.txt`, формує payload, зберігає в bucket + `legal_documents_storage`.
- Статті додатково записуються у `legal_articles` (для подальших запитів).

### Валідація запиту
1. `validateResponse` перевіряє номери статей, наявність цитат, підозрілі фрази.
2. При невідповідності знижується температура і відповідь генерується повторно.
3. Кеш (`response_cache`) містить текст відповіді, law refs та класифікацію.

### Робота з тестами
- Інтеграційні результати зберігаються у `/tests/gpt/tests_full_pipeline_gpt35.json` та `/tests/claude/tests_full_pipeline_claude_haiku.json`.
- Для регресійного прогону: запустити edge-функцію локально, виконати скрипт із `node <<'NODE' ...` (приклад див. `tests_full_pipeline_gpt35.json` у git-історії).
- Після тестів агрегувати результати (див. `scripts` у комітах) і покласти у відповідну теку.

---

## 🧠 Автоматична робота з законами
- `manualLawMappings` зберігає критичні закони (мобілізація, антикорупція, поліція тощо) із жорсткими шляхами.
- `ensureManualLawAvailability`:
  1. шукає в `zu/legal-laws/<THEME>/<LAW>/<nreg>.json`;
  2. якщо немає — качає з Rada API, парсить `stru`, формує JSON;
  3. оновлює таблицю `legal_documents_storage`.
- `buildSourceArticlesForDoc` формує посилання виду `ч.2 п.1 ст.23` й підрізає список статей під контекст запиту.

---

## ✅ Тести
- `/tests/gpt/tests_full_pipeline_gpt35.json` — повний набір інтеграційних сценаріїв для GPT‑3.5 Turbo (14 запитів).
- `/tests/claude/tests_full_pipeline_claude_haiku.json` — аналогічний набір для Claude 3 Haiku.
- `npm run lint`, `npm run build` — статичні перевірки фронтенду.
- Edge Function тести запускаються через локальний `deno run -A ...` + автоматичні `node`-скрипти для відправки запросів (див. інструкцію вище).
- Під час QA видалені зайві артефакти (`docs/api-data`, `dist/`, `backend/logs`, локальні `node_modules`).

---

## 📚 Додатково
- `docs/DEPLOY_SUPABASE_FUNCTION.md` — деталі деплою.
- `docs/RADA_API_DOCUMENTATION.md` — робота з офіційним API Верховної Ради.
- `supabase/migrations/*.sql` — схема таблиць/бакетів (зокрема `zu`).

---

## 📝 Ліцензія & внесок
Проєкт відкритий (MIT). Із новими запитами або багами — створюйте issue/PR. Будь-які покращення пошуку, парсингу або дерева категорій вітаються. Важливо підтримувати структуру `zu/legal-laws/<THEME>/<LAW>/<nreg>.json` та зберігати метадані синхронізованими.
