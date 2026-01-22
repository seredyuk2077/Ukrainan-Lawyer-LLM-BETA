# Document Type V2 — Baseline Evidence (BEFORE)

**Дата:** 2026-01-22  
**Мета:** Baseline для порівняння після backfill

---

## A) Total

- **legislation_documents:** 50
- **legislation_import_jobs:** 97

### Jobs Distribution

| Status | Count | Percentage |
|--------|-------|------------|
| completed | 86 | 88.66% |
| failed | 7 | 7.22% |
| running | 4 | 4.12% |

---

## B) NULL Counts (Core Fields)

**Всі core поля заповнені (0 NULL):**
- `document_type_slug`: 0 NULL
- `document_type`: 0 NULL
- `category`: 0 NULL
- `document_number`: 0 NULL
- `storage_category`: 0 NULL
- `r2_key`: 0 NULL
- `content_hash`: 0 NULL

---

## C) Document Type Distribution

### Document Type Slug (Top 8)

| Slug | Count | Percentage |
|------|-------|------------|
| cmu_resolution | 20 | 40.00% |
| law | 14 | 28.00% |
| regulation | 6 | 12.00% |
| code | 4 | 8.00% |
| presidential_decree | 3 | 6.00% |
| convention | 1 | 2.00% |
| constitution | 1 | 2.00% |
| ccu_opinion | 1 | 2.00% |

### Document Type (UA Label) (Top 8)

| UA Label | Count | Percentage |
|----------|-------|------------|
| **Документ** | **20** | **40.00%** ⚠️ |
| Постанова КМУ | 14 | 28.00% |
| Постанова ВР | 5 | 10.00% |
| Кодекс | 5 | 10.00% |
| Розпорядження | 3 | 6.00% |
| Постанова | 1 | 2.00% |
| Конституція | 1 | 2.00% |
| Закон | 1 | 2.00% |

### Slug → Різні UA Labels (Проблема)

| Slug | Distinct UA Labels | UA Labels |
|------|-------------------|-----------|
| **cmu_resolution** | **3** | Постанова, Постанова ВР, Постанова КМУ ⚠️ |
| **law** | **2** | Документ, Закон ⚠️ |

**Проблема:** 1 slug має >1 різних UA labels (непослідовність).

---

## D) Аномалії

### Document Type = "Документ" (20 документів, 40%)

| Slug | Count | Percentage |
|------|-------|------------|
| law | 13 | 26.00% |
| regulation | 6 | 12.00% |
| convention | 1 | 2.00% |

**Проблема:** 20 документів мають `document_type='Документ'` навіть з правильним slug.

### CCU Opinion з неправильним UA Label

| NREG | Title | document_type | document_type_slug |
|------|-------|---------------|-------------------|
| nb07d710-25 | Окрема думка судді КСУ... | **Кодекс** ⚠️ | ccu_opinion |

**Проблема:** `ccu_opinion` має `document_type='Кодекс'` замість "Окрема думка судді КСУ".

---

## E) Health Distribution

| Health | Count | Percentage |
|--------|-------|------------|
| green | 24 | 48.00% |
| yellow | 22 | 44.00% |
| red | 3 | 6.00% |
| null | 1 | 2.00% |

---

## Підсумок проблем (BEFORE)

1. **40% документів мають `document_type='Документ'`** — потрібен backfill
2. **cmu_resolution має 3 різні UA labels** — потрібна стандартизація
3. **law має 2 різні UA labels** ("Документ", "Закон") — потрібна стандартизація
4. **ccu_opinion має неправильний UA label** ("Кодекс" замість "Окрема думка судді КСУ")
5. **44% yellow + 6% red health** — потрібно перевірити після backfill

---

**Цей baseline буде порівняно з AFTER backfill.**
