# PHASE 20B: Real Soak Tests — Status

**Дата:** 2026-01-22  
**Статус:** 🟡 IN PROGRESS

---

## Виконано

✅ **20B.1: Збір 30-50 документів програмно**
- Створено `test/collect_soak_nregs.ts` (спрощена версія)
- Зібрано **50 документів** з Rada feed (r.txt) + відомі різноманітні
- Файл: `test/soak_nregs.txt` (50 nreg)

✅ **20B.2: Запуск soak test**
- Soak test запущено на всіх 50 документах
- Процес працює в фоні
- Лог: `/tmp/soak_test_full.log`

---

## В процесі

🟡 **20B.3: Soak test цикл до 0 FAIL**
- Обробка документів триває
- Кожен документ: add → verify → repair (якщо FAIL) → verify знов
- Після завершення: verify --all --evidence

---

## Очікується

⏳ **20B.4: SQL Evidence**
- total_docs >= 30
- sync_health distribution
- category distribution
- document_type_slug distribution
- parsing_strategy distribution
- AI cache hit ratio

⏳ **20B.5: Definition of Done**
- 30-50 docs імпортовано і verified
- verify --all: 0 FAIL
- evidence показано цифрами

---

**Примітка:** Soak test обробляє 50 документів послідовно. Це займе ~30-60 хвилин залежно від складності документів та кількості repair циклів.
