# PHASE 6: Real World Large Doc Test — ККУ (2341-14)

**Дата:** 2026-01-21  
**Статус:** ✅ УСПІШНО ЗАВЕРШЕНО

---

## Результати тесту

### Імпорт
- **NREG:** 2341-14
- **Назва:** Кримінальний кодекс України
- **Document Type:** Кодекс
- **Category:** criminal ✅
- **Parsing Strategy:** article-based (TXT fallback)
- **Units parsed:** 932 units
- **Expected chunks:** 943
- **Indexed chunks:** 943 ✅
- **Qdrant status:** indexed ✅
- **Qdrant acts:** 1 ✅
- **Qdrant chunks:** 943 ✅

### Act Group
- **act_group_key:** кримінальний-кодекс-україни-3df2a0456095f118
- **act_is_part:** false
- **act_part_label:** null

### Час виконання
- **Total time:** ~80.68 секунд
- **R2 upload:** ~4.3 MB canonical JSON
- **Embeddings:** 943 chunks (batch size: 32 для великих документів)
- **Qdrant upsert:** 943 chunks + 1 act

### Проблеми під час виконання
1. **⚠️ updated_at column missing:** 
   - Помилка: `Could not find the 'updated_at' column of 'legislation_import_jobs'`
   - Вплив: Не критично, progress tracking працює через `progress_data`
   - Виправлено: Прибрано оновлення `updated_at` (колонка не існує в схемі)

2. **⚠️ Qdrant count error в тесті:**
   - Помилка: `Not Found` при спробі count через неправильну назву колекції
   - Виправлено: Використання правильних констант `QDRANT_COLLECTION_ACTS`, `QDRANT_COLLECTION_CHUNKS`

---

## Acceptance Criteria

### ✅ Імпорт завершився успішно
- `qdrant_status=indexed` ✅
- `indexed_chunks == expected_chunks` (943 == 943) ✅
- Qdrant chunks count matches (943) ✅

### ✅ Parsing працює
- Strategy: article-based ✅
- Units: 932 units parsed ✅
- Chunks: 943 chunks created ✅

### ✅ Category визначено правильно
- Category: `criminal` (не `other`) ✅

### ✅ Act Group працює
- `act_group_key` згенеровано ✅
- `act_is_part=false` (окремий акт, не частина) ✅

---

## Пошук ✅

Тестові запити:

### 1. "кримінальна відповідальність"
**Результати:**
- [1] score=0.6094, rada_nreg=2341-14, article_number=41 ✅
- [2] score=0.6023, rada_nreg=2341-14, article_number=16 ✅
- ККУ знаходиться в топ-результатах ✅

### 2. "умисне вбивство"
**Результати:**
- [1] score=0.4908, rada_nreg=2341-14, article_number=116 ✅
- ККУ знаходиться в топ-результатах ✅

### 3. "необхідна оборона"
**Результати:**
- [1] score=0.6056, rada_nreg=2341-14, article_number=36 ✅
- ККУ знаходиться в топ-результатах ✅

**Висновок:** Пошук працює коректно, ККУ знаходиться в релевантних результатах.

---

## Висновки

1. **Система стабільно працює на великих документах:**
   - ККУ (943 chunks) імпортується без timeout
   - Progressive commits працюють (batch size 32 для embeddings)
   - Qdrant upsert працює стабільно

2. **Parsing працює:**
   - Article-based strategy обрано правильно
   - 932 units → 943 chunks (з chunking overlap)

3. **AI Enrichment працює:**
   - Category `criminal` визначено правильно (не `other`)

4. **Act Group працює:**
   - `act_group_key` згенеровано детерміновано
   - Для окремих актів `act_is_part=false`

---

## Наступні кроки

1. ✅ Перевірити пошук (queries вище)
2. ⏳ Тест resume механізму (якщо потрібно)
3. ⏳ PHASE 7: Corpus Tests (після підтвердження пошуку)

---

## Файли

- Test command: `scripts/legislation/commands/test-kku.ts`
- Report: `scripts/legislation/runs/kku_2341_14_run_*.json`
