# Статус Рефакторингу Імпортера

**Дата:** 2026-01-25  
**Статус:** 🟡 В ПРОЦЕСІ

---

## ✅ Виконано

### 1. Структура для Аудиту
- [x] Створено шаблон audit record (`REFACTOR_AUDIT_TEMPLATE.md`)
- [x] Створено команду `audit-documents` (`commands/audit-documents.ts`)
- [x] Додано команду в `admin-cli.ts`

### 2. Validity Extractor (КРИТИЧНО) ⭐
- [x] Створено модуль `canonical/extractValidity.ts`
- [x] Витягує чинність з `jsonData.status` та тексту
- [x] Нормалізує в enum: `ACTIVE`, `REPEALED`, `NOT_IN_FORCE`, `PARTIALLY_IN_FORCE`, `UNKNOWN`
- [x] Інтегровано в `buildCanonical.ts`
- [x] Додано поля validity в `CanonicalMetadata`

### 3. База Даних
- [x] Додано міграцію для полів validity:
  - `validity_status` (TEXT, CHECK constraint)
  - `valid_from` (DATE)
  - `valid_to` (DATE)
  - `status_note` (TEXT)
  - `source_status_text` (TEXT)
  - `source_status_location` (TEXT)
- [x] Оновлено `importer.ts` для заповнення нових полів

---

## ⏳ В Процесі

### 4. Ручний Аудит
- [ ] Провести ручний аудит 190 документів (по 10-20 за раз)
- [ ] Класифікувати баги по класах (A/B/C/D/E)
- [ ] Визначити root cause для кожного класу

---

## 📋 Планується

### 5. Structure Parser (КРИТИЧНО) ⭐
- [ ] Виправити fallback нумерацію: `number: struNumber || String(units.length + 1)` → не використовувати індекс
- [ ] Додати поля: `number_value_structured`, `order_key`
- [ ] Вилучити редакційні примітки/виноски з структурних вузлів

### 6. Canonical Resolver
- [ ] Створити модуль `lib/canonicalResolver.ts`
- [ ] Визначати canonical identifier + canonical URL
- [ ] "Прибивати" редакцію: latest vs історична
- [ ] Перевіряти redirects

### 7. Metadata Extractor (рефакторинг)
- [ ] doc_type НЕ з заголовка як primary, а з метаданих
- [ ] Додати confidence + explanation trace
- [ ] Використовувати `jsonData.typ`, `jsonData.organs` як primary source

### 8. Normalizer
- [ ] Unicode normalization (NFKC)
- [ ] Прибрати NBSP/soft hyphen
- [ ] Уніфікувати тире/лапки

### 9. Chunker (рефакторинг)
- [ ] Додати anchors: `article_number / section/chapter labels`
- [ ] Stable path: `"ККУ > Розділ ... > Стаття 115 > Частина 1"`
- [ ] Chunk boundaries не повинні відривати номер від контенту

### 10. Validator
- [ ] Інваріанти: якщо в тексті є "Стаття 115" => має бути вузол article=115
- [ ] Якщо validity = NOT_IN_FORCE => не можна показувати як ACTIVE

### 11. Reimport Всіх 190 Документів
- [ ] Створити команду `update-all` або batch update
- [ ] Перезалити всі 190 документів з новими полями validity

### 12. Ручна Повторна Перевірка
- [ ] Пройти всі 190 документів вручну
- [ ] Поставити ✅ у after_fix_check
- [ ] Перевірити зсув статей у великих кодексах (ККУ та інші)

---

## 🎯 Пріоритети

1. **КРИТИЧНО:** ✅ Validity Extractor + поля в БД (ВИКОНАНО)
2. **КРИТИЧНО:** ⏳ Structure Parser — виправити fallback нумерацію
3. **ВАЖЛИВО:** ⏳ Ручний аудит для виявлення всіх проблем
4. **ВАЖЛИВО:** ⏳ Canonical Resolver
5. **ПОКРАЩЕННЯ:** ⏳ Metadata Extractor, Normalizer, Validator

---

## 📝 Наступні Кроки

1. ⏳ Почати ручний аудит (10-20 документів)
2. ⏳ Виправити fallback нумерацію в Structure Parser
3. ⏳ Створити Canonical Resolver
4. ⏳ Reimport всіх 190 документів з validity

---

## 🔍 Тестування

Після кожного кроку:
- [ ] Typecheck PASS
- [ ] Тестовий імпорт 1-2 документів
- [ ] Перевірка що validity заповнюється правильно
- [ ] Перевірка що нумерація не зсувається
