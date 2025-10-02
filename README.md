# Ukrainian Lawyer AI Assistant

Інтелектуальний помічник юриста з використанням AI для роботи з українським законодавством.

## 🚀 Особливості

- **AI-чат** з українськими законами та кодексами
- **База даних** з 25+ основними законами України
- **Інтеграція з Rada API** для отримання актуальних документів
- **Автоматичне витягування** ключових слів та статей
- **Швидкий пошук** по законодавству

## 📁 Структура проєкту

```
├── src/                    # Frontend (React + TypeScript)
│   ├── components/         # UI компоненти
│   ├── lib/               # Утиліти та сервіси
│   └── pages/             # Сторінки додатку
├── backend/               # Backend (Node.js)
│   ├── src/              # Основний код
│   ├── add_laws_to_database.cjs  # Скрипт для додавання законів
│   └── README_LAWS.md    # Документація по роботі з законами
├── supabase/             # Supabase конфігурація
│   └── functions/        # Edge Functions
├── docs/                 # Документація
│   ├── api-data/         # Дані Rada API (doc.txt, ist.txt)
│   └── *.md             # Документація проєкту
└── public/               # Статичні файли
```

## 🛠️ Встановлення

### Frontend
```bash
npm install
npm run dev
```

### Backend
```bash
cd backend
npm install
npm start
```

### Supabase Edge Functions
```bash
npm run deploy:chat
```

## 📚 Робота з законами

### Додавання нового закону
```bash
cd backend
node add_laws_to_database.cjs "Про захист прав споживачів"
```

### Додавання за номером
```bash
node add_laws_to_database.cjs "2135-12"
```

### Додавання кількох законів
```bash
node add_laws_to_database.cjs "1023-12" "2135-12" "Про нотаріат"
```

## 🗄️ База даних

Проєкт використовує Supabase з таблицею `legal_laws`:

- **25 документів** (кодекси та основні закони)
- **7,438 статей** з автоматичним парсингом
- **748 ключових слів** для швидкого пошуку
- **9 категорій** права

## 🔧 Технології

- **Frontend**: React, TypeScript, Tailwind CSS, Shadcn/ui
- **Backend**: Node.js, Express
- **Database**: Supabase (PostgreSQL)
- **AI**: OpenAI GPT-3.5-turbo
- **API**: Rada.gov.ua Official API

## 📖 Документація

- [Документація по роботі з законами](backend/README_LAWS.md)
- [Швидкий старт](backend/QUICK_START.md)
- [Документація Rada API](docs/RADA_API_DOCUMENTATION.md)
- [Звіт про інтеграцію](docs/INTEGRATION_REPORT.md)

## 🚀 Деплой

### Supabase Edge Functions
```bash
npm run deploy:chat
```

### Повний деплой
```bash
npm run deploy
```

## 📝 Ліцензія

MIT License

## 🤝 Внесок

Будь ласка, створюйте issues та pull requests для покращення проєкту.
