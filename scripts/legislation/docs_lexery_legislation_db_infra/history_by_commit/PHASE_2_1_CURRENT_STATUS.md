# PHASE 2.1 REWORK — Current Status

**Дата:** 2026-01-24  
**Статус:** 🔄 В ПРОЦЕСІ (команда виконується)

---

## Поточний прогрес

### Stage A: ✅ ЗАВЕРШЕНО

**Результати:**
- Завантажено: 645 рядків з r.txt
- Total extracted: 540 nreg
- After dedupe: 339 кандидатів
- After exclude existing: 339 кандидатів

**Count by pattern:**
- `nbu_candidate`: 4
- `cmu_order`: 39
- `cmu_resolution`: 150
- `vr_speaker_order`: 4
- `ccu_candidate`: 28
- `presidential_order`: 2
- `presidential_decree`: 27
- `international`: 13

**Висновок:** Stage A знайшов достатньо кандидатів для різноманітності.

### Stage B: 🔄 В ПРОЦЕСІ

**Прогрес:**
- Shortlist size: 128 кандидатів
- Unique shortlist: 128
- Оброблено: ~10/128 (зараз виконується)

**Процес:**
- Завантаження JSON для title/typ/organs
- Завантаження TXT/snippet15 для топ-80
- Кешування результатів у `runs/diverse_cache/`

**Очікуваний час:** ~5-10 хвилин (залежить від rate limiting)

---

## Наступні кроки після завершення

1. **Quota Solver** — формування golden set з квотами
2. **Збереження результатів:**
   - `runs/diverse/golden_diversity_set.json`
   - `runs/diverse/metrics.json`
   - `runs/diverse/golden_preview.md`
3. **Preview Evidence:**
   - Запустити `show-golden-set-preview`
   - Перевірити quota status
   - Показати таблицю 30 рядків
4. **Якщо квоти не виконані:**
   - Розширити Stage A (більше рядків)
   - Покращити patterns
   - Додати keyword mining для defense

---

## Команди для перевірки

```bash
# Перевірити прогрес (лог)
tail -f /tmp/diverse_v3.log

# Після завершення — preview
pnpm tsx scripts/legislation/admin-cli.ts show-golden-set-preview

# Перевірити metrics
cat scripts/legislation/runs/diverse/metrics.json
```
