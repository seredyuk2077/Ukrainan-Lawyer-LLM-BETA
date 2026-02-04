# PHASE 6.2: ROOT FIX sync_health NULL — Complete

**Дата:** 2026-01-24  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Проблема

- **total_docs:** 131
- **health_null:** 83 ❌
- **health_green:** 24
- **health_yellow:** 24
- **health_red:** 0
- **health_unknown:** 0

**Root cause:**
- CHECK constraint дозволяв тільки `('green', 'yellow', 'red')`, але НЕ `'unknown'`
- `verify --write-health` намагався встановити `'unknown'`, але constraint блокував оновлення
- Через це `sync_health` залишався NULL після імпорту
- DEFAULT не був встановлений

---

## Виправлення

### 1. DB Level (Migration)

```sql
-- 1. Drop old constraint
ALTER TABLE legislation_documents 
DROP CONSTRAINT IF EXISTS legislation_documents_sync_health_check;

-- 2. Update всі NULL → 'unknown'
UPDATE legislation_documents 
SET sync_health = 'unknown' 
WHERE sync_health IS NULL;

-- 3. Додати новий constraint з 'unknown'
ALTER TABLE legislation_documents 
ADD CONSTRAINT legislation_documents_sync_health_check 
CHECK (sync_health IN ('green', 'yellow', 'red', 'unknown'));

-- 4. Додати DEFAULT 'unknown'
ALTER TABLE legislation_documents 
ALTER COLUMN sync_health SET DEFAULT 'unknown';
```

### 2. Code Level

- ✅ Додано інваріант в `verify.ts`: `sync_health IS NOT NULL`
- ✅ Виправлено пошук перевірок: використовується `includes()` для знаходження перевірок з "(CURRENT version)"

### 3. Pipeline Level

- ✅ Batch-скрипт вже викликає `verify --write-health` після кожного імпорту
- ✅ `verify --all --write-health` оновлює всі документи

---

## Post-Fix Evidence

### Health Distribution

| sync_health | Count | Percentage |
|-------------|-------|------------|
| green | 131 | 100.0% |
| yellow | 0 | 0.0% |
| red | 0 | 0.0% |
| unknown | 0 | 0.0% |
| **null** | **0** | **0.0%** ✅ |

### Verify Results

- **total_docs:** 131
- **verify FAIL:** 0 ✅
- **verify PASS:** 131/131 ✅

### Sample Documents (legislation_documents_ui)

| nreg | title_prefix | document_type_slug | category | health_badge |
|------|--------------|-------------------|----------|--------------|
| 1-2026-п | Про внесення змін до Порядку... | cmu_resolution | energy_utilities | 🟢 |
| 50-2026-р | Про звільнення Шевцова М.М... | cmu_order | defense_mobilization | 🟢 |
| 49-2026-р | Про звільнення Козенка О.В... | cmu_order | defense_mobilization | 🟢 |
| 48-2026-р | Про звільнення Клочка А.О... | cmu_order | defense_mobilization | 🟢 |
| 47-2026-р | Про звільнення Заверухи В.О... | cmu_order | defense_mobilization | 🟢 |

### DB Schema

- **column_default:** `'unknown'::text` ✅
- **is_nullable:** `YES` (залишено для legacy сумісності)
- **constraint:** `CHECK (sync_health IN ('green', 'yellow', 'red', 'unknown'))` ✅

---

## Інваріанти

1. ✅ `sync_health IS NOT NULL` (перевіряється в verify)
2. ✅ `sync_health IN ('green', 'yellow', 'red', 'unknown')` (DB constraint)
3. ✅ DEFAULT 'unknown' для нових рядків
4. ✅ Batch-імпорт завжди викликає `verify --write-health` після кожного документа

---

## Результат

✅ **sync_health НІКОЛИ не залишається NULL після імпорту/verify**  
✅ **Всі 131 документ мають sync_health='green'**  
✅ **UX-індикатор працює для всіх документів**  
✅ **Система готова до продовження Batch 3..N**

---

**Наступний крок:** PHASE 6.3 — Batch 3..N до 200 з диверсифікацією
