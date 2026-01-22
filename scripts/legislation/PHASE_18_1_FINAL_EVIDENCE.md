# PHASE 18.1: Invariants V1 — Final Evidence

**Дата:** 2026-01-21  
**Статус:** ✅ VERIFY РОЗШИРЕНО, REPAIR ОНОВЛЕНО

---

## Виконано

### 1. Розширено verify команду

**Додано перевірки:**
- ✅ A) Supabase core: document_type_slug, category, document_number, storage_category, act_group sanity, chunks >= 0, qdrant_status=indexed ⇒ chunks match
- ✅ B) R2: r2_key exists, canonical JSON valid, chunks > 0 для indexable
- ✅ C) Qdrant: points count == indexed_chunks, payload fields (rada_nreg, r2_key, json_path, chunk_index, content_hash), payload document_type_slug/category matches Supabase
- ✅ D) Cross-store: canonical chunks == expected_chunks, Qdrant points == indexed_chunks

**Додано опції:**
- ✅ `--all` з пагінацією (--page, --page-size)
- ✅ `--write-health` для автоматичного заповнення sync_health

### 2. Оновлено repair-consistency

**Додано оновлення document_type_slug в Qdrant payloads:**
- ✅ Перевіряє чи payload.document_type_slug !== Supabase.document_type_slug
- ✅ Оновлює через qdrant.setPayload() без перевставляння векторів

---

## Evidence — Test Documents

### Before Repair

| NREG | Verify Result | Основна проблема |
|------|---------------|------------------|
| 2341-14 | PASS: 20 / FAIL: 1 | Qdrant payload: document_type_slug missing |
| 995_153 | PASS: 20 / FAIL: 1 | Qdrant payload: document_type_slug missing |
| nb07d710-25 | PASS: 20 / FAIL: 1 | Qdrant payload: document_type_slug missing |

### After Repair

**Очікується:** PASS: 21 / FAIL: 0 (після repair consistency)

---

## SQL Evidence (Supabase)

**Фінальний стан:**

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

1. ⏳ Запустити repair consistency для всіх тестових документів
2. ⏳ Перевірити verify після repair
3. ⏳ Запустити verify --all для всіх документів
4. ⏳ Показати фінальний snapshot

---

**Verify команда працює. Repair оновлено для document_type_slug.** ✅
