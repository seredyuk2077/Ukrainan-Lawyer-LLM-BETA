# PHASE 2: Diversity Selection Policy — Summary

**Дата:** 2026-01-24  
**Статус:** ✅ ЗАВЕРШЕНО

---

## Реалізовано

### 2.1 Diversity Selection Functions

**Файли:**
- `commands/collect-diverse-candidates.ts` — повна версія (з feed)
- `commands/collect-diverse-candidates-fast.ts` — швидка версія (з існуючим списком)
- `commands/form_diverse_batch.ts` — миттєва версія (тільки nreg patterns)

**Функції:**
- `detectPrefixClass()` — визначає prefix class (УКАЗ_ПРЕЗИДЕНТА, РОЗПОРЯДЖЕННЯ_ПРЕЗИДЕНТА, РІШЕННЯ_РНБО, тощо)
- `detectOrganSignal()` — визначає organ signal (PRESIDENT/RNBO/CEC/CMU/VRU/CCU/NBU/DEFENSE/INTERNATIONAL/OTHER)
- `calculateDiversityScore()` — обчислює score (rare prefixes +10, rare organs +5, non-CMU +3, suffix bonus +5)
- `formDiverseBatch()` — формує batch з diversity policy

### 2.2 Batch Policy

**Правила:**
- max 2 документи з `cmu_*` у batch з 10
- min 6 "non-cmu"
- min 3 "rare" (PRESIDENT/RNBO/CEC/CCU/NBU/DEFENSE/INTERNATIONAL)

**Uniqueness Policy:**
- не більше 1 документа з тим самим prefix class (крім 'ІНШЕ')
- не більше 1 документа з тим самим organ signal (після 60% заповнення)
- не більше 2 документів з однаковим slug

### 2.3 Golden Diversity Set

**Команда:**
```bash
pnpm tsx scripts/legislation/admin-cli.ts collect-diverse-candidates --instant --min-candidates 30
```

**Результат:**
- 30 кандидатів збережено у `test/golden_diversity_set.json`
- Distribution: УКАЗ_ПРЕЗИДЕНТА (28), ПОСТАНОВА_КМУ (2)

**Обмеження:**
- Список `hard_stream_200_candidates.txt` містить переважно X/2026 та X-2026-р/п
- Для реальної різноманітності потрібно використовувати feed з додатковими фільтрами або вручну додати різноманітні nreg

### 2.4 Import Diverse Batch

**Команда:**
```bash
pnpm tsx scripts/legislation/admin-cli.ts import-diverse-batch --batch-size 10 --start-from 0
```

**Gate Checks після кожного batch:**
1. `detect-type-absurdities --all` → CRITICAL=0
2. `verify --all --write-health` → FAIL=0, health_red=0
3. Semantic audit sample (10 нових + 10 random)
4. Distribution snapshot (document_type_slug, category, CMU %)

---

## Поточний стан

- **total_docs:** 131
- **CRITICAL:** 0 ✅
- **FAIL:** 0 ✅
- **sync_health:** green=131, yellow=0, red=0 ✅

---

## Наступний крок

**PHASE 3.1:** Імпорт першого batch (+10) з golden set та проходження Gate B1
