# Ukrainian AI Legal Agent

Інтелектуальний помічник юриста, який автоматично знаходить, завантажує та аналізує українські закони з інтеграцією Supabase, Rada API та OpenAI.

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

## 🧠 Автоматична робота з законами
- `manualLawMappings` зберігає критичні закони (мобілізація, антикорупція, поліція тощо) із жорсткими шляхами.
- `ensureManualLawAvailability`:
  1. шукає в `zu/legal-laws/<THEME>/<LAW>/<nreg>.json`;
  2. якщо немає — качає з Rada API, парсить `stru`, формує JSON;
  3. оновлює таблицю `legal_documents_storage`.
- `buildSourceArticlesForDoc` формує посилання виду `ч.2 п.1 ст.23` й підрізає список статей під контекст запиту.

---

## ✅ Тести (ручні сценарії)
- `npm run lint`, `npm run build` — зелені.
- Edge Function: локальні `python` POST-запити до `functions/v1/app_...` з кейсами:
  - «Що передбачає ст. 5 Закону про мобілізацію?» → джерело `3543-12`, стаття `ст.5`.
  - «Що таке подарунок і які подарунки не можна приймати держслужбовцю?» → `1700-18`, аналіз `ч.2 ст.23`.
  - «Які повноваження має поліцейський…» → `580-19`, список головних статей.
- Під час QA видалені зайві артефакти (`docs/api-data`, `dist/`, `backend/logs`, локальні `node_modules`).

---

## 📚 Додатково
- `docs/DEPLOY_SUPABASE_FUNCTION.md` — деталі деплою.
- `docs/RADA_API_DOCUMENTATION.md` — робота з офіційним API Верховної Ради.
- `supabase/migrations/*.sql` — схема таблиць/бакетів (зокрема `zu`).

---

## 📝 Ліцензія & внесок
Проєкт відкритий (MIT). Із новими запитами або багами — створюйте issue/PR. Будь-які покращення пошуку, парсингу або дерева категорій вітаються. Важливо підтримувати структуру `zu/legal-laws/<THEME>/<LAW>/<nreg>.json` та зберігати метадані синхронізованими.
