# PHASE 2.1 REWORK — Implementation Status

**Дата:** 2026-01-24  
**Статус:** 🔄 В ПРОЦЕСІ (команда виконується)

---

## Реалізовано

### 1. Двоетапна модель (Stage A/B)

**Stage A: Extraction з r.txt (ZERO API)**
- Завантаження r.txt (5000 рядків, якщо мало — 20000)
- Regex/pattern matching для витягування nreg:
  - `presidential_order`: `X/YYYY-рп`
  - `vr_speaker_order`: `X/YY-рг`
  - `cmu_resolution`: `X-YYYY-п`
  - `cmu_order`: `X-YYYY-р`
  - `presidential_decree`: `X/YYYY`
  - `international`: `XXX_YY` або `XXXX_YY`
  - `ccu_candidate`: `nb...` або `v0...`
  - `nbu_candidate`: `n000...`
- Дедуплікація та виключення існуючих nreg
- Metrics: total_extracted, after_dedupe, after_exclude_existing, count_by_pattern

**Stage B: Enrichment для shortlist (LIMITED API)**
- Формування shortlist по квотах (150-250 кандидатів макс)
- Кеш у `runs/diverse_cache/` (файл на кожен nreg)
- API calls тільки для shortlist:
  - JSON для title/typ/organs
  - TXT/snippet15 тільки для топ-80
- Metrics: shortlist_size, enriched_count, cache_hits, api_calls

### 2. Quota Solver

**Квоти (hard constraints):**
- presidential_decree: 2–4
- presidential_order: 1–2
- rnbo_decision: 2–4
- vr_speaker_order: 1–2
- vr_resolution: 2–4
- cec_resolution: 1–2
- ccu_opinion: 1–2
- ccu_decision: 1–2
- nbu_letter: 2–4
- nbu_resolution: 1–2
- international: 2–4
- cmu_total: max 6
- defense: min 4

**Алгоритм:**
1. Сортування за пріоритетом (рідкісні спочатку)
2. Заповнення квот з перевіркою uniqueness
3. Quota status report (ok/missing)

### 3. Preview Evidence

**Команда:** `show-golden-set-preview`
- Читає `runs/diverse/golden_diversity_set.json`
- Виводить таблицю 30 рядків
- Генерує `runs/diverse/golden_preview.md`
- Distribution: predicted_slugs, prefix_classes, organ_signals, CMU %

### 4. Дебаг-артефакти

**Файли:**
- `runs/diverse/golden_diversity_set.json` — фінальний список
- `runs/diverse/metrics.json` — counters Stage A/B + quota status
- `runs/diverse/golden_preview.md` — preview таблиця + distribution
- `runs/diverse_cache/*.json` — кеш для кожного nreg

---

## Команди

```bash
# Збір кандидатів (V3)
pnpm tsx scripts/legislation/admin-cli.ts collect-diverse-candidates --v3

# Preview golden set
pnpm tsx scripts/legislation/admin-cli.ts show-golden-set-preview
```

---

## Очікуваний результат

Після завершення команди має бути:
- `golden_diversity_set.json` з >= 30 кандидатів
- `metrics.json` з counters (Stage A/B)
- `golden_preview.md` з preview таблицею
- Quota status: всі квоти виконані (окрім можливо defense, якщо мало кандидатів)

---

## Наступні кроки

1. Дочекатися завершення команди
2. Перевірити `metrics.json` — чи Stage A дає достатньо кандидатів
3. Показати preview таблицю + quota report
4. Якщо квоти не виконані — розширити Stage A (більше рядків) або покращити patterns
5. Тільки після виконання квот → PHASE 3.1 (+10)
