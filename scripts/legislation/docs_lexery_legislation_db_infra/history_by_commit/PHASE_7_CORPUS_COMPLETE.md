# PHASE 7: Corpus Tests + Batch Report Generator — COMPLETED

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО (з незначними проблемами)

---

## Результати Corpus Test

### Summary
- **Total documents:** 4
- **Successful:** 3/4 (75%)
- **Failed:** 1/4 (Конституція)
- **Warnings:** 0
- **Avg time per doc:** 48.58s

### Детальні результати

| nreg | doc_type | strategy | expected | indexed | category | status |
|------|----------|----------|----------|---------|----------|--------|
| 3543-12 | Закон | article-based | 61 | 61 | defense_mobilization | ✅ |
| 2341-14 | Кодекс | article-based | 943 | 943 | criminal | ✅ |
| 57-95-п | Постанова КМУ | point-based | 69 | 69 | інше | ✅ |
| 254к/96-ВР | Конституція | article-based | 172 | 0 | N/A | ⚠️ |

---

## Аналіз результатів

### ✅ Успішні імпорти

1. **3543-12 (ЗУ про мобілізацію)**
   - Strategy: article-based ✅
   - Category: `defense_mobilization` (не `other`!) ✅
   - Chunks: 61/61 ✅
   - Time: 53.9s

2. **2341-14 (ККУ)**
   - Strategy: article-based ✅
   - Category: `criminal` ✅
   - Chunks: 943/943 ✅
   - Time: 68.1s

3. **57-95-п (Постанова КМУ)**
   - Strategy: point-based (TXT fallback) ✅
   - Category: `інше` (можна покращити, але не критично)
   - Chunks: 69/69 ✅
   - Time: 40.9s
   - **Важливо:** No-empty-index policy спрацювала — TXT fallback дав chunks > 0 ✅

### ⚠️ Проблеми

1. **254к/96-ВР (Конституція)**
   - Expected chunks: 172
   - Indexed chunks: 0 ❌
   - Category: undefined ❌
   - Status: undefined ❌
   - **Потрібно дослідити:** Чому не індексується? Можливо проблема в Qdrant upsert або Supabase update.

---

## Висновки

### ✅ Позитивні результати

1. **Parsing працює для різних типів:**
   - Article-based для законів/кодексів ✅
   - Point-based для постанов ✅
   - TXT fallback спрацював для постанови ✅

2. **Category classification:**
   - `defense_mobilization` для ЗУ про мобілізацію ✅
   - `criminal` для ККУ ✅
   - "Other" використовується рідко (тільки для постанови, що не критично)

3. **No-empty-index policy:**
   - Постанова 57-95-п має 69 chunks (не 0!) ✅
   - TXT fallback спрацював автоматично ✅

4. **Batch processing:**
   - Великі документи (ККУ 943 chunks) обробляються стабільно ✅
   - Progressive commits працюють ✅

### ⚠️ Проблеми для вирішення

1. **Конституція не індексується:**
   - Потрібно перевірити логіку імпорту для Конституції
   - Можливо проблема в спеціальному форматі nreg (`254к/96-ВР`)

2. **Category для постанов:**
   - 57-95-п має category=`інше` (можна покращити через AI prompt)

---

## Команди

```bash
# Запуск corpus test
pnpm tsx scripts/legislation/admin-cli.ts test-corpus \
  --file scripts/legislation/test/corpus_nregs.txt \
  --concurrency 2 \
  --report

# Перегляд звіту
cat scripts/legislation/runs/corpus_report_*.md
```

---

## Наступні кроки

1. ⏳ Виправити проблему з Конституцією (254к/96-ВР)
2. ⏳ Покращити category classification для постанов
3. ⏳ PHASE 8: Docs + Final Polish
