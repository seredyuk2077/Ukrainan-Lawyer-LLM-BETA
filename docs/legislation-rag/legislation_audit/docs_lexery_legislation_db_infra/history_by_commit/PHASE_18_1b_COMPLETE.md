# PHASE 18.1b: FIX "ACTS COUNT MISMATCH" — Complete

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Виконано

### 1. Evidence знято

**Створено inspect-qdrant-acts.ts:**
- Перевіряє acts count для всіх 8 тестових документів
- Показує point IDs та payloads
- Виявляє старі версії (інший content_hash)

**Результат:**
- 3 документи мали 2 acts замість 1 (254к/96-вр, 80732-10, nb07d710-25)
- Причина: старі версії з іншим content_hash не видалялися

### 2. Виправлення

**Створено repair-qdrant-dedup.ts:**
- Видаляє acts/chunks з іншим content_hash (старі версії)
- Залишає тільки поточну версію (з current content_hash)

**Оновлено verify.ts:**
- Acts count MUST be exactly 1 (FAIL якщо != 1)
- Виводить конкретні числа: expected vs actual

### 3. Застосовано виправлення

**Видалено старі версії:**
- 254к/96-вр: 1 old act + 172 old chunks
- 80732-10: 1 old act + 477 old chunks
- nb07d710-25: 1 old act

**Всього видалено:** 3 old acts + 649 old chunks

---

## Evidence — Final Verify Results

| NREG | PASS | FAIL | Status |
|------|------|------|--------|
| 2341-14 | 22 | 0 | ✅ All checks passed! |
| 254к/96-вр | 22 | 0 | ✅ All checks passed! |
| 3543-12 | 22 | 0 | ✅ All checks passed! |
| 57-95-п | 22 | 0 | ✅ All checks passed! |
| 80731-10 | 22 | 0 | ✅ All checks passed! |
| 80732-10 | 22 | 0 | ✅ All checks passed! |
| 995_153 | 22 | 0 | ✅ All checks passed! |
| nb07d710-25 | 22 | 0 | ✅ All checks passed! |

**Результат:** 8/8 документів PASS ✅

---

## SQL Evidence (Supabase)

**Всі 8 документів:**
- ✅ `document_type_slug` NOT NULL
- ✅ `category` (EN slug) NOT NULL
- ✅ `document_number` NOT NULL
- ✅ `expected_chunks` == `indexed_chunks`
- ✅ `qdrant_status` = indexed
- ✅ `invariant_status` = PASS

---

## Qdrant Evidence

**Acts count (після repair):**
- ✅ 8/8 документів мають acts=1
- ❌ 0/8 документів мають acts≠1

**Chunks count:**
- ✅ Всі документи: chunks count == indexed_chunks

---

## Підсумок

### ✅ Виконано

1. **Evidence знято:** Виявлено 3 документи з acts count mismatch
2. **Виправлення створено:** repair-qdrant-dedup команда
3. **Verify оновлено:** Acts count == 1 тепер FAIL (не warning)
4. **Виправлення застосовано:** Видалено 3 old acts + 649 old chunks
5. **Фінальна перевірка:** 8/8 документів PASS

### 🔒 Блокер вирішено

**Acts count mismatch = 0** ✅

---

**PHASE 18.1b завершено. Всі 8 тестових документів PASS.** ✅
