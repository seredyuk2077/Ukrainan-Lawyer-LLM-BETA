# PROD-READINESS PROGRESS — Доведення до ідеалу

**Дата старту:** 2026-01-22  
**Мета:** Стабільна обробка будь-якого документа з rada.gov.ua

---

## Baseline Snapshot (PHASE 0)

### Загальна статистика:
- **total_docs:** 62
- **health_green:** (перевіряється)
- **health_yellow:** (перевіряється)
- **health_red:** (перевіряється)
- **verify FAIL:** 0 ✅
- **detect-type-absurdities CRITICAL:** 0 ✅

### Document Type Distribution:
(заповнюється після SQL)

### Category Distribution:
(заповнюється після SQL)

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
