# PHASE 18.1b: FIX "ACTS COUNT MISMATCH" — Evidence

**Дата:** 2026-01-21  
**Статус:** ✅ BLOCKER ВИПРАВЛЕНО

---

## Проблема

**Acts count mismatch:** 3 документи мали 2 acts замість 1 через старі версії з іншим content_hash.

---

## Evidence (Before Fix)

**Qdrant Acts Count:**

| NREG | Acts Count | Status |
|------|------------|--------|
| 2341-14 | 1 | ✅ OK |
| 254к/96-вр | 2 | ❌ MISMATCH (1 current + 1 old) |
| 3543-12 | 1 | ✅ OK |
| 57-95-п | 1 | ✅ OK |
| 80731-10 | 1 | ✅ OK |
| 80732-10 | 2 | ❌ MISMATCH (1 current + 1 old) |
| 995_153 | 1 | ✅ OK |
| nb07d710-25 | 2 | ❌ MISMATCH (1 current + 1 old) |

**Root Cause:**
- Старі версії документів (з іншим content_hash) не видалялися з Qdrant
- IDs детерміновані (через qdrantIds.ts), тому проблема не в ID
- Проблема в cleanup: importer не видаляє старі версії перед upsert

---

## Виправлення

### 1. Створено repair-qdrant-dedup команду

**Логіка:**
- Отримує current content_hash з Supabase
- Знаходить всі acts/chunks для nreg
- Видаляє acts/chunks з іншим content_hash (старі версії)
- Якщо є дублікати з поточним hash — залишає один

### 2. Оновлено verify

**Додано перевірку:**
- Acts count MUST be exactly 1 (FAIL якщо != 1)
- Chunks count == indexed_chunks (вже було)

---

## Evidence (After Fix)

**Qdrant Acts Count (після repair-qdrant-dedup):**

| NREG | Acts Count | Status |
|------|------------|--------|
| 2341-14 | 1 | ✅ OK |
| 254к/96-вр | 1 | ✅ FIXED (видалено 1 old act + 172 old chunks) |
| 3543-12 | 1 | ✅ OK |
| 57-95-п | 1 | ✅ OK |
| 80731-10 | 1 | ✅ OK |
| 80732-10 | 1 | ✅ FIXED (видалено 1 old act + 477 old chunks) |
| 995_153 | 1 | ✅ OK |
| nb07d710-25 | 1 | ✅ FIXED (видалено 1 old act) |

**Summary:**
- ✅ Correct (acts=1): 8/8
- ❌ Mismatches (acts≠1): 0/8

---

## Verify Results (After Fix)

| NREG | PASS | FAIL | Status |
|------|------|------|--------|
| 2341-14 | 22 | 0 | ✅ All checks passed! |
| 254к/96-вр | 22 | 0 | ✅ All checks passed! |
| 3543-12 | 21 | 1 | ⚠️ 1 FAIL (потрібно перевірити) |
| 57-95-п | 22 | 0 | ✅ All checks passed! |
| 80731-10 | 22 | 0 | ✅ All checks passed! |
| 80732-10 | 22 | 0 | ✅ All checks passed! |
| 995_153 | 22 | 0 | ✅ All checks passed! |
| nb07d710-25 | 22 | 0 | ✅ All checks passed! |

**Результат:** 7/8 документів PASS, 1/8 має 1 FAIL (3543-12).

---

## Видалені старі версії

- **254к/96-вр:** 1 old act + 172 old chunks
- **80732-10:** 1 old act + 477 old chunks
- **nb07d710-25:** 1 old act

**Всього видалено:** 3 old acts + 649 old chunks

---

**PHASE 18.1b завершено. Acts count mismatch виправлено.** ✅
