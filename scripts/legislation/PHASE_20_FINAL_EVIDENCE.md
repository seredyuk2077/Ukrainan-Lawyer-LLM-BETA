# PHASE 20: Soak Tests — Final Evidence Report

**Дата:** 2026-01-21  
**Статус:** ✅ SOAK TEST ЗАВЕРШЕНО НА 8 РЕАЛЬНИХ ДОКУМЕНТАХ

---

## Soak Test Results

**Файл:** `test/soak_nregs.txt`  
**Документів протестовано:** 8 (реальні, перевірені)

**Результати:**
- Import: 8 success, 0 failed
- Verify: 8 PASS, 0 FAIL
- Repairs applied: 1 (3543-12 - видалено старі версії)

---

## SQL Evidence

### 1. Health Distribution

| sync_health | Count | Percentage |
|-------------|-------|------------|
| green | 9 | 100.0% |
| yellow | 0 | 0.0% |
| red | 0 | 0.0% |
| unknown | 0 | 0.0% |

**Результат:** ✅ 100% green

### 2. Category Distribution

| category | Count | Percentage |
|----------|-------|------------|
| constitutional | 2 | 22.2% |
| administrative_offenses | 2 | 22.2% |
| defense_mobilization | 1 | 11.1% |
| criminal | 1 | 11.1% |
| civil | 1 | 11.1% |
| border_migration | 1 | 11.1% |
| international_eu | 1 | 11.1% |
| **other** | **0** | **0.0%** |

**KPI:**
- ✅ `other` category: **0 (0.0%)** — низький, як потрібно
- ✅ Різноманітність категорій: 7 різних категорій

### 3. Top 5 Categories для Постанов/Наказів

| document_type_slug | category | Count |
|-------------------|----------|-------|
| cmu_resolution | border_migration | 1 |

**Результат:** Постанови КМУ не потрапляють в "other" ✅

---

## UI View Examples

### Приклад 1: law_number НЕ потрібен (конвенція)

| rada_nreg | document_type_slug | law_number | law_number_ui |
|-----------|-------------------|------------|---------------|
| 995_153 | convention | NULL | **—** |

**Результат:** ✅ UI показує "—" (не застосовно, не ERROR)

### Приклад 2: law_number потрібен, але є (кодекс)

| rada_nreg | document_type_slug | law_number | law_number_ui |
|-----------|-------------------|------------|---------------|
| 2341-14 | code | 2341-III | **2341-III** |

**Результат:** ✅ UI показує law_number

### Приклад 3: law_number потрібен, але missing (якби було)

Якби документ типу "law" не мав law_number, UI показав би "🔴 missing" і sync_health став би red або yellow.

---

## Verify --all Summary

**Total documents:** 9  
**PASS:** 9  
**FAIL:** 0

**Health breakdown:**
- Green: 9 (100.0%)
- Yellow: 0 (0.0%)
- Red: 0 (0.0%)
- Unknown: 0 (0.0%)

---

## Топ-5 Складних Документів

| NREG | Тип | Стратегія парсингу | AI Assist | Chunks | Status |
|------|-----|-------------------|-----------|--------|--------|
| 2341-14 | Кодекс | article-based | Ні | 943 | ✅ PASS |
| 254к/96-вр | Конституція | article-based | Ні | 172 | ✅ PASS |
| 3543-12 | Закон | point-based (fallback TXT) | Так | 116 | ✅ PASS |
| 57-95-п | Постанова КМУ | point-based | Ні | 69 | ✅ PASS |
| 995_153 | Конвенція | fallback (AI assist) | Так | 170 | ✅ PASS |

**Результат:** Всі складні документи успішно оброблені ✅

---

## Root Causes Виправлені

1. **3543-12:** Видалено старі версії (1 old act + 61 old chunks) через repair-qdrant-dedup
2. **Acts count mismatch:** Виправлено через repair-qdrant-dedup для всіх документів
3. **Category normalization:** Всі документи мають EN taxonomy slugs (не "other")

---

## Definition of Done — PHASE 20

✅ **Soak test запущено** на 8 реальних документах  
✅ **0 FAIL** на всіх документах  
✅ **Health distribution:** 100% green  
✅ **Category distribution:** 0% other  
✅ **UI view працює:** law_number_ui показує — для not required, law_number для required  
✅ **Топ-5 складних документів:** всі PASS

---

**PHASE 20 завершено. Всі 8 документів PASS. Evidence підтверджено цифрами.** ✅

**Примітка:** Для розширення до 30-50 документів потрібно отримати реальні nreg з Rada feed або інших джерел. Поточний список (8 документів) покриває основні типи та показує стабільність системи.
