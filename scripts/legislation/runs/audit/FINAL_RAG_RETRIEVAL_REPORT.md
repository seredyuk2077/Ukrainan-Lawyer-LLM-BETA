# Final RAG Retrieval Report — Comprehensive Testing

**Дата:** 2026-01-26  
**Статус:** ⚠️ **RETRIEVAL QUALITY ISSUE** (не structural зсув)

---

## Executive Summary

**Висновок:** Structural consistency OK (payload правильний), але є проблема з retrieval quality для запиту "умисне вбивство".

**Проблема:** Для запиту "умисне вбивство" топ результат — ст.116 замість ст.115 (off-by-one в retrieval ranking, не в structural consistency).

**Root Cause:** Ст.116 ("Умисне вбивство, вчинене в стані сильного душевного хвилювання") має вищий semantic similarity score (0.4909) ніж ст.115 ("Умисне вбивство") (0.4597) для запиту "умисне вбивство".

---

## Comprehensive Test Results

### Test Cases (6 тестів)

| Test | Query | Expected | Top Result | Status | Shift |
|------|-------|----------|------------|--------|-------|
| Умисне вбивство | "умисне вбивство" | ст.115 | ст.116 | ⚠️ PARTIAL | 🔴 YES |
| Кримінальна відповідальність | "кримінальна відповідальність підстава" | ст.2 | ст.2 | ✅ PASS | ✅ NO |
| Необхідна оборона | "необхідна оборона" | ст.36 | ст.36 | ✅ PASS | ✅ NO |
| Крадіжка | "крадіжка" | ст.185 | ст.185 | ✅ PASS | ✅ NO |
| Шахрайство | "шахрайство" | ст.190 | ст.190 | ✅ PASS | ✅ NO |
| Вбивство за необережністю | "вбивство за необережністю" | ст.119 | ст.119 | ✅ PASS | ✅ NO |

**Статистика:**
- ✅ Passed: 5/6 (83%)
- ⚠️ Partial (in top3): 1/6 (17%)
- ❌ Failed: 0/6 (0%)
- 🔴 With shift: 1/6 (17%)

---

## Детальний аналіз проблеми "умисне вбивство"

### Retrieval Results (Top 10)

| Rank | Article | Score | Status |
|------|---------|-------|--------|
| 1 | ст.116 | 0.4909 | ❌ Wrong (expected ст.115) |
| 2 | ст.115 | 0.4597 | ✅ Correct |
| 3 | ст.118 | 0.4293 | - |
| 4 | ст.126 | 0.3917 | - |
| 5 | ст.120 | 0.3854 | - |

**Аналіз:**
- Ст.115 є в top3 (rank 2), але не на першому місці
- Ст.116 має вищий score через більшу кількість релевантних слів у тексті
- Ст.116: "Умисне вбивство, вчинене в стані сильного душевного хвилювання"
- Ст.115: "Умисне вбивство"

### Structural Consistency Check

✅ **Payload правильний:**
- Ст.115 chunks мають `article_number: "115"` ✅
- Ст.116 chunks мають `article_number: "116"` ✅
- Немає structural зсуву між canonical та Qdrant payload ✅

### Root Cause

**Це НЕ structural зсув**, а проблема з **retrieval quality**:
1. Embeddings для ст.116 мають вищу semantic similarity з запитом "умисне вбивство"
2. Ст.116 містить більше релевантних слів у тексті
3. Vector search повертає ст.116 як найбільш релевантний результат

**Рішення:**
1. Покращити формування запиту (додати контекст "основна стаття про умисне вбивство")
2. Додати re-ranking на основі article_number (якщо запит містить номер статті)
3. Додати фільтрацію по article_number для точних запитів
4. Покращити embeddings (fine-tuning на законодавчих документах)

---

## PROD READY щодо "зсуву статей"

**Статус:** ✅ **YES** (structural consistency)

**Обґрунтування:**
1. ✅ Structural consistency OK — немає зсуву між canonical та Qdrant payload
2. ✅ MRE показує, що всі перевірки OK
3. ✅ audit-parser-integrity-v2 показує 0 mismatches
4. ✅ 5/6 retrieval тестів пройдені успішно
5. ⚠️ 1/6 тестів має retrieval quality issue (не structural зсув)

**Відома проблема:**
- Retrieval quality для запиту "умисне вбивство" (ст.116 замість ст.115 в топі)
- Це проблема з embeddings/retrieval ranking, не зі structural consistency
- Ст.115 є в top3, тому RAG все одно може знайти правильну відповідь

---

## Evidence файли

- `runs/audit/RAG_SANITY_COMPREHENSIVE.json` — comprehensive test results
- `runs/audit/RAG_SANITY_COMPREHENSIVE.md` — Markdown звіт
- `runs/audit/FINAL_RAG_RETRIEVAL_REPORT.md` — цей звіт

---

**Оновлено:** 2026-01-26
