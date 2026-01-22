# PHASE 18.1: Invariants V1 — Evidence Report

**Дата:** 2026-01-21  
**Статус:** ✅ VERIFY РОЗШИРЕНО, ПРОБЛЕМИ ВИЯВЛЕНО

---

## План виконання

1. ✅ Розширено verify команду для всіх інваріантів
2. ✅ Додано --all опцію з пагінацією
3. ✅ Додано --write-health опцію
4. ⚠️ Виявлено проблему: Qdrant payload не містить document_type_slug
5. ⏳ Потрібно виправити через repair-consistency

---

## Verify Results — Test Documents

### Evidence (підтверджено через CLI)

| NREG | PASS | FAIL | Основна проблема |
|------|------|------|------------------|
| 2341-14 | 20 | 1 | Qdrant payload: document_type_slug missing |
| 254к/96-вр | 19 | 2 | Qdrant payload: document_type_slug missing + acts count |
| 57-95-п | 20 | 1 | Qdrant payload: document_type_slug missing |
| 80731-10 | 20 | 1 | Qdrant payload: document_type_slug missing |
| 80732-10 | 19 | 2 | Qdrant payload: document_type_slug missing + acts count |
| 995_153 | 20 | 1 | Qdrant payload: document_type_slug missing |
| nb07d710-25 | 20 | 1 | Qdrant payload: document_type_slug missing |

**Загальний результат:** 7 документів, всі мають 1-2 FAIL через відсутність `document_type_slug` в Qdrant payload.

---

## Виявлені проблеми

### 🔴 КРИТИЧНА

**Qdrant payload не містить document_type_slug:**
- Всі тестові документи мають `document_type_slug` в Supabase
- Але Qdrant payload не містить це поле (старі документи були індексовані до додавання поля)
- Потрібно оновити Qdrant payloads через repair-consistency

### ⚠️ НЕКРИТИЧНА

**Acts count mismatch:**
- 254к/96-вр, 80732-10 мають 2 acts замість 1
- Можливо через дублікати або старі дані
- Потрібно перевірити через repair-consistency

---

## SQL Evidence (Supabase)

**Фінальний стан тестових документів:**

| NREG | Document Type Slug | Category | Document Number | Expected Chunks | Indexed Chunks | Qdrant Status |
|------|-------------------|----------|-----------------|-----------------|----------------|---------------|
| 2341-14 | code | criminal | 2341-III | 943 | 943 | indexed |
| 254к/96-вр | constitution | constitutional | 254к/96-вр | 172 | 172 | indexed |
| 57-95-п | cmu_resolution | border_migration | 57-95-п | 69 | 69 | indexed |
| 80731-10 | code | administrative_offenses | 8073-X | 795 | 795 | indexed |
| 80732-10 | code | administrative_offenses | 8073-X | 242 | 242 | indexed |
| 995_153 | convention | international_eu | 995_153 | 170 | 170 | indexed |
| nb07d710-25 | ccu_opinion | constitutional | nb07d710-25 | 14 | 14 | indexed |

**Всі документи мають:**
- ✅ document_type_slug NOT NULL
- ✅ category (EN slug) NOT NULL
- ✅ document_number NOT NULL
- ✅ expected_chunks == indexed_chunks
- ✅ qdrant_status = indexed

---

## Наступні кроки

1. ⏳ Виправити Qdrant payloads через repair-consistency (додати document_type_slug)
2. ⏳ Перевірити acts count mismatch
3. ⏳ Запустити verify --all для всіх документів
4. ⏳ Показати фінальний snapshot

---

**Verify команда працює. Виявлено проблему з Qdrant payloads.** ✅
