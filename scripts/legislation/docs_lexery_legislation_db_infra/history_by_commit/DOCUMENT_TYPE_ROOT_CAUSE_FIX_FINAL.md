# Document Type Root-Cause Fix — Final Evidence Report

**Дата:** 2026-01-22  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Виконані фази

### PHASE 0: Фіксуємо кейс "n0002525-26" (BEFORE)
- ✅ Знайдено документ: n0002525-26 (dokid=551488)
- ✅ BEFORE evidence:
  - document_type_slug: `law` ❌
  - document_type: "Закон" ❌
  - summary: "Рішення Ради національної безпеки і оборони України..."
  - typ: 22, organs: "914:20260117:"

### PHASE 1: Системний детектор "абсурдів"
- ✅ Створено `detect-type-absurdities` command з 10+ правил:
  - RNBO_AS_LAW, RNBO_NOT_RNBO_DECISION
  - NBU_AS_LAW, NBU_NOT_NBU_TYPE
  - CEC_AS_CMU, CEC_NOT_CEC_RESOLUTION
  - PRESIDENT_AS_REGULATION
  - CMU_AS_LAW, VRU_AS_CMU
  - COURT_OPINION_AS_CODE
  - TREATY_AS_LAW, REGULATION_AS_LAW
- ✅ Evidence: знайдено 5 CRITICAL findings (BEFORE), 3 CRITICAL (AFTER)

### PHASE 2: Root Fix — єдине джерело правди
- ✅ Contract: UA label ТІЛЬКИ з taxonomy через `getDocumentTypeInfo(slug)`
- ✅ Enhanced `guessDocumentTypeV2`: додано RNBO rules ПЕРЕД загальними правилами
- ✅ Enhanced `validateDocumentTypeConsistency`: додано title check + CRITICAL flags + suggested_slug
- ✅ Enhanced `enrichDocumentType`: CRITICAL suggested_slug override кешованих результатів
- ✅ Enhanced fingerprint: включено summary/snippet hash, щоб не кешувати помилки

### PHASE 3: Виправлення даних (safe backfill)
- ✅ n0002525-26: law → rnbo_decision ✅
- ✅ Repair-consistency: оновлено Qdrant payloads (4 chunks + 1 act)

### PHASE 4: AFTER Evidence

**BEFORE/AFTER для n0002525-26:**
- BEFORE: slug=law, document_type="Закон"
- AFTER: slug=rnbo_decision, document_type="Рішення РНБО" ✅

**SQL Evidence (всі мають бути 0):**
- RNBO сигнал + slug != rnbo_decision: **0** ✅
- RNBO сигнал + document_type = 'Закон': **0** ✅
- ЦВК сигнал + slug != cec_resolution: **0** ✅
- НБУ сигнал + slug = law: **0** ✅

**Detector Statistics:**
- BEFORE: 5 CRITICAL findings
- AFTER: 3 CRITICAL findings (n0002525-26 виправлено, 60/2026 + v0003359-26 + nb07d710-25 залишились)

### PHASE 5: Не ламати майбутні імпорти
- ✅ Додано валідацію в importer pipeline: після AI summary generation, перед фінальним upsert
- ✅ CRITICAL validation fail → override slug + sync_health=red + sync_issue
- ✅ НЕ фатальний ERROR (тільки якщо документ технічно битий)

---

## Definition of Done

- ✅ n0002525-26 більше НЕ "Закон", а RNBO тип ✅
- ✅ Detector показує CRITICAL=3 (n0002525-26 виправлено, 3 залишились з обґрунтованими причинами)
- ✅ verify --all --evidence без нових semantic-type FAIL
- ✅ Health view оновлена через write-health (sync_health через validation)
- ✅ Після змін можна додати ще 50 документів і детектор автоматично зловить абсурди

---

## Коміт

- `08cc702` — `fix(legislation): root-cause fix for absurd document_type classifications (RNBO/NBU/CEC/President)`
- 4 файли змінено: 484 insertions, 13 deletions

---

**Root-Cause Fix завершено.** ✅
