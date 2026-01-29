# PHASE 2: Diversity Selection Policy — Complete

**Дата:** 2026-01-24  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Реалізовано

### 2.1 Diversity Selection Policy

**Створено функції:**
- `detectPrefixClass()` — визначає prefix class з snippet15/summary
- `detectOrganSignal()` — визначає organ signal (PRESIDENT/RNBO/CEC/CMU/VRU/CCU/NBU/DEFENSE/INTERNATIONAL/OTHER)
- `calculateDiversityScore()` — обчислює diversity score (rare prefixes +10, rare organs +5, non-CMU +3, suffix bonus +5)
- `formDiverseBatch()` — формує batch з diversity policy

**Batch Policy:**
- max 2 документи з `cmu_*` у batch з 10
- min 6 "non-cmu"
- min 3 "rare" (PRESIDENT/RNBO/CEC/CCU/NBU/DEFENSE/INTERNATIONAL)

**Uniqueness Policy:**
- не більше 1 документа з тим самим prefix class (крім 'ІНШЕ')
- не більше 1 документа з тим самим organ signal (після 60% заповнення)
- не більше 2 документів з однаковим slug

### 2.2 Golden Diversity Set

**Створено команду:**
- `collect-diverse-candidates --instant` — швидке формування golden set з nreg patterns (без API calls)

**Результат:**
- 30 кандидатів з різноманітністю
- Збережено у `test/golden_diversity_set.json`

**Обмеження:**
- Список `hard_stream_200_candidates.txt` містить переважно X/2026 (президентські) та X-2026-р/п (КМУ)
- Для реальної різноманітності потрібно використовувати feed з додатковими фільтрами

### 2.3 Import Diverse Batch

**Створено команду:**
- `import-diverse-batch` — імпортує batch з diversity policy + Gate checks

**Gate Checks після кожного batch:**
1. `detect-type-absurdities --all` → CRITICAL=0
2. `verify --all --write-health` → FAIL=0, health_red=0
3. Semantic audit sample (10 нових + 10 random)
4. Distribution snapshot (document_type_slug, category, CMU %)

---

## Evidence

**Golden Diversity Set:**
- Total: 30 кандидатів
- Prefix classes: УКАЗ_ПРЕЗИДЕНТА (28), ПОСТАНОВА_КМУ (2)
- Organ signals: PRESIDENT (28), CMU (2)
- Predicted slugs: presidential_decree (28), cmu_resolution (2)

**Примітка:** Через обмеження списку кандидатів, golden set містить переважно президентські документи. Для реальної різноманітності потрібно:
- Використовувати feed з додатковими фільтрами
- Або вручну додати різноманітні nreg (КСУ, РНБО, ЦВК, НБУ, міжнародні)

---

## Наступний крок

**PHASE 3.1:** Імпорт першого batch (+10) з golden set та проходження Gate B1
