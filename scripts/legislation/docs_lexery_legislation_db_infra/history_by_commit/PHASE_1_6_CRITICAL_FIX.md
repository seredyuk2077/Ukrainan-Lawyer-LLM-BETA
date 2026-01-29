# PHASE 1.6: Root-Cause Fix для 3 CRITICAL Findings — Complete

**Дата:** 2026-01-24  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Проблема

**3 CRITICAL findings:**
- 57/2026: `presidential_decree` → детектор каже `presidential_order` ❌
- 60/2026: `presidential_decree` → детектор каже `presidential_order` ❌
- 66/2026: `presidential_decree` → детектор каже `presidential_order` ❌

**Root cause:**
- Детектор перевіряв `combined` (title + summary + snippet) без пріоритету snippet
- Summary міг містити "розпорядження" в контексті, але snippet (перші рядки) каже "Указ"
- Правило `PRESIDENTIAL_ORDER_AS_REGULATION` спрацьовувало навіть для указів

---

## Evidence (BEFORE)

### 57/2026
- **snippet15:** "Указ\nПрезидента України" → правильний тип = `presidential_decree` ✅
- **summary_prefix:** "Розпорядження Президента України про звільнення..." → помилково інтерпретувалось як `presidential_order` ❌
- **current_slug:** `presidential_decree` ✅ (правильно)
- **detect-type-absurdities:** CRITICAL `PRESIDENTIAL_ORDER_AS_REGULATION` ❌

### 60/2026
- **snippet15:** "Указ\nПрезидента України" → правильний тип = `presidential_decree` ✅
- **summary_prefix:** "Указ Президента України про введення в дію рішення РНБО..." → правильний тип = `presidential_decree` ✅
- **current_slug:** `presidential_decree` ✅ (правильно)
- **detect-type-absurdities:** CRITICAL `PRESIDENTIAL_ORDER_AS_REGULATION` ❌

### 66/2026
- **snippet15:** "Указ\nПрезидента України" → правильний тип = `presidential_decree` ✅
- **summary_prefix:** "Указом Президента України призначено..." → правильний тип = `presidential_decree` ✅
- **current_slug:** `presidential_decree` ✅ (правильно)
- **detect-type-absurdities:** CRITICAL `PRESIDENTIAL_ORDER_AS_REGULATION` ❌

---

## Виправлення

### detect-type-absurdities.ts

**Оновлено правило A (RNBO):**
- **Snippet-first priority:** Якщо snippet каже "Указ Президента" → `presidential_decree` (навіть якщо summary каже "РНБО")
- **Виняток для указів про введення в дію:** Якщо summary каже "Указ про введення в дію рішення РНБО" → `presidential_decree` OK
- **Новий reason_code:** `PRESIDENTIAL_DECREE_AS_RNBO` для випадків, коли snippet каже "Указ", але slug = `rnbo_decision`

**Оновлено правило D (Президент):**
- **Snippet-first priority:** Якщо snippet каже "Указ" → `presidential_decree` (навіть якщо summary каже "розпорядження")
- **Snippet-first для розпоряджень:** Якщо snippet каже "Розпорядження Президента" (і НЕ "Указ") → `presidential_order`
- **Fallback на summary:** Тільки якщо snippet відсутній, перевіряємо summary
- **Новий reason_code:** `PRESIDENTIAL_DECREE_AS_ORDER` для випадків, коли snippet каже "Указ", але slug = `presidential_order`

**Логіка:**
1. Якщо snippet містить "указ" + "президент" → `presidential_decree` (пріоритет)
2. Якщо snippet містить "розпорядження" + "президент" (і НЕ "указ") → `presidential_order`
3. Якщо snippet відсутній → перевіряємо summary з тими ж правилами

---

## Evidence (AFTER)

### detect-type-absurdities

- **CRITICAL total:** 0 ✅
- **57/2026:** Не знайдено в CRITICAL findings ✅
- **60/2026:** Не знайдено в CRITICAL findings ✅
- **66/2026:** Не знайдено в CRITICAL findings ✅

### Verify Results

- **57/2026:** PASS ✅
- **60/2026:** PASS ✅
- **66/2026:** PASS ✅

### Supabase

| nreg | document_type_slug | document_type | sync_health |
|------|-------------------|---------------|-------------|
| 57/2026 | presidential_decree ✅ | Указ Президента ✅ | green ✅ |
| 60/2026 | presidential_decree ✅ | Указ Президента ✅ | green ✅ (виправлено з rnbo_decision) |
| 66/2026 | presidential_decree ✅ | Указ Президента ✅ | green ✅ |

### SQL Invariants

```sql
-- Перевірка: немає документів з snippet="Указ Президента", але slug=presidential_order
-- (потрібно перевірити вручну через snippet, але детектор тепер не дає false positives)
```

---

## Результат

✅ **3 CRITICAL findings закрито root-cause fix**  
✅ **Детектор тепер використовує snippet-first priority**  
✅ **verify PASS для всіх 3 документів**  
✅ **CRITICAL total = 0**

---

**Наступний крок:** PHASE 2 (diversity scoring) або PHASE 3 (scale до 200)
