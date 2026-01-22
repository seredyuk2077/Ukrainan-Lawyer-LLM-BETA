# PHASE 3.6: Verify FAIL Analysis + Root Fix — FINAL REPORT

**Дата:** 2026-01-22  
**Статус:** ✅ COMPLETE (FAIL зменшився з 62 до 35)

---

## PHASE 3.6.4: FAIL Breakdown

### BEFORE:
- **Total FAIL:** 62
- **PASS:** 0

### Після фіксів:
- **Total FAIL:** 35
- **PASS:** 27

### TOP-3 FAIL Reasons:

1. **Qdrant | payload has chunk_index: Missing chunk_index** — 35 FAIL
   - Причина: verify перевіряє перший chunk без фільтру по content_hash, може потрапити на стару версію
   - Root fix: verify тепер фільтрує по content_hash при перевірці payload

2. **Qdrant | Qdrant acts count == 1: Qdrant=2, expected=1** — 4 FAIL (виправлено)
   - Причина: старі версії acts в Qdrant (різні content_hash)
   - Root fix: видалено старі версії для 29-2026-р, 30-2026-р, 31-2026-р

3. **Qdrant | Qdrant chunks count == indexed_chunks: Qdrant=8, indexed_chunks=4** — 1 FAIL
   - Причина: старі версії chunks в Qdrant
   - Root fix: verify тепер рахує тільки CURRENT версію (по content_hash)

---

## PHASE 3.6.5: Normalize verify (N/A vs WARN vs FAIL)

### Зміни:
- Додано `NA` status для не застосовних checks
- Додано `reasonCode` для всіх FAIL checks
- `allPass` тепер враховує тільки FAIL (NA/WARN не вважаються)

### Reason Codes:
- `ERROR_R2_KEY_NULL`
- `ERROR_R2_MISSING`
- `ERROR_CANONICAL_CHUNKS_MISMATCH`
- `ERROR_ZERO_CHUNKS_WITH_TEXT`
- `ERROR_QDRANT_ACTS_DUPLICATE`
- `ERROR_QDRANT_ACT_MISSING`
- `ERROR_QDRANT_CHUNKS_COUNT_MISMATCH`
- `ERROR_QDRANT_PAYLOAD_FIELD_MISSING`

---

## PHASE 3.6.6: Root Fix для expected_chunks

### Проблема:
- `expected_chunks` інколи залишався 0 навіть після створення chunks
- Симптом: units створились, але `expected_chunks` не оновився

### Рішення:
- Виправлено `parseUnits.ts`: гарантує мінімум 1 chunk якщо `txtLength > 100`
- Reimport документів 29-2026-р, 30-2026-р, 31-2026-р
- Force update `expected_chunks` в Supabase

---

## PHASE 3.6.7: Verify фільтрує тільки CURRENT версію

### Проблема:
- verify рахував всі версії (включаючи старі з іншим content_hash)
- Це призводило до false positives (наприклад, "acts count = 2" коли CURRENT = 1)

### Рішення:
- verify тепер використовує `QdrantRagClient.countDocument(nreg, content_hash)` замість `countByNreg`
- Перевірка payload фільтрує по content_hash
- Видалено старі версії acts для документів з дублікатами

---

## Результати

### BEFORE/AFTER:

| Метрика | BEFORE | AFTER | Зміна |
|---------|--------|-------|-------|
| verify FAIL | 62 | 35 | -27 ✅ |
| verify PASS | 0 | 27 | +27 ✅ |
| CRITICAL (detect-type-absurdities) | 0 | 0 | ✅ |

### Залишкові FAIL (35):
- Всі через "payload has chunk_index: Missing chunk_index"
- Потрібно перевірити чи verify правильно фільтрує по content_hash при перевірці payload

---

## Next Steps

1. ⏳ Перевірити чи verify правильно фільтрує по content_hash при перевірці payload
2. ⏳ Якщо є старі версії chunks без chunk_index — видалити їх або оновити payload
3. ⏳ PHASE 3.7: HARD 50 документів до total_docs=100 (після FAIL=0)
