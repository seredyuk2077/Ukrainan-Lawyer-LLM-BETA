# PROD-READINESS PROGRESS — Доведення до ідеалу

**Дата старту:** 2026-01-22  
**Мета:** Стабільна обробка будь-якого документа з rada.gov.ua

---

## Baseline Snapshot (PHASE 0)

### Загальна статистика:
- **total_docs:** 62
- **health_green:** 24
- **health_yellow:** 23
- **health_red:** 0 ✅
- **health_unknown:** 15
- **verify FAIL:** 0 ✅
- **detect-type-absurdities CRITICAL:** 0 ✅
- **chunks_mismatch:** 0 ✅
- **not_indexed:** 0 ✅

### Document Type Distribution (TOP-15):
1. cmu_resolution: 20
2. nbu_letter: 12
3. cmu_order: 9
4. vr_resolution: 5
5. code: 4
6. rnbo_decision: 2
7. regulation: 2
8. presidential_decree: 2
9. vr_speaker_order: 1
10. cec_resolution: 1
11. constitution: 1
12. convention: 1
13. law: 1
14. ccu_opinion: 1

### Category Distribution (TOP-15):
1. finance_banking: 14
2. other: 7
3. education_science: 5
4. defense_mobilization: 5
5. international_eu: 3
6. labor_social: 3
7. procurement: 3
8. administrative: 3
9. environment: 3
10. border_migration: 2
11. constitutional: 2
12. construction_urban: 2
13. national_security: 2
14. administrative_offenses: 2
15. transport_infrastructure: 1

---

## План виконання

### PHASE 1: Збір HARD 50 документів
- [ ] Створити feed-based collector
- [ ] Зібрати кандидатів з кошиками (Security/Defense, President, Parliament, Regulators, Elections, International, Weird)
- [ ] Сформувати `test/hard_batch_50.txt` + `test/hard_batch_50_reserve.txt`
- [ ] Створити manifest з причинами включення

### PHASE 2: Імпорт до 100 (батчами по 10)
- [ ] Batch 1-5: імпорт 50 документів (по 10)
- [ ] Після кожного батчу: verify + detect-type-absurdities (STOP RULE)
- [ ] Gate A: total_docs=100, FAIL=0, CRITICAL=0

### PHASE 3: Підсилення валідації
- [ ] Signal Engine для всіх критичних органів
- [ ] Unit tests для кожного сигналу
- [ ] Авто-override для CRITICAL конфліктів

### PHASE 4: Ручний аудит (після Gate A)
- [ ] Раунд 1: 20 документів (10 складних + 10 рандомних)
- [ ] Раунд 2: 20 документів (10 складних + 10 рандомних)
- [ ] Root fix для знайдених mismatch

### PHASE 5: Розширення до 200
- [ ] +10 → 110 (Gate check)
- [ ] +20 → 130 (Gate check)
- [ ] +70 → 200 (Gate check)
- [ ] Gate B: total_docs=200, FAIL=0, CRITICAL=0

### PHASE 6: Фінальний звіт
- [ ] PROD_READINESS_REPORT.md
- [ ] BEFORE/AFTER таблиці
- [ ] Distribution stats
- [ ] Known constraints

---

## Поточний статус

**Останнє оновлення:** 2026-01-22  
**Поточний етап:** PHASE 0 (Baseline)  
**Наступний крок:** PHASE 1 (Збір HARD 50)
