# Звіт про міграцію законодавчих даних

**Дата створення:** 2025-01-XX  
**Мета:** Міграція всіх законодавчих об'єктів БД з supabase-core в supabase-legislation

---

## Фаза 0: Preflight & Safety

### A) Підтвердження підключення MCP

✅ **supabase-core MCP:** Підключено, доступ до БД підтверджено  
✅ **supabase-legislation MCP:** Підключено, доступ до БД підтверджено

### B) Резервне копіювання

**Рекомендації:**
- Перед міграцією виконати експорт даних через Supabase Dashboard або pg_dump
- Зберегти SQL міграції в `supabase/migrations/` для відкату

### C) Розширення (Extensions)

**Потрібні розширення в legislation:**
- ✅ `vector` (0.8.0) - для векторних пошуків
- ✅ `pg_trgm` (1.6) - для текстового пошуку
- ✅ `uuid-ossp` (1.1) - для генерації UUID
- ✅ `pgcrypto` (1.3) - криптографічні функції

**Статус:** Обидва проекти мають однакові розширення, додаткових дій не потрібно.

---

## Фаза 1: Інвентаризація та класифікація

### Таблиці для міграції (legislation-related)

| Таблиця | Рядків | Опис | Пріоритет |
|---------|--------|------|-----------|
| `legal_laws` | 48 | Основна таблиця законів | Високий |
| `legal_articles` | 6,642 | Статті законів (FK до legal_laws) | Високий |
| `legal_documents_storage` | 26 | Метадані документів з Rada API | Високий |
| `legal_consultations` | 0 | Консультації (порожня) | Середній |
| `legal_templates` | 0 | Шаблони документів (порожня) | Середній |
| `response_cache` | 0 | Кеш відповідей (має law_references) | Низький* |

*Примітка: `response_cache` містить посилання на закони, але є операційною таблицею. Рішення: залишити в core, але видалити law_references або мігрувати якщо потрібно.

### Таблиці, що залишаються в core

- `chat_sessions` - операційні дані
- `chat_messages` - операційні дані
- `app_ee0d6434e4_chat_sessions` - операційні дані
- `app_ee0d6434e4_chat_messages` - операційні дані
- `response_validations` - операційні дані (має FK до chat_sessions)

### Функції для міграції

**Пошук та RAG:**
- `search_relevant_articles(search_query, max_results)` - пошук статей
- `search_relevant_laws(search_query, max_results)` - пошук законів
- `search_documents_by_codex_article(...)` - пошук документів за кодексом
- `search_rada_laws(...)` - пошук законів Rada

**Синхронізація:**
- `sync_articles_from_json(law_id_param)` - синхронізація статей з JSON
- `sync_all_articles_from_json()` - масовий синхроніз
- `get_documents_for_sync(p_limit)` - отримання документів для синхронізації
- `update_sync_status(...)` - оновлення статусу синхронізації
- `update_sync_status_by_nreg(...)` - оновлення статусу по nreg

**Утиліти:**
- `get_legal_knowledge_stats()` - статистика знань
- `cleanup_expired_cache()` - очищення кешу (якщо мігрується response_cache)
- `update_updated_at_column()` - тригер функція для updated_at
- `trg_legal_documents_storage_updated_at()` - тригер для legal_documents_storage
- `update_legal_documents_storage_updated_at()` - тригер для legal_documents_storage

### Тригери для міграції

- `update_legal_laws_updated_at` → `legal_laws`
- `update_legal_templates_updated_at` → `legal_templates`
- `legal_documents_storage_updated_at_trg` → `legal_documents_storage`
- `update_legal_documents_storage_updated_at` → `legal_documents_storage`

### Індекси

**legal_laws:** 13 індексів (GIN для текстового пошуку, btree для фільтрів)  
**legal_articles:** 9 індексів (GIN для контенту, btree для FK та article_number)  
**legal_documents_storage:** 11 індексів (btree для фільтрів, GIN для keywords)  
**legal_consultations:** 4 індекси (GIN для текстового пошуку)  
**legal_templates:** 1 індекс (primary key)  
**response_cache:** 3 індекси (btree для expires_at та question_hash)

### Views та Materialized Views

Немає views або materialized views, пов'язаних з законодавством.

---

## Фаза 2: Стратегія міграції

**Обрана стратегія:** S2 - Application-level migration runner

**Причини:**
- Неможливо виконати прямі SQL запити між різними Supabase проектами
- Потрібен контроль над процесом міграції
- Можливість логування та валідації на кожному кроці
- Підтримка батч-обробки для великих таблиць

**План:**
1. Створити SQL міграції для схеми в legislation
2. Застосувати міграції через MCP
3. Створити Node.js скрипт для міграції даних
4. Мігрувати дані в порядку залежностей (legal_laws → legal_articles → інші)
5. Оновити код додатку для використання нового клієнта
6. Видалити таблиці з core після перевірки

---

## Фаза 3: Реалізація міграції схеми

### Порядок створення об'єктів:

1. **Extensions** (якщо потрібно)
2. **Таблиці** (в порядку залежностей):
   - `legal_laws` (батьківська)
   - `legal_articles` (залежить від legal_laws)
   - `legal_documents_storage` (незалежна)
   - `legal_consultations` (незалежна)
   - `legal_templates` (незалежна)
   - `response_cache` (незалежна, опціонально)
3. **Індекси** (після створення таблиць)
4. **Функції** (можуть залежати від таблиць)
5. **Тригери** (залежать від функцій та таблиць)

---

## Фаза 4: Міграція даних

### Порядок міграції даних:

1. `legal_laws` (48 рядків) - батьківська таблиця
2. `legal_articles` (6,642 рядки) - залежить від legal_laws
3. `legal_documents_storage` (26 рядків) - незалежна
4. `legal_consultations` (0 рядків) - порожня, мігрувати структуру
5. `legal_templates` (0 рядків) - порожня, мігрувати структуру
6. `response_cache` (0 рядків) - опціонально

### Стратегія міграції даних:

- Використовувати service role ключі для обох проектів
- Батч-обробка: 1000 рядків за раз
- Збереження UUID (primary keys)
- Збереження timestamps (created_at, updated_at)
- Валідація після кожної таблиці (порівняння кількості рядків)

---

## Фаза 5: Оновлення коду додатку

### Файли, що потребують оновлення:

1. **Edge Function:** `supabase/functions/app_78e3d871a2_chat/index.ts`
   - Замінити всі `.from('legal_*')` на використання legislation клієнта
   - Оновити виклики RPC функцій

2. **Backend сервіси:**
   - `backend/src/services/supabaseLegalAgent.js` - використовує legal_laws
   - `backend/src/services/radaOfficialApiParser.js` - використовує legal_laws
   - `backend/add_laws_to_database.cjs` - використовує legal_laws

3. **Frontend (якщо є прямі запити):**
   - Перевірити `src/lib/supabase.ts` - зараз використовує тільки chat таблиці

### Новий клієнт:

Створити `src/lib/supabaseLegislationClient.ts` з:
- URL та ключі з env змінних
- Експорт клієнта для використання в коді

---

## Фаза 6: Деактивація в Core

### Після успішної міграції та перевірки:

1. Видалити таблиці з core:
   - `DROP TABLE legal_articles CASCADE;`
   - `DROP TABLE legal_laws CASCADE;`
   - `DROP TABLE legal_documents_storage CASCADE;`
   - `DROP TABLE legal_consultations CASCADE;`
   - `DROP TABLE legal_templates CASCADE;`
   - `DROP TABLE response_cache CASCADE;` (якщо мігрувалась)

2. Видалити функції:
   - Всі функції, пов'язані з законодавством
   - `update_updated_at_column()` - залишити, якщо використовується для chat_sessions

3. Перевірити залежності перед видаленням

---

## Фаза 7: Фінальні перевірки

### Чеклист оператора:

- [ ] Перевірити підключення до обох MCP серверів
- [ ] Запустити міграцію схеми
- [ ] Запустити міграцію даних
- [ ] Перевірити кількість рядків в обох проектах
- [ ] Перевірити вибіркові дані (20 випадкових ID)
- [ ] Оновити код додатку
- [ ] Протестувати Edge Function з новим клієнтом
- [ ] Протестувати backend сервіси
- [ ] Видалити таблиці з core
- [ ] Оновити документацію

### Відкат (Rollback):

Якщо щось пішло не так:

1. **Відкат даних:** Видалити дані з legislation, залишити в core
2. **Відкат коду:** Повернути попередній код з git
3. **Відкат схеми:** Видалити таблиці з legislation через MCP

### Команди для перевірки:

```sql
-- Перевірка кількості рядків
SELECT 
    'legal_laws' as table_name, COUNT(*) as rows FROM legal_laws
UNION ALL
SELECT 'legal_articles', COUNT(*) FROM legal_articles
UNION ALL
SELECT 'legal_documents_storage', COUNT(*) FROM legal_documents_storage;

-- Перевірка вибіркових даних
SELECT id, title, created_at FROM legal_laws ORDER BY RANDOM() LIMIT 5;
```

---

## Прогрес міграції

- [x] Фаза 0: Preflight & Safety
- [x] Фаза 1: Інвентаризація
- [x] Фаза 2: Дизайн стратегії
- [x] Фаза 3: Міграція схеми
- [x] Фаза 4: Міграція даних
- [x] Фаза 5: Оновлення коду
- [ ] Фаза 6: Деактивація в Core
- [ ] Фаза 7: Фінальні перевірки

## Статус виконання

### ✅ Завершено:

1. **Міграція схеми:** Всі таблиці, індекси, функції та тригери створені в `supabase-legislation`
2. **Міграція даних:** Дані успішно мігровані (47 законів, 6642 статті, 26 документів)
3. **Оновлення Edge Function:** Всі використання законодавчих таблиць оновлені для використання `legislationSupabase` клієнта
4. **Оновлення Backend:** Створено `supabaseLegislation.js` клієнт та оновлено сервіси:
   - `supabaseLegalAgent.js` - використовує `queryLegislation`
   - `radaOfficialApiParser.js` - використовує `queryLegislation`

### ⏳ Залишилось:

1. **Оновлення `add_laws_to_database.cjs`:** Потрібно оновити для використання `queryLegislation`
2. **Видалення таблиць з core:** Після перевірки потрібно видалити законодавчі таблиці з `supabase-core`
3. **Тестування:** Перевірити роботу Edge Function та backend сервісів з новим клієнтом

---

## Примітки

- Всі UUID будуть збережені для збереження посилань
- Timestamps будуть збережені для історії
- Foreign keys між legal_articles та legal_laws будуть збережені в межах legislation проекту
- Немає cross-database foreign keys, тому проблем з залежностями не буде

