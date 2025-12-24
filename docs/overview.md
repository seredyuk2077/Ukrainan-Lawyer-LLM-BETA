# LEXERY - Огляд проєкту

## 🎯 Що таке LEXERY

LEXERY — продукт з фокусом на RAG (Retrieval-Augmented Generation) для юридичної сфери України. Система автоматично знаходить, завантажує та аналізує українські закони з інтеграцією Supabase, Rada API та OpenAI/Anthropic.

## 🏗️ Архітектура

Проєкт складається з:

1. **Два фронтенди** (обидва залишаються як є):
   - **Legacy фронтенд** (`src/`) - основний React додаток з Vite
   - **Новий фронтенд** (`new-frontend/`) - новий React додаток з Vite

2. **Backend** (`backend/`) - Node.js Express API для юридичного агента

3. **Supabase Edge Functions** (`supabase/functions/`) - Deno функції для RAG

4. **Supabase міграції** (`supabase/migrations/`) - SQL міграції для БД

## 📦 Модулі

### Legacy Frontend (`src/`)
- **Технології**: React 19, Vite, TypeScript, Tailwind CSS, Zustand
- **Точка входу**: `src/main.tsx`
- **Головна сторінка**: `src/pages/Index.tsx`
- **Компоненти**: ChatInterface, ChatHistory, ContractGenerator, DocumentAnalyzer, KnowledgeBase, LegalTemplates
- **Store**: Zustand store для чатів (`src/store/chatStore.ts`)
- **Lib**: Supabase клієнт, OpenAI клієнт, утиліти

### New Frontend (`new-frontend/`)
- **Технології**: React 18, Vite, TypeScript, Tailwind CSS, Zustand
- **Точка входу**: `new-frontend/src/main.tsx`
- **Головна сторінка**: `new-frontend/src/app/App.tsx`
- **Компоненти**: UI компоненти в `new-frontend/src/components/`

### Backend (`backend/`)
- **Технології**: Node.js, Express, Supabase, OpenAI
- **Точка входу**: `backend/src/app-supabase.js`
- **API**: REST API для чатів та юридичних запитів
- **Сервіси**: Rada API parser, Legal Agent, Response Validator

### Supabase Functions (`supabase/functions/`)
- **Технології**: Deno, TypeScript
- **Функції**: `app_78e3d871a2_chat` - Edge Function для RAG

## 🚀 Як запустити

### Legacy Frontend

```bash
# З кореня проєкту
pnpm install
pnpm run dev          # http://localhost:5173
pnpm run build        # Production build
pnpm run lint         # ESLint перевірка
pnpm run test         # Vitest тести
```

### New Frontend

```bash
# З папки new-frontend
cd new-frontend
pnpm install
pnpm run dev          # http://localhost:5173 (або інший порт)
pnpm run build        # Production build
```

### Backend

```bash
# З папки backend
cd backend
npm install
npm run dev           # Nodemon з автоперезавантаженням
npm start             # Звичайний запуск
```

### Supabase Functions

```bash
# З кореня проєкту
pnpm run supabase:login
pnpm run deploy:chat  # Деплой Edge Function
```

## 🔧 Збірка та тестування

### Legacy Frontend
- **Build**: `pnpm run build` → `dist/`
- **Lint**: `pnpm run lint` → ESLint перевірка `src/`
- **Test**: `pnpm run test` → Vitest

### New Frontend
- **Build**: `pnpm run build` → `new-frontend/dist/`
- **Type Check**: `pnpm run build` (включає `tsc`)

### Backend
- **Start**: `npm start` або `npm run dev`
- **Test**: `npm test` (Jest)

## 📝 Змінні оточення

Створіть `.env` у корені проєкту:

```env
# Supabase
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=...

# Backend (якщо потрібно)
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

# OpenAI (для Edge Functions)
OPENAI_API_KEY=...
OPENAI_ROUTER_API_KEY=...

# Anthropic (для Edge Functions)
ANTHROPIC_API_KEY=...
```

## 🔗 Залежності

### Спільні пакети
- React, React DOM
- Zustand (state management)
- Tailwind CSS
- TypeScript

### Унікальні для Legacy Frontend
- Framer Motion
- React Router DOM
- Radix UI компоненти
- Supabase JS

### Унікальні для New Frontend
- React Router DOM v7
- Lucide React

## 📚 Документація

- `README.md` - основний README проєкту
- `docs/` - технічна документація
- `backend/README.md` - документація бекенду

## ⚠️ Важливо

- **Обидва фронтенди залишаються як є** - не об'єднувати, не переносити, не видаляти
- **Legacy фронтенд** - основний продакшн додаток
- **New фронтенд** - новий додаток в розробці
- Обидва використовують Vite, але можуть працювати на різних портах

