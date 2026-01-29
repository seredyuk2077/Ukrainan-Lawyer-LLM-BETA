# Baseline Audit — 190 Documents

**Дата:** 2026-01-26  
**Мета:** Зняти baseline стану системи перед повним аудитом

---

## Supabase Baseline

### Загальна статистика
- **total_docs:** 190 ✅
- **null_doc_type_slug:** 0 ✅
- **null_category:** 0 ✅
- **null_document_number:** 0 ✅
- **null_storage_category:** 0 ✅
- **null_content_hash:** 0 ✅

### Sync Health Distribution
- **health_green:** 189 (99.5%)
- **health_yellow:** 1 (0.5%)
- **health_red:** 0 ✅
- **health_null:** 0 ✅

### Status Distribution
- **qdrant_indexed:** 189 (99.5%)
- **sync_synced:** 190 (100%) ✅

### Document Type Slug Distribution (Top 10)
1. `cmu_order`: 55 (28.9%)
2. `cmu_resolution`: 46 (24.2%)
3. `vr_resolution`: 26 (13.7%)
4. `nbu_letter`: 17 (8.9%)
5. `presidential_decree`: 10 (5.3%)
6. `presidential_order`: 5 (2.6%)
7. `convention`: 5 (2.6%)
8. `ccu_decision`: 4 (2.1%)
9. `code`: 4 (2.1%)
10. `instruction`: 3 (1.6%)

### Document Type (UA Label) Distribution (Top 10)
1. `Розпорядження КМУ`: 55
2. `Постанова КМУ`: 46
3. `Постанова ВРУ`: 26
4. `Повідомлення НБУ`: 17
5. `Указ Президента`: 10
6. `Розпорядження Президента України`: 5
7. `Конвенція`: 5
8. `Кодекс`: 4
9. `Рішення Конституційного Суду України`: 4
10. `Інструкція`: 3

### Category Distribution (Top 10)
1. `finance_banking`: 26 (13.7%)
2. `administrative`: 20 (10.5%)
3. `defense_mobilization`: 19 (10.0%)
4. `other`: 19 (10.0%) ⚠️
5. `business_corporate`: 18 (9.5%)
6. `international_eu`: 15 (7.9%)
7. `environment`: 8 (4.2%)
8. `energy_utilities`: 8 (4.2%)
9. `healthcare`: 7 (3.7%)
10. `national_security`: 6 (3.2%)

**⚠️ Увага:** `other` категорія має 19 документів (10%). Потрібно перевірити чи це кадрові/технічні документи або важливі акти.

---

## Yellow Health Document

**nreg:** `950-2007-п`  
**title:** `Про затвердження Регламенту Кабінету Міністрів України`  
**document_type_slug:** `cmu_resolution`  
**category:** `administrative`  
**expected_chunks:** 700  
**indexed_chunks:** 700 ✅  
**r2_key:** `legislation/other/950-2007-%D0%BF.json`  

**Примітка:** Chunks match, але health=yellow. Потрібно перевірити через `verify --nreg 950-2007-п --evidence`.

---

## R2 Baseline

### Sample Files (з list_files)
- `legislation/administrative/21-2026-%D1%80.json` (173 KB)
- `legislation/administrative/80731-10.json` (4.1 MB)
- `legislation/administrative/80732-10.json` (2.1 MB)
- `legislation/administrative/nb07d710-25.json` (119 KB)

**Примітка:** Canonical файли існують. Потрібно перевірити чи всі 190 r2_key з Supabase існують в R2.

---

## Qdrant Baseline

**Очікується:**
- `lexery_legislation_acts`: 189 points (1 per indexed document)
- `lexery_legislation_chunks`: sum of `indexed_chunks` for all indexed documents

**Примітка:** Потрібно перевірити через `verify --all` чи Qdrant counts match Supabase.

---

## Наступні кроки

1. ✅ Baseline знято
2. ⏳ Запустити `verify --all --evidence --write-health`
3. ⏳ Запустити `detect-type-absurdities --all`
4. ⏳ Створити audit-таблицю з evidence (Supabase + canonical + Qdrant + signals)
5. ⏳ Створити parser integrity audit (перевірка зсуву статей)

---

**Baseline зафіксовано 2026-01-26.**
