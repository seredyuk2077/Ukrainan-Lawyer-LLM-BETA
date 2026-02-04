# PHASE 19-20: Final Evidence Report

**Дата:** 2026-01-21  
**Статус:** ✅ PHASE 19 ЗАВЕРШЕНО, PHASE 20 ГОТОВО ДО ЗАПУСКУ

---

## PHASE 19: Supabase UX Dashboard — Complete

### 1. VIEW `legislation_documents_ui` створено

**Колонки:**
- `health_badge` (перша) — 🟢/🟡/🔴/⚪
- `health_label` — OK/WARN/ERROR/UNKNOWN
- `health_rank` — для сортування
- `law_number_ui` — 🔴 missing / —
- `legal_status_ui` — 🟢 active / 🟡 inactive / ⚪ unknown
- `sync_issue_ui` — — / 🔴 missing reason
- `act_group_key_ui` / `act_part_label_ui` — — / 🔴 missing

### 2. verify --write-health працює

**Логіка:**
- GREEN: всі інваріанти PASS
- RED: критичні помилки
- YELLOW: часткові проблеми
- UNKNOWN: недостатньо даних

### 3. Health Distribution (після write-health)

**SQL Evidence:**

| sync_health | Count | Percentage |
|-------------|-------|------------|
| green | 8 | 100.0% |
| yellow | 0 | 0.0% |
| red | 0 | 0.0% |
| unknown | 0 | 0.0% |

**VIEW Health Badges:**

| health_badge | health_label | Count |
|--------------|--------------|-------|
| 🟢 | OK | 8 |
| 🟡 | WARN | 0 |
| 🔴 | ERROR | 0 |
| ⚪ | UNKNOWN | 0 |

---

## PHASE 20: Soak Tests — Ready

### Створено

1. **`test/soak_nregs.txt`** — список з 8 базових документів
2. **`commands/soak-test.ts`** — runner для soak tests
3. **CLI команда:** `admin-cli soak-test [--file <file>] [--dry-run] [--no-repair]`

### Готово до запуску

**Поточний список (8 документів):**
- 3543-12 (закон)
- 2341-14 (кодекс)
- 80731-10, 80732-10 (кодекс, multi-part)
- 254к/96-вр (конституція)
- 57-95-п (постанова КМУ)
- 995_153 (конвенція)
- nb07d710-25 (окрема думка)

**Для розширення:**
- Потрібно додати укази, накази, інструкції, договори
- Можна використати Rada API для пошуку різноманітних типів

---

## SQL Evidence — VIEW Examples

**Приклади записів з VIEW:**

| health_badge | rada_nreg | title | sync_health | law_number_ui | legal_status_ui |
|--------------|-----------|-------|-------------|---------------|-----------------|
| 🟢 | 2341-14 | Кримінальний кодекс України | green | 2341-III | ⚪ unknown |
| 🟢 | 254к/96-вр | Конституція України | green | — | ⚪ unknown |
| 🟢 | 3543-12 | Про мобілізаційну підготовку... | green | 3543-XII | ⚪ unknown |
| 🟢 | 57-95-п | Постанова КМУ... | green | 57-95-п | ⚪ unknown |

---

## Інструкція для Supabase Dashboard

1. **Відкрити:** Data Editor → `legislation_documents_ui` (VIEW)
2. **Сортування:** по `health_rank` (ASC) — red спочатку
3. **Фільтрація:**
   - Red: `health_badge = '🔴'`
   - Yellow: `health_badge = '🟡'`
   - Green: `health_badge = '🟢'`
   - Unknown: `health_badge = '⚪'`

---

## Definition of Done — PHASE 19

✅ **VIEW створено** — `legislation_documents_ui` з health badges  
✅ **verify --write-health працює** — заповнює sync_health/sync_issue  
✅ **Health semantics реалізовано** — green/yellow/red/unknown  
✅ **8/8 документів мають sync_health=green**  
✅ **VIEW показує UI-friendly колонки** — немає "страшних NULL"

---

**PHASE 19 завершено. PHASE 20 готово до запуску.** ✅
