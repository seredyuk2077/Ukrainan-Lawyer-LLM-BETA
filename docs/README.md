# 📚 Документація проєкту Ukrainian-Lawyer-LLM-BETA

Ця папка містить всю документацію проєкту, організовану за темами та призначенням.

## 📁 Структура документації

### 🏛️ Legislation RAG
**Папка:** [`legislation-rag/`](./legislation-rag/)

Повна архітектурна документація системи Legislation RAG:
- Архітектура та дизайн
- Джерела даних (rada.gov.ua API)
- Паіплайн імпорту
- Стратегія зберігання (Supabase + R2)
- RAG retrieval
- Звіти про реалізацію та тестування

**Головний індекс:** [`legislation-rag/README.md`](./legislation-rag/README.md)

### ⚖️ Supreme Court RAG
**Файли:**
- [`supreme_court_rag.md`](./supreme_court_rag.md) — Архітектура Supreme Court RAG
- [`supreme_court_benchmark.md`](./supreme_court_benchmark.md) — Бенчмарки та тестування

### 📊 API Документація
**Файли:**
- [`RADA_API_ANALYSIS.md`](./RADA_API_ANALYSIS.md) — Детальний аналіз rada.gov.ua API
- [`RADA_API_DOCUMENTATION.md`](./RADA_API_DOCUMENTATION.md) — Документація API

### 🔧 Інтеграція та Deployment
**Файли:**
- [`README_INTEGRATION.md`](./README_INTEGRATION.md) — Інструкції з інтеграції
- [`INTEGRATION_REPORT.md`](./INTEGRATION_REPORT.md) — Звіт про інтеграцію
- [`DEPLOY_SUPABASE_FUNCTION.md`](./DEPLOY_SUPABASE_FUNCTION.md) — Деплой Edge Functions
- [`SUPABASE_FUNCTION_OPTIMIZATION.md`](./SUPABASE_FUNCTION_OPTIMIZATION.md) — Оптимізація функцій

### 🔒 Безпека та Аудит
**Файли:**
- [`SECURITY_AUDIT_REPORT.md`](./SECURITY_AUDIT_REPORT.md) — Звіт про безпеку

### 📋 Загальна документація
**Файли:**
- [`overview.md`](./overview.md) — Загальний огляд проєкту
- [`repo-map.md`](./repo-map.md) — Карта репозиторію
- [`root-files-audit.md`](./root-files-audit.md) — Аудит файлів в корені
- [`cleanup-report.md`](./cleanup-report.md) — Звіт про очищення
- [`GPT_35_REMINDER.md`](./GPT_35_REMINDER.md) — Нагадування про GPT-3.5

### 📦 Архів
**Папка:** [`archive/`](./archive/)

Архівні документи та старі версії документації.

## 🚀 Швидкий старт

### Для розробників
1. Почніть з [`overview.md`](./overview.md) для загального розуміння
2. Ознайомтесь з [`legislation-rag/README.md`](./legislation-rag/README.md) для Legislation RAG
3. Перегляньте [`README_INTEGRATION.md`](./README_INTEGRATION.md) для інтеграції

### Для архітекторів
1. [`legislation-rag/01_overview.md`](./legislation-rag/01_overview.md) — Архітектура Legislation RAG
2. [`supreme_court_rag.md`](./supreme_court_rag.md) — Архітектура Supreme Court RAG
3. [`legislation-rag/state_snapshot.md`](./legislation-rag/state_snapshot.md) — Поточний стан системи

### Для тестувальників
1. [`legislation-rag/reports/REPORT.md`](./legislation-rag/reports/REPORT.md) — Звіт про тестування
2. [`supreme_court_benchmark.md`](./supreme_court_benchmark.md) — Бенчмарки

## 📝 Конвенції документації

- Всі документи в Markdown форматі
- Дата створення та останнього оновлення внизу документа
- Посилання на пов'язані документи
- Чіткі секції та структура

## 🔄 Оновлення документації

При додаванні нових документів:
1. Додайте посилання в цей README
2. Оновіть відповідний індекс (наприклад, `legislation-rag/README.md`)
3. Додайте дату створення/оновлення

---

**Останнє оновлення:** 2025-01-10
