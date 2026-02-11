# Retrieval real DEV failures — policy targets v2

Generated: 2026-02-11T20:35:51.943Z
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
- 2755-17 count_in_top30=25 max_score=0.6448276
- 31-2026-п count_in_top30=2 max_score=0.40629822
- 1697-18 count_in_top30=1 max_score=0.53302234
- 18-2026-п count_in_top30=1 max_score=0.36029428
- v0003900-93 count_in_top30=1 max_score=0.35504365

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["multi_topic"]
**low_confidence:** false
**qdrant_calls_count_total:** 16
**latency_ms:** 3275

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
**latency_ms:** 3725

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
- 1697-18 count_in_top30=6 max_score=0.4589436
- 4651-17 count_in_top30=6 max_score=0.45374587
- 80732-10 count_in_top30=3 max_score=0.44771886
- 2341-14 count_in_top30=3 max_score=0.44471428
- 33-2026-р count_in_top30=1 max_score=0.51919895
- 34-2026-р count_in_top30=1 max_score=0.4838506
- nb07d710-25 count_in_top30=1 max_score=0.47336027
- 1-2026-р count_in_top30=1 max_score=0.4582584
- 4754-20 count_in_top30=1 max_score=0.45173657
- 17-2026-р count_in_top30=1 max_score=0.45171762

**selected_acts_decision.reason_codes:** ["COVERAGE_GUARD_FAILED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["low_confidence_fallback","COVERAGE_GUARD_FAILED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_DOMINANT_OK"]
**low_confidence:** true
**qdrant_calls_count_total:** 8
**latency_ms:** 10105

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
- 80731-10 count_in_top30=10 max_score=0.41764975
- 4651-17 count_in_top30=4 max_score=0.44725412
- 2341-14 count_in_top30=2 max_score=0.4754566
- 984_011-12 count_in_top30=2 max_score=0.42046148
- 322-08 count_in_top30=2 max_score=0.4194832
- 2755-17 count_in_top30=2 max_score=0.4162119
- 80732-10 count_in_top30=2 max_score=0.41482705
- 435-15 count_in_top30=2 max_score=0.2848824
- 2747-15 count_in_top30=1 max_score=0.4181506
- 1861-17 count_in_top30=1 max_score=0.41628224

**selected_acts_decision.reason_codes:** ["COVERAGE_GUARD_FAILED","SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["multi_question","multi_topic"]
**low_confidence:** false
**qdrant_calls_count_total:** 16
**latency_ms:** 3359

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
**latency_ms:** 4374

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
**latency_ms:** 5016

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
- 2755-17 count_in_top30=21 max_score=0.6848294
- v001p710-18 count_in_top30=8 max_score=0.5971371
- z0426-11 count_in_top30=1 max_score=0.53816473

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 8
**latency_ms:** 3814

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
**latency_ms:** 4341

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
- 2755-17 count_in_top30=25 max_score=0.6447824
- 1618-15 count_in_top30=3 max_score=0.56110704
- 1697-18 count_in_top30=1 max_score=0.60765076
- 4651-17 count_in_top30=1 max_score=0.5641544

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["multi_topic"]
**low_confidence:** false
**qdrant_calls_count_total:** 16
**latency_ms:** 3927

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
- 80731-10 count_in_top30=13 max_score=0.54035234
- 2755-17 count_in_top30=13 max_score=0.5174886
- 2341-14 count_in_top30=3 max_score=0.52962965
- 1700-18 count_in_top30=1 max_score=0.51638854

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_CONFLICT"]
**low_confidence:** false
**qdrant_calls_count_total:** 9
**latency_ms:** 10779

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
**latency_ms:** 3587

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
- 2755-17 | Податковий кодекс України
- 80732-10 | -
- 1700-18 | -

**selected_acts_sources_breakdown:**
{
  "from_taxonomy": [],
  "from_acts_search": [],
  "from_chunks_evidence": [
    "80731-10",
    "2755-17",
    "80732-10",
    "1700-18"
  ]
}

**chunks_evidence_top_acts (top10):**
- 80731-10 count_in_top30=21 max_score=0.6072159
- 2755-17 count_in_top30=5 max_score=0.5812517
- 80732-10 count_in_top30=3 max_score=0.58603525
- 1700-18 count_in_top30=1 max_score=0.58504105

**selected_acts_decision.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED"]
**meta.reason_codes:** ["SELECTED_ACTS_FROM_CHUNKS_EVIDENCE","SELECTED_ACTS_DIVERSITY_ENFORCED","FAMILY_DOMINANT_OK"]
**low_confidence:** false
**qdrant_calls_count_total:** 9
**latency_ms:** 3613

## Top 3 policy-target patterns

- **A** (11): Wrong family routing (selected_acts/evidence don't match expected families)
- **D** (1): Low_confidence should-have-triggered planner/rewrite
