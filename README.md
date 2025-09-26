# 🏛️ Український Юрист - AI Правовий Консультант

> **BETA версія** - AI-асистент для консультацій з українського права на базі GPT-4 та Supabase

![Ukrainian Lawyer](https://img.shields.io/badge/Status-BETA-orange) ![React](https://img.shields.io/badge/React-18-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![Supabase](https://img.shields.io/badge/Supabase-Backend-green) ![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4-purple)

## 📋 Опис проекту

**Український Юрист** - це інноваційний AI-асистент, який надає професійні консультації з українського права. Проект створено для допомоги громадянам України в розумінні правових питань та отриманні кваліфікованих рекомендацій.

### ✨ Ключові функції

- 🤖 **AI Консультант Mike Ross** - експертні відповіді на правові питання
- 💬 **Інтерактивний чат** - зручний інтерфейс для спілкування
- 📚 **База знань** - Конституція, ЦК, ГК, КК, КУпАП, ТК України
- 📄 **Генератор договорів** - створення правових документів
- 💾 **Історія чатів** - збереження всіх консультацій
- 🔐 **Безпека** - захист персональних даних

## 🛠️ Технологічний стек

### Frontend
- **React 18** + **TypeScript** - сучасний UI
- **Tailwind CSS** - стилізація
- **Shadcn/ui** - компоненти інтерфейсу  
- **Framer Motion** - анімації
- **Zustand** - управління станом

### Backend
- **Supabase** - база даних та автентифікація
- **Edge Functions** - серверна логіка
- **PostgreSQL** - зберігання даних
- **Row Level Security** - безпека даних

### AI & API
- **OpenAI GPT-4** - штучний інтелект
- **Custom prompts** - спеціалізація на українському праві

## 🚀 Швидкий старт

### Передумови
- Node.js 18+
- pnpm або npm
- Supabase акаунт

### Встановлення

1. **Клонування репозиторію**
```bash
git clone https://github.com/seredyuk2077/Ukrainan-Lawyer-LLM-BETA.git
cd Ukrainan-Lawyer-LLM-BETA
```

2. **Встановлення залежностей**
```bash
pnpm install
# або
npm install
```

3. **Налаштування Supabase**
- Створіть проект на [supabase.com](https://supabase.com)
- Скопіюйте URL та API ключі
- Оновіть конфігурацію в `src/lib/supabase.ts`

4. **Запуск проекту**
```bash
pnpm run dev
# або
npm run dev
```

Відкрийте [http://localhost:5173](http://localhost:5173) у браузері.

## 📁 Структура проекту

```
ukrainian-lawyer/
├── src/
│   ├── components/          # React компоненти
│   │   ├── ChatInterface.tsx
│   │   ├── ChatHistory.tsx
│   │   └── ContractGenerator.tsx
│   ├── lib/                 # Утиліти та сервіси
│   │   ├── supabase.ts      # Supabase клієнт
│   │   ├── openai.ts        # OpenAI інтеграція
│   │   └── ukrainianLaw.ts  # Правова база
│   ├── store/               # Управління станом
│   │   └── chatStore.ts
│   └── pages/               # Сторінки
│       └── Index.tsx
├── backend/                 # Node.js backend (опціонально)
├── supabase/               # Supabase конфігурація
└── public/                 # Статичні файли
```

## 🗄️ База даних

### Таблиці Supabase

**chat_sessions** - сесії чатів
```sql
- id: UUID (Primary Key)
- user_id: UUID (Foreign Key)
- title: TEXT
- created_at: TIMESTAMP
- updated_at: TIMESTAMP
- is_active: BOOLEAN
```

**chat_messages** - повідомлення
```sql
- id: UUID (Primary Key)
- session_id: UUID (Foreign Key)
- role: TEXT (user/assistant/system)
- content: TEXT
- tokens_used: INTEGER
- created_at: TIMESTAMP
```

## 🔧 Конфігурація

### Environment Variables
```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Supabase Edge Function
Функція `app_78e3d871a2_chat` обробляє запити до OpenAI API:
- Отримує повідомлення користувача
- Генерує відповідь через GPT-4
- Зберігає історію в базі даних

## 📖 Використання

### Створення нового чату
1. Натисніть "Новий чат" в бічній панелі
2. Введіть ваше правове питання
3. Отримайте професійну консультацію від Mike Ross

### Генерація договорів
1. Натисніть "Створити договір"
2. Оберіть тип договору
3. Заповніть необхідні поля
4. Завантажте готовий документ

## 🛡️ Безпека

- **Row Level Security (RLS)** - захист даних користувачів
- **JWT токени** - безпечна автентифікація
- **CORS налаштування** - захист від XSS атак
- **Rate limiting** - захист від зловживань

## 🧪 Тестування

```bash
# Запуск тестів
pnpm run test

# Лінтинг коду
pnpm run lint

# Перевірка типів
pnpm run type-check
```

## 📦 Збірка для продакшену

```bash
pnpm run build
```

## 🚀 Деплой

### Vercel (рекомендовано)
```bash
npm i -g vercel
vercel --prod
```

### Netlify
```bash
npm run build
# Завантажте папку dist на Netlify
```

## 🤝 Внесок у проект

1. Fork репозиторію
2. Створіть feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit зміни (`git commit -m 'Add AmazingFeature'`)
4. Push до branch (`git push origin feature/AmazingFeature`)
5. Відкрийте Pull Request

## 📄 Ліцензія

Цей проект ліцензовано під MIT License - дивіться [LICENSE](LICENSE) файл для деталей.

## 👨‍💻 Автор

**Andrii Serediuk**
- GitHub: [@seredyuk2077](https://github.com/seredyuk2077)
- Email: your.email@example.com

## 🙏 Подяки

- OpenAI за GPT-4 API
- Supabase за backend інфраструктуру
- Shadcn/ui за компоненти інтерфейсу
- Українська правова спільнота за експертизу

## ⚠️ Відмова від відповідальності

Цей AI-асистент надає загальну інформацію з українського права та не замінює професійну юридичну консультацію. Для вирішення конкретних правових питань зверніться до кваліфікованого юриста.

---

**🇺🇦 Створено з любов'ю до України**