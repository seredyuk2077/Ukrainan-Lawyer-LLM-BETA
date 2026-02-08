# ADR: U4 Prod Hardening v2 — інваріанти, порядок стадій, cap і noise guard

## Контекст

U4 CacheRAG має стабільно забезпечувати multi-goal/multi-act retrieval, бюджет (LLM planner лише за політикою), прозорість cap і безпечний anti-noise penalty. Цей ADR фіксує інваріанти та порядок стадій після prod hardening (Phase 4).

## Інваріанти

1. **Один набір для метрик** — distribution, avg_score, low_confidence, coverage рахуються на **одному** фінальному наборі hits: після fusion → rerank/hybrid → noise guard/penalty → diversity cap → hits cap. Trace: `scores_computed_on: "final_hits_after_cap_and_guards"`, `avg_score_source: "final_hits_after_cap_and_guards"`.

2. **Cap не визначає low_confidence** — low_confidence виставляється тільки за причиною (напр. all_hits_below_min_score_fallback). Cap не додає reason_codes типу "cap"; cap лише обрізає кількість hits.

3. **Noise penalty тільки з guard** — penalty за патернами "окрема думка", "порядок торгівлі" застосовується **тільки** якщо: (a) у top N є хоча б один primary-law-like документ (кодекс/закон/конституція/процесуальний) зі score у межах DELTA від noisy hit, і (b) noisy hit не є єдиним джерелом для свого goal у top N. Інакше guard блокує penalty (NO_PRIMARY_ALTERNATIVE або ONLY_SOURCE_FOR_GOAL). Trace: `noise_penalty_policy_version`, `noise_penalty_guard_blocked`, `noise_penalty_guard_reason_codes`.

4. **Planner tier vs calls** — Tier 0 = planner **не викликався** (політика). Метрики: `u4_planner_tier_selected_0/1/2_total` (який tier обрано), `u4_planner_calls_1/2_total` (фактичні LLM виклики). Trace: `meta.planner.tier_selected`, `meta.planner.called`, `meta.planner.call_failed_reason`.

5. **Реальна кількість Qdrant викликів** — `u4_qdrant_calls_total` інкрементується **реальним** числом викликів Qdrant API (інструментація в qdrant-client через callCounter), а не steps_executed.length. Trace: `meta.qdrant_calls_count_total`.

## Порядок стадій (single-goal)

1. Embed + taxonomy + shapeQuery  
2. Qdrant steps (chunks + acts)  
3. Within-act retrieval (per act, filtered chunks)  
4. Hybrid re-score (ordering)  
5. **Anti-noise penalty** (з guard) → `applyNoisePenalty(hits, topNForGuard)`  
6. **Diversity cap** → `applyDiversityCap` (top 25, max 16 per act)  
7. **Hits cap** → `slice(0, config.u4HitsCap)`  
8. Trace: hits_total_before_cap (перед slice), hits_total_after_cap, hits_cap_applied, topN_used_for_distribution, scores_computed_on, avg_score_source  
9. Distribution/avg_score/low_confidence рахуються по **результату** п.7 (final hits).

## Порядок стадій (multi-goal)

1. Heuristic goal split  
2. (Опційно) LLM planner за тригерами; tier 0/1/2, fallback reason_codes  
3. Per-goal retrieval (embed, taxonomy, steps, within-act, hybrid)  
4. Merge hits (goal_id), dedupe  
5. Coverage fusion (top N, min M per goal)  
6. **Anti-noise penalty** (з guard)  
7. **Diversity cap**  
8. **Hits cap**  
9. Trace: аналогічно single-goal + goals_summary, fusion, planner.

## Що перевіряють тести

- **verify:retrieval-quality** (25 кейсів): non-empty/low_confidence, optional golden article/act; **не** golden на конкретні статті (130, 115 тощо) як єдиний критерій.
- **verify:retrieval-multigoal** (62 кейси): multi-goal/multi-act по **сигналах** (act family, distinct acts, goal coverage), cap transparency (before_cap, after_cap, hits_cap_applied), noise guard regression (нові теми: КСУ, порядок процедура, кодекс+окремі), budget (median/p95, planner_calls%, hits_cap_applied%).
- Нові кейси (корупція, бандитизм, тероризм, правочин, емансипація, договірний текст) — assertions по distinct acts, act signals (корупц, кримінальн, цивільн), **без** хардкоду конкретних статей.

## Висновок

Інваріанти та порядок стадій зафіксовані; cap і noise guard мають прозору поведінку та trace; тести перевіряють властивості та бюджет, а не підгонку під старі golden.
