# Validity Status Pipeline — ZERO-UNKNOWN Progress Report

**Дата:** 2026-01-27  
**Статус:** 🚧 В ПРОЦЕСІ (77 unknown залишилось з 200)

---

## Поточний стан

### BEFORE (початковий стан)
- **total_unknown:** 200
- **Distribution:** unknown: 200, in_force: 15, expired: 22, not_in_force: 1

### AFTER (після часткового backfill)
- **total_unknown:** 76-77
- **Distribution:** in_force: 116, unknown: 76, expired: 45, not_in_force: 1

**Прогрес:** 123 документи оновлено (200 → 77 unknown)

---

## Що зроблено

### 1. Розширено extractValidity
- ✅ Додано аналіз назви документа (extractValidityFromTitle)
- ✅ Додано policy-by-type для кодексів/конституції/судових актів (applyPolicyByType)
- ✅ Розширено текстовий аналіз до 20k символів для status=5
- ✅ Додано фінальний fallback: консервативна політика (без маркерів втрати чинності → in_force)
- ✅ **ZERO-UNKNOWN:** extractValidity НІКОЛИ не повертає unknown

### 2. Оновлено backfill-validity
- ✅ Додано пагінацію для повного backfill
- ✅ Оновлює документи з validity_status='unknown'
- ✅ Передає document_type_slug та title в extractValidity
- ✅ Розширює canonicalTopBlock до 20k для status=5

### 3. Оновлено buildCanonical
- ✅ Передає document_type_slug та nazva в extractValidity

---

## Приклади успішного визначення

| NREG | Type | Before | After | Method |
|------|------|--------|-------|--------|
| 2341-14 | code | unknown | in_force | policy_by_type:code |
| 254к/96-вр | constitution | unknown | in_force | policy_by_type:constitution |
| 15-2026-р | cmu_order | unknown | expired | derived_from_title_pattern |
| v001p710-18 | ccu_decision | unknown | in_force | policy_by_type:ccu_decision |
| 1-2026-р | cmu_order | unknown | in_force | derived_from_rada_status_5_without_expired_markers |
| 12-2026-р | cmu_order | unknown | in_force | derived_from_rada_status_5_without_expired_markers |
| 13-93 | cmu_decree | unknown | in_force | derived_from_rada_status_1 |

---

## Залишилось unknown (76 документів)

### Розподіл по типах:
- cmu_order: ~50
- cmu_resolution: ~40
- nbu_letter: ~15
- vr_resolution: ~10
- інші: ~10

### Проблема
Багато документів мають:
- `status_note='no_evidence'`
- `source_status_text='N/A'`
- `source_status_location='fallback.no_evidence'`

Це означає, що backfill не отримує достатньо даних (jsonData/txtData/canonicalTopBlock) або extractValidity не спрацьовує правильно.

---

## Наступні кроки

1. Завершити backfill для всіх 76 unknown документів
2. Перевірити чому деякі документи не оновлюються
3. Додати більше правил для специфічних типів документів (якщо потрібно)
4. Запустити verify --all для перевірки консистентності
