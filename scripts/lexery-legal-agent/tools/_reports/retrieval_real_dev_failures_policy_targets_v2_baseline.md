# Retrieval real DEV failures — policy targets v2

Generated: 2026-02-11T19:39:20.608Z
repeat: 3 | consensus: hard_fail if ≥2/3 runs
hard_fail (consensus): 12 (of 43 DEV)

## Buckets
- **A)** Wrong family routing
- **B)** Missing multi-act coverage per goal
- **C)** Procedure/substance split missed (or over-split)
- **D)** Low_confidence should-have-triggered planner/rewrite

| Bucket | Count |
| --- | --- |
| A | 11 |
| B | 0 |
| C | 0 |
| D | 1 |

---
### FAIL #7 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** Податкова перевірка та оскарження її результатів

**Expected families:** ["tax"]
**must_multi_goal:** true, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []
- goal_id: goal_1, required_categories: []

**selected_acts:**
- 2755-17 | Податковий кодекс України
- 21-2026-р | Деякі питання розрахунку розмірів плати (адміністративного збору) за надання публічних (електронних публічних) послуг
- 36-2026-п | Про внесення змін до переліку платних послуг, які надаються підрозділами Міністерства внутрішніх справ, Національної поліції та Державної міграційної служби, і розміру плати за їх надання

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [
    "21-2026-р",
    "36-2026-п"
  ],
  "from_acts_search": [
    "21-2026-р",
    "36-2026-п"
  ],
  "from_chunks_evidence": [
    "2755-17"
  ]
}

**chunks_evidence_top_acts (top10):**
- 2755-17 count_in_top30=25 max_score=0.64475894
- 31-2026-п count_in_top30=2 max_score=0.40623122
- 1697-18 count_in_top30=1 max_score=0.53304213
- 18-2026-п count_in_top30=1 max_score=0.3603693
- v0003900-93 count_in_top30=1 max_score=0.35515803

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["multi_topic"]
**low_confidence:** false
**qdrant_calls_count_total:** 16
**latency_ms:** 3233

---
### FAIL #10 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** Водіння в нетверезому стані сп'янін

**Expected families:** ["criminal"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 80731-10 | Кодекс України про адміністративні правопорушення (статті 1 - 212-24)
- 80732-10 | -

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "80731-10",
    "80732-10"
  ]
}

**chunks_evidence_top_acts (top10):**
- 80731-10 count_in_top30=21 max_score=0.7201562
- 80732-10 count_in_top30=9 max_score=0.6989583

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 8
**latency_ms:** 4254

---
### FAIL #13 [D] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** звільнення прогул

**Expected families:** ["labor"]
**must_multi_goal:** false, **must_multi_act:** true

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 1697-18 | -
- 4651-17 | -
- 80732-10 | -
- 2341-14 | -
- 33-2026-р | Про звільнення Малашкіна М.А. з посади державного секретаря Міністерства оборони України

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [
    "33-2026-р"
  ],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "1697-18",
    "4651-17",
    "80732-10",
    "2341-14"
  ]
}

**chunks_evidence_top_acts (top10):**
- 1697-18 count_in_top30=6 max_score=0.45794946
- 4651-17 count_in_top30=5 max_score=0.4525546
- 80732-10 count_in_top30=4 max_score=0.44792303
- 2341-14 count_in_top30=3 max_score=0.4438824
- 33-2026-р count_in_top30=1 max_score=0.5175241
- 34-2026-р count_in_top30=1 max_score=0.48250717
- nb07d710-25 count_in_top30=1 max_score=0.47309285
- 1-2026-р count_in_top30=1 max_score=0.45625368
- 4754-20 count_in_top30=1 max_score=0.4510365
- 17-2026-р count_in_top30=1 max_score=0.4507446

**selected_acts_decision.reason_codes:** ["COVERAGE_GUARD_FAILED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["low_confidence_fallback","COVERAGE_GUARD_FAILED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_CONFLICT"]
**low_confidence:** true
**qdrant_calls_count_total:** 8
**latency_ms:** 3694

---
### FAIL #15 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** Що таке шахрайство? і чия по підслідності це стаття?

**Expected families:** ["corporate"]
**must_multi_goal:** true, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []
- goal_id: goal_1, required_categories: []

**selected_acts:**
- 80731-10 | -
- 4651-17 | -
- v0007700-81 | Про практику застосування судами України законодавства у справах про розкрадання державного та колективного майна
- 322-08 | Кодекс законів про працю України

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [
    "v0007700-81",
    "322-08"
  ],
  "from_acts_search": [
    "v0007700-81",
    "322-08"
  ],
  "from_chunks_evidence": [
    "80731-10",
    "4651-17"
  ]
}

**chunks_evidence_top_acts (top10):**
- 80731-10 count_in_top30=10 max_score=0.417551
- 4651-17 count_in_top30=4 max_score=0.44718778
- 2341-14 count_in_top30=2 max_score=0.47545415
- 984_011-12 count_in_top30=2 max_score=0.42042077
- 322-08 count_in_top30=2 max_score=0.41942224
- 2755-17 count_in_top30=2 max_score=0.41615033
- 80732-10 count_in_top30=2 max_score=0.41474515
- 435-15 count_in_top30=2 max_score=0.28478795
- 2747-15 count_in_top30=1 max_score=0.41808736
- 1861-17 count_in_top30=1 max_score=0.4162141

**selected_acts_decision.reason_codes:** ["COVERAGE_GUARD_FAILED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["multi_question","multi_topic"]
**low_confidence:** false
**qdrant_calls_count_total:** 16
**latency_ms:** 2776

---
### FAIL #20 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** оскарження податкової

**Expected families:** ["tax"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 2755-17 | Податковий кодекс України
- v001p710-18 | -

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "2755-17",
    "v001p710-18"
  ]
}

**chunks_evidence_top_acts (top10):**
- 2755-17 count_in_top30=21 max_score=0.5668007
- v001p710-18 count_in_top30=4 max_score=0.46824205
- z0426-11 count_in_top30=2 max_score=0.4726701
- 21-2026-р count_in_top30=2 max_score=0.46852463
- 22-2026-п count_in_top30=1 max_score=0.44460964

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 9
**latency_ms:** 4407

---
### FAIL #26 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** оскаржити податкову перевірку

**Expected families:** ["tax"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 2755-17 | Податковий кодекс України
- 21-2026-р | -
- z0426-11 | -

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "2755-17",
    "21-2026-р",
    "z0426-11"
  ]
}

**chunks_evidence_top_acts (top10):**
- 2755-17 count_in_top30=20 max_score=0.57300675
- 21-2026-р count_in_top30=5 max_score=0.47562855
- z0426-11 count_in_top30=3 max_score=0.45716465
- 22-2026-п count_in_top30=2 max_score=0.44924158

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 9
**latency_ms:** 4316

---
### FAIL #27 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** податки ФОП спрощена система

**Expected families:** ["tax"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 2755-17 | Податковий кодекс України
- v001p710-18 | -

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "2755-17",
    "v001p710-18"
  ]
}

**chunks_evidence_top_acts (top10):**
- 2755-17 count_in_top30=21 max_score=0.68478566
- v001p710-18 count_in_top30=8 max_score=0.59713745
- z0426-11 count_in_top30=1 max_score=0.53815657

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 8
**latency_ms:** 3496

---
### FAIL #28 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** банкрутство підприємства

**Expected families:** ["corporate"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- z0841-01 | -
- 2597-19 | Кодекс України з процедур банкрутства

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "z0841-01",
    "2597-19"
  ]
}

**chunks_evidence_top_acts (top10):**
- z0841-01 count_in_top30=16 max_score=0.64244765
- 2597-19 count_in_top30=14 max_score=0.7009227

**selected_acts_decision.reason_codes:** ["ORDER_DOMINANCE_BLOCKED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["ORDER_DOMINANCE_BLOCKED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 8
**latency_ms:** 3954

---
### FAIL #30 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** Податкова перевірка і оскарження рішення

**Expected families:** ["tax"]
**must_multi_goal:** true, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []
- goal_id: goal_1, required_categories: []

**selected_acts:**
- 2755-17 | Податковий кодекс України
- 1618-15 | -
- 1697-18 | -
- 4651-17 | -
- 21-2026-р | Деякі питання розрахунку розмірів плати (адміністративного збору) за надання публічних (електронних публічних) послуг

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [
    "21-2026-р"
  ],
  "from_acts_search": [
    "21-2026-р"
  ],
  "from_chunks_evidence": [
    "2755-17",
    "1618-15",
    "1697-18",
    "4651-17"
  ]
}

**chunks_evidence_top_acts (top10):**
- 2755-17 count_in_top30=25 max_score=0.64475894
- 1618-15 count_in_top30=3 max_score=0.5610567
- 1697-18 count_in_top30=1 max_score=0.60771185
- 4651-17 count_in_top30=1 max_score=0.5642405

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["multi_topic"]
**low_confidence:** false
**qdrant_calls_count_total:** 16
**latency_ms:** 6695

---
### FAIL #35 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** податкова санкція

**Expected families:** ["tax"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 80731-10 | Кодекс України про адміністративні правопорушення (статті 1 - 212-24)
- 2755-17 | Податковий кодекс України
- 2341-14 | Кримінальний кодекс України

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "80731-10",
    "2755-17",
    "2341-14"
  ]
}

**chunks_evidence_top_acts (top10):**
- 80731-10 count_in_top30=13 max_score=0.54027283
- 2755-17 count_in_top30=13 max_score=0.5173738
- 2341-14 count_in_top30=3 max_score=0.5295779
- 1700-18 count_in_top30=1 max_score=0.5162991

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_CONFLICT"]
**low_confidence:** false
**qdrant_calls_count_total:** 9
**latency_ms:** 16287

---
### FAIL #37 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** нетверезий водій штраф

**Expected families:** ["criminal"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 80731-10 | Кодекс України про адміністративні правопорушення (статті 1 - 212-24)
- 80732-10 | -

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "80731-10",
    "80732-10"
  ]
}

**chunks_evidence_top_acts (top10):**
- 80731-10 count_in_top30=21 max_score=0.7306472
- 80732-10 count_in_top30=9 max_score=0.6986466

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 8
**latency_ms:** 4449

---
### FAIL #43 [A] HARD_FAIL_STABLE

**Consensus:** HARD_FAIL_STABLE (hard_fail in 3/3 runs)

**Query:** податкове право порушення

**Expected families:** ["tax"]
**must_multi_goal:** false, **must_multi_act:** false

**goals_summary:**
- goal_id: goal_0, required_categories: []

**selected_acts:**
- 80731-10 | Кодекс України про адміністративні правопорушення (статті 1 - 212-24)
- 80732-10 | -
- 2755-17 | Податковий кодекс України
- 1700-18 | -

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "80731-10",
    "80732-10",
    "2755-17",
    "1700-18"
  ]
}

**chunks_evidence_top_acts (top10):**
- 80731-10 count_in_top30=21 max_score=0.60613346
- 80732-10 count_in_top30=4 max_score=0.5846773
- 2755-17 count_in_top30=4 max_score=0.5798731
- 1700-18 count_in_top30=1 max_score=0.58520937

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 9
**latency_ms:** 4434

## Top 3 policy-target patterns

- **A** (11): Wrong family routing (selected_acts/evidence don't match expected families)
- **D** (1): Low_confidence should-have-triggered planner/rewrite
