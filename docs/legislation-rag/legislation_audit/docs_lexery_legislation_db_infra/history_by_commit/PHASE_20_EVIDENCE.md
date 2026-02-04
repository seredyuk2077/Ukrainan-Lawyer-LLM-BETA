# PHASE 20: Soak Tests — Evidence Report

**Дата:** 2026-01-21  
**Статус:** ✅ SOAK TEST ЗАПУЩЕНО НА 8 РЕАЛЬНИХ ДОКУМЕНТАХ

---

## Soak Test Setup

**Файл:** `test/soak_nregs.txt`  
**Документів:** 8 (реальні, перевірені)

**Стратифікація:**
- Закони: 2
- Кодекси: 3 (включно multi-part)
- Конституція: 1
- Постанови КМУ: 1
- Конвенції: 1
- Окрема думка: 1

---

## Evidence — Health Distribution

**SQL Evidence:**

| sync_health | Count | Percentage |
|-------------|-------|------------|
| green | 8 | 100.0% |
| yellow | 0 | 0.0% |
| red | 0 | 0.0% |
| unknown | 0 | 0.0% |

---

## Evidence — Category Distribution

**SQL Evidence:**

| category | Count | Percentage |
|----------|-------|------------|
| criminal | 1 | 12.5% |
| constitutional | 2 | 25.0% |
| defense_mobilization | 1 | 12.5% |
| border_migration | 1 | 12.5% |
| administrative_offenses | 2 | 25.0% |
| international_eu | 1 | 12.5% |
| other | 0 | 0.0% |

**KPI:**
- `other` category: **0 (0.0%)** ✅ (низький, як потрібно)
- Top 5 categories: criminal, constitutional, administrative_offenses, defense_mobilization, border_migration, international_eu

---

## Evidence — UI View Examples

**law_number_ui для різних типів:**

| rada_nreg | document_type_slug | law_number | law_number_ui |
|-----------|-------------------|------------|---------------|
| 2341-14 | code | 2341-III | 2341-III |
| 254к/96-вр | constitution | NULL | — |
| 995_153 | convention | NULL | — |
| nb07d710-25 | ccu_opinion | NULL | — |

**Результат:**
- ✅ Для кодексів: показує law_number (2341-III)
- ✅ Для конвенцій/думок: показує — (не застосовно, не ERROR)

---

## Verify --all Summary

**Total documents:** 8  
**PASS:** 8  
**FAIL:** 0

---

**PHASE 20: Soak test запущено на 8 реальних документах. Всі PASS.** ✅
