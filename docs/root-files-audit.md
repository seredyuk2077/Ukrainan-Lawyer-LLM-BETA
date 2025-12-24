# Аудит файлів в корені репозиторію

**Дата:** 24 грудня 2025

## 📋 Аналіз файлів

### ✅ Файли які мають залишитися в корені (конфіги для Legacy Frontend)

| Файл | Призначення | Статус |
|------|-------------|--------|
| `package.json` | Залежності Legacy Frontend | ✅ Залишити |
| `pnpm-lock.yaml` | Lock файл залежностей | ✅ Залишити |
| `vite.config.ts` | Конфіг Vite для Legacy Frontend | ✅ Залишити |
| `tsconfig.json` | Основний конфіг TypeScript | ✅ Залишити |
| `tsconfig.app.json` | Конфіг TypeScript для додатку | ✅ Залишити |
| `tsconfig.node.json` | Конфіг TypeScript для Node.js | ✅ Залишити |
| `tailwind.config.ts` | Конфіг Tailwind CSS | ✅ Залишити |
| `postcss.config.js` | Конфіг PostCSS | ✅ Залишити |
| `eslint.config.js` | Конфіг ESLint | ✅ Залишити |
| `vitest.config.ts` | Конфіг Vitest | ✅ Залишити |
| `components.json` | Конфіг shadcn/ui | ✅ Залишити |
| `index.html` | Точка входу Legacy Frontend | ✅ Залишити |
| `.gitignore` | Git ignore правила | ✅ Залишити |
| `README.md` | Основна документація | ✅ Залишити |

### 📦 Файли які переміщені в `scripts/`

| Файл | Призначення | Новий шлях | Оновлення |
|------|-------------|------------|-----------|
| `r2.mjs` | MCP сервер для Cloudflare R2 | `scripts/r2.mjs` | ✅ Переміщено |
| `deploy-functions.cjs` | Скрипт деплою Supabase Functions | `scripts/deploy-functions.cjs` | ⚠️ Потрібно оновити package.json |

### ⚙️ Файли які переміщені в `config/`

| Файл | Призначення | Новий шлях | Статус |
|------|-------------|------------|--------|
| `template_config.json` | Конфіг шаблону (не використовується) | `config/template_config.json` | ⚠️ Можна видалити |
| `datasets_local.json` | Конфіг локальних датасетів (не використовується) | `config/datasets_local.json` | ⚠️ Можна видалити |

### 📄 Файли які переміщені в `docs/archive/`

| Файл | Призначення | Новий шлях | Статус |
|------|-------------|------------|--------|
| `STORAGE_AUDIT_REPORT.md` | Звіт про аудит сховища | `docs/archive/STORAGE_AUDIT_REPORT.md` | ✅ Переміщено |

### ❓ Файли які потребують рішення

| Файл | Призначення | Питання | Рекомендація |
|------|-------------|---------|--------------|
| `deno.lock` | Lock файл для Deno (Supabase functions) | Чи потрібен в корені? | Перемістити в `supabase/` або видалити (генерується автоматично) |

### 🔒 Файли в .gitignore

| Файл | Статус |
|------|--------|
| `.env` | ✅ В .gitignore |
| `.env.local` | ✅ В .gitignore |

---

## 🎯 Результати організації

### Створені папки:
- `scripts/` - для скриптів та утиліт
- `config/` - для конфігів які не є частиною збірки
- `docs/archive/` - для архівних звітів

### Переміщені файли:
1. ✅ `r2.mjs` → `scripts/r2.mjs`
2. ✅ `deploy-functions.cjs` → `scripts/deploy-functions.cjs`
3. ✅ `template_config.json` → `config/template_config.json`
4. ✅ `datasets_local.json` → `config/datasets_local.json`
5. ✅ `STORAGE_AUDIT_REPORT.md` → `docs/archive/STORAGE_AUDIT_REPORT.md`

### Оновлені посилання:
- ⚠️ `package.json` - оновлено шляхи до `deploy-functions.cjs`

---

## ⚠️ Файли які можна видалити (після підтвердження)

1. **`config/template_config.json`** - не використовується в коді
2. **`config/datasets_local.json`** - не використовується в коді
3. **`deno.lock`** - генерується автоматично, можна видалити (але краще залишити для репродюсибельності)

---

## 📝 Наступні кроки

1. ✅ Перемістити файли по папках
2. ✅ Оновити посилання в `package.json`
3. ⚠️ Перевірити чи все працює після переміщення
4. ❓ Підтвердити видалення непотрібних файлів

