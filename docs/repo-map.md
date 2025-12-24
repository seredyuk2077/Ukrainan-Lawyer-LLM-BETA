# Карта репозиторію LEXERY

## 📁 Структура директорій

```
lexery/
├── src/                          # Legacy Frontend (основний React додаток)
│   ├── components/               # UI компоненти (ChatInterface, ChatHistory, тощо)
│   │   └── ui/                   # Shadcn UI компоненти
│   ├── hooks/                    # React хуки (use-mobile, use-toast)
│   ├── lib/                     # Утиліти та клієнти (supabase, openai, тощо)
│   ├── pages/                    # Сторінки (Index, NotFound)
│   ├── store/                    # Zustand store (chatStore)
│   ├── App.tsx                   # Головний компонент
│   └── main.tsx                  # Точка входу
│
├── new-frontend/                 # New Frontend (новий React додаток)
│   ├── src/
│   │   ├── app/                  # App компонент та сторінки
│   │   ├── assets/               # Статичні ресурси
│   │   ├── components/           # UI компоненти
│   │   ├── layouts/              # Layout компоненти
│   │   ├── store/                # Zustand store
│   │   ├── styles/              # Стилі
│   │   ├── utils/               # Утиліти
│   │   └── main.tsx             # Точка входу
│   ├── public/                   # Публічні файли
│   ├── Data/                     # Зображення/логотипи
│   ├── dist/                     # Артефакти збірки (в .gitignore)
│   └── package.json              # Залежності нового фронтенду
│
├── backend/                      # Backend API (Node.js Express)
│   ├── src/
│   │   ├── config/              # Конфігурація (supabase, openai)
│   │   ├── controllers/         # Контролери (supabaseChatController)
│   │   ├── middleware/          # Middleware (rateLimit, validation)
│   │   ├── models/              # Моделі (SupabaseMessage, SupabaseSession)
│   │   ├── routes/              # Маршрути (health, supabaseChat)
│   │   ├── services/           # Сервіси (radaOfficialApiParser, supabaseLegalAgent)
│   │   ├── utils/               # Утиліти (healthcheck, logger)
│   │   └── app-supabase.js      # Точка входу
│   ├── supabase_schema.sql       # SQL схема
│   └── package.json             # Залежності бекенду
│
├── supabase/                     # Supabase конфігурація
│   ├── functions/               # Edge Functions (Deno)
│   │   └── app_78e3d871a2_chat/ # Головна Edge Function для RAG
│   ├── migrations/              # SQL міграції
│   └── config.toml              # Supabase конфігурація
│
├── docs/                         # Документація
│   ├── overview.md              # Огляд проєкту (цей файл)
│   ├── repo-map.md              # Карта репозиторію
│   ├── cleanup-report.md        # Звіт про очищення
│   ├── DEPLOY_SUPABASE_FUNCTION.md
│   ├── RADA_API_DOCUMENTATION.md
│   └── ...
│
├── storage-migration-prep/       # Підготовка до міграції в R2
│   ├── analysis/                # Аналіз та мапи
│   ├── loaders/                  # Завантажувачі
│   ├── scripts/                 # Скрипти міграції
│   ├── sql/                     # SQL міграції
│   └── reports/                 # Звіти
│
├── mcp/                          # MCP (Model Context Protocol) конфігурація
│   └── package.json
│
├── public/                       # Публічні файли (legacy frontend)
│   ├── favicon.svg
│   └── robots.txt
│
├── dist/                         # Артефакти збірки legacy frontend (в .gitignore)
│
├── types/                        # TypeScript типи
│   └── unzipper.d.ts
│
├── .cursor/                      # Cursor IDE конфігурація
├── .supabase/                    # Supabase локальні файли
├── .vscode/                      # VS Code конфігурація
│
├── package.json                  # Кореневий package.json (legacy frontend)
├── vite.config.ts               # Vite конфігурація (legacy frontend)
├── tsconfig.json                 # TypeScript конфігурація
├── tailwind.config.ts            # Tailwind конфігурація (legacy frontend)
├── eslint.config.js              # ESLint конфігурація
├── vitest.config.ts              # Vitest конфігурація
└── README.md                     # Основний README
```

## 🎯 Призначення основних директорій

### Frontend модулі

- **`src/`** - Legacy Frontend, основний продакшн додаток
- **`new-frontend/`** - Новий Frontend, в розробці
- **`dist/`** - Артефакти збірки legacy frontend (не в git)
- **`new-frontend/dist/`** - Артефакти збірки new frontend (не в git)

### Backend

- **`backend/`** - Node.js Express API сервер

### Infrastructure

- **`supabase/`** - Supabase конфігурація, Edge Functions, міграції
- **`mcp/`** - MCP конфігурація

### Documentation & Tools

- **`docs/`** - Технічна документація
- **`storage-migration-prep/`** - Інструменти для міграції даних в R2

### Config files

- **`package.json`** - Кореневий (legacy frontend)
- **`vite.config.ts`** - Vite конфігурація (legacy frontend)
- **`tsconfig.json`** - TypeScript конфігурація
- **`.gitignore`** - Git ignore правила

## 🔍 Точки входу

1. **Legacy Frontend**: `src/main.tsx` → `src/App.tsx` → `src/pages/Index.tsx`
2. **New Frontend**: `new-frontend/src/main.tsx` → `new-frontend/src/app/App.tsx`
3. **Backend**: `backend/src/app-supabase.js`
4. **Supabase Function**: `supabase/functions/app_78e3d871a2_chat/index.ts`

## 📦 Залежності

### Кореневий package.json (Legacy Frontend)
- React 19, Vite, TypeScript, Tailwind, Zustand, Radix UI, Supabase

### new-frontend/package.json
- React 18, Vite, TypeScript, Tailwind, Zustand, React Router v7

### backend/package.json
- Express, Supabase, OpenAI, Winston, Joi

## ⚠️ Важливі зауваження

- **Обидва фронтенди незалежні** - мають свої package.json та конфігурації
- **`dist/` папки** - артефакти збірки, не повинні бути в git (в .gitignore)
- **`storage-migration-prep/`** - тимчасова папка для міграції, можливо вже не потрібна
- **`.cursor/`, `.supabase/`, `.vscode/`** - конфігурації IDE, не в git

