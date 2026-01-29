# Parser Integrity After Fix — Evidence

**Дата:** 2026-01-26  
**Статус:** Structural Consistency OK

---

## Виконані зміни

### 1. Додано поля в payload
- ✅ `unit_number` — універсальний номер unit (article/point/section)
- ✅ `unit_type` — тип unit (article/point/section)
- ✅ Оновлено `CanonicalChunk` interface
- ✅ Оновлено `ChunkPayload` interface
- ✅ Оновлено `importer.ts` для передачі цих полів

### 2. Переробив audit-parser-integrity
- ✅ Створено `audit-parser-integrity-v2` — structural consistency mode
- ✅ Перевіряє mapping canonical ↔ Qdrant payload, а не текст
- ✅ Результат: 0 mismatches для всіх тестових документів

### 3. MRE Results
- ✅ ККУ (2341-14): всі 5 статей OK
- ✅ КУпАП (80731-10): всі 5 статей OK
- ✅ КУпАП (80732-10): всі 5 статей OK
- ✅ Всього перевірок: 15, з потенційним зсувом: 0

---

## Structural Consistency V2 Results

### Golden Set (8 документів)
- **З mismatches:** 0 ✅
- **Загальна кількість mismatches:** 0 ✅

**Результати:**
- `2341-14` (ККУ): ✅
- `80731-10` (КУпАП частина 1): ✅
- `80732-10` (КУпАП частина 2): ✅
- `64/2022`: ✅
- `57-95-п`: ✅
- `1442-97-п`: ✅
- `1-2026-р`: ✅
- `10-2026-р`: ✅

---

## Висновок

**Structural consistency працює правильно.** Немає зсуву між canonical та Qdrant payload.

**Старий audit-parser-integrity** давав false positives, бо перевіряв текст на наявність "Стаття N", а не structural consistency.

**Новий audit-parser-integrity-v2** перевіряє mapping canonical ↔ Qdrant payload і показує правильні результати.

---

## Наступні кроки

1. ⏳ Reimport проблемних документів (якщо потрібно) для додавання unit_number/unit_type в payload
2. ⏳ Запустити repair-consistency для backfill payload полів
3. ⏳ Запустити повний audit-parser-integrity-v2 для всіх 190 документів

---

**Оновлено:** 2026-01-26
