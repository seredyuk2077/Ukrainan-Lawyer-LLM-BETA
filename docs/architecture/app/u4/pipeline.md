# U4 CacheRAG — Pipeline

## Stages (A–E)

- **A. Query understanding** — NFC, whitespace, typo fix; anchors from taxonomy only. Intent/domain from query_profile. **U2 domain source:** heuristic (rules) or LLM; optional **U2 AI domain classifier** (Phase 6, OFF by default): when heuristic confidence < 0.55 or domain === general, max 1 call/run, returns taxonomy family keys only; query_profile.domainHint + domain_confidence + domain_candidates_top2; trace meta.u2_domain, meta.u2_ai_domain.
- **B. Act candidate generation** — Taxonomy (alias/keyword/topic) + Qdrant acts search → top 5 acts → act_candidates_top in trace.
- **C. Within-act chunks** — First pass: unfiltered chunks + acts. When act candidates exist: **per-act retrieval** (top N chunks per act, e.g. 35 per act) so relevant article can appear within act. No hardcode act names.
- **D. Hybrid scoring + anti-noise + diversity** — w_vec*vector + alias + article_ref + category + title_overlap. **Anti-noise penalty** (патерни "окрема думка", "порядок торгівлі") з **guard**: penalty тільки якщо в top N є primary-law-like документ у межах DELTA і noisy hit не єдине джерело для goal. Trace: noise_penalty_policy_version, noise_penalty_guard_blocked, noise_penalty_guard_reason_codes (NO_PRIMARY_ALTERNATIVE, ONLY_SOURCE_FOR_GOAL). Diversity cap: в top 25 не більше 16 з одного акту.
- **E. Hits cap** — Після fusion → noise → diversity cap застосовується u4HitsCap (напр. 100). Trace: hits_total_before_cap, hits_total_after_cap, hits_cap_applied, topN_used_for_distribution, scores_computed_on/avg_score_source = "final_hits_after_cap_and_guards". Cap не впливає на low_confidence (reason_codes не "cap").
- **F. Selective LLM planner** — Тільки за тригерами (multi_goal або contract-like); tier 0/1/2; fallback reason_codes. Не використовується за замовчуванням (U4_PLANNER_ENABLED=false).

## Multi-goal evidence pipeline

- **Goal split** — Heuristic splitter (no LLM by default): multi_question (several "?", "і чия"), multi_topic (criminal+procedure, tax+admin, etc.), contract/table from routing_flags. Cap: goals_max = 3 (config).
- **Goal split v2 (taxonomy-induced)** — When heuristic yields 1 goal: get taxonomy candidates, then **category-cluster split** (substance vs procedure) from taxonomy + chunks evidence only (no word triggers). Inputs: taxonomy alias_hits by category, chunks evidence distribution in top30. Two strongest clusters: substance (tax_customs/labor_social/civil/criminal/admin) and procedure (judiciary_justice/criminal_procedure/civil_procedure). Split rule: both clusters above threshold, top2 not "other", not direct_citation → 2 goals with required_categories. Trace: goals_summary[].split_source = TAXONOMY_CLUSTER_SPLIT_V2, meta.stage_decisions.goal_split_v2, meta.goal_split_inputs (top_categories, supports).
- **Per-goal act allocation** — When goals_count ≥ 2: act pool per goal filtered by goal.required_categories (from taxonomy alias_hits); minActsPerGoal = 2 when candidates exist; else reason_codes GOAL_ACT_POOL_WEAK. Trace: goals_summary[].act_pool_size, meta.retrieval_debug_bundle.per_goal_act_pool_size.
- **Selective LLM planner** — Only when: multi_goal_detected, or input_is_large && input_looks_like_contract. Returns JSON goals (goal_type, subquery, domain_hint, likely_acts, keywords, why). No article names. Semaphore + circuit breaker (U2); cache in RunContext.
- **Per-goal retrieval** — For each goal: embed(goal.subquery), getTaxonomyCandidates(goal.subquery, goal.domain_hint) filtered by required_categories when set, steps (chunks + acts), within-act, hybrid sort. Tag hits with goal_id.
- **Goal fusion + coverage** — Merge hits; dedupe by r2_key:json_path. Coverage: in top N ensure at least M hits per goal (config u4FusionTopN, u4FusionMinHitsPerGoal). Act diversity cap. Trace: goals_summary, fusion, planner, stage_decisions (used_goal_splitter, used_llm_planner, per_goal_act_retrieval).
- **Selected_acts multi-goal coverage** — When goals_count ≥ 2: minDistinctActs = goals_count (or goals_count+1 if procedure goal); max 8; PRIMARY_LAW priority. If selected_acts do not cover all goals → reason_codes COVERAGE_MISS_SELECTED_ACTS, low_confidence = true. Trace: selected_acts_decision, selected_acts_confidence, selected_acts_kinds_count.

## Кроки

1. **U4 event** — після U3a (search_plan + steps у RunContext/RunRecord).
2. **Load run** — RunRepository.findByRunId; search_plan/steps з RunContext або RunRecord.search_plan; query_profile (domain, entities).
3. **ActTaxonomyStore** — getTaxonomyCandidates(query, domainHint, entities). Джерело: Supabase legislation_documents (aliases, keywords, topics, category). TTL refresh; tolerant normalizer (NFC, trim, lower, dedup) for aliases/keywords/topics. getActMeta, scoreActCandidate, findCandidatesByAliasTokens. **Domain-based injection:** якщо domainHint від U2 є і не unknown — snap.byCategory(domainHint) додає до 15 актів категорії (без словників тема→акт).
4. **Domain bootstrap (multi-goal only)** — коли domainHint від U2 слабкий (порожній/general/unknown) і taxonomy candidates слабкі: один додатковий Qdrant acts search (limit 20), гістограма категорій по PRIMARY_LAW з taxonomy; якщо top1_support ≥ 2 і gap ≥ 1 → effective_domain_hint для goal; потім getTaxonomyCandidates(subquery, chosen_family_key). Trace: meta.domain_bootstrap (attempted, used, chosen_family_key, top_categories, reason_codes). Метрики: u4_domain_bootstrap_attempted_total, u4_domain_bootstrap_used_total, u4_domain_bootstrap_conflict_total. Бюджет: максимум 1 acts search на goal.
5. **Query shaping** — NFC, whitespace, typo fix; **anchors тільки з taxonomy**. Без hardcode домен→акт.
6. **Effective query** — нормалізація: короткий query ≤12k; довгий — head+tail (6k+6k).
7. **Embed** — embedQuery(effective) через OpenRouter (openai/text-embedding-3-small, 1536d). При помилці — degraded_sources.lldbi=true, 0 hits.
8. **Qdrant search** — за steps: lldbi_chunks (основне), lldbi_acts (опційно). Timeout + 1 retry.
9. **Within-act retrieval** — якщо є act candidates (taxonomy або acts search): для кожного з top 5 acts — окремий Qdrant search по chunks з filter rada_nreg = act, limit 35. Merge + dedupe. Це дає релевантну статтю в межах акту (act→article).
10. **Hybrid re-score** — ordering без LLM. hit.score у trace залишається векторний.
11. **Diversity cap** — у топ 25 не більше 16 hits з одного акту (generalizable).
12. **RawHits** — з payload: r2_key, json_path, score, rada_nreg, article_number, title, source.
13. **RetrievalTrace.meta** — act_candidates_top, stage_decisions (used_taxonomy, used_acts_search, used_filtered_chunks, used_goal_splitter, used_llm_planner, per_goal_act_retrieval, used_global_fallback), **goals_summary**, **fusion** (coverage_enforced, per_goal_min_hits, topN, per_goal_counts_in_topN), **planner** (tier_selected, called, call_failed_reason, tier, model_id, duration_ms, degraded, reason_codes), **qdrant_calls_count_total**, **hits_total_before_cap**, **hits_total_after_cap**, **hits_cap_applied**, **topN_used_for_distribution**, **scores_computed_on**, **avg_score_source**, **distribution** (noise_penalty_applied_count, noise_penalty_policy_version, noise_penalty_guard_blocked, noise_penalty_guard_reason_codes, hits_by_act_top3, avg_score_by_act_top3), reason_codes, sample_hits, hits_count, low_confidence, query_variants_used, anchors_used.
14. **Persist** — RunRepository.updateRetrievalTrace; RunContext: raw_hits + retrieval_trace.
15. **Enqueue U5** — Gate.

## Схема

**Single-goal (default):**
```
U3a → [U4] → heuristicGoalSplit(1 goal) → getTaxonomyCandidates → shapeQuery(anchors)
         → embedQuery → Qdrant chunks/acts
         → within-act retrieval (per act, top N chunks) when candidates exist
         → hybrid re-score → diversity cap → RawHits + RetrievalTrace → U5
```

**Multi-goal (when heuristic or LLM planner yields 2+ goals; or single-goal path + tryCategoryClusterSplitV2 yields 2 goals):**
```
U3a → [U4] → heuristicGoalSplit → [if 1 goal: getTaxonomyCandidates → tryCategoryClusterSplitV2]
         → [optional LLM planner if trigger] → for each goal:
         act pool by required_categories (minActsPerGoal=2) → embed(goal.subquery) → getTaxonomyCandidates(goal) → steps → within-act → hybrid
         → merge hits (goal_id) → coverage fusion → diversity cap → buildSelectedActs (minDistinctActs=goals_count, COVERAGE_MISS if not covering) → goals_summary + fusion in meta → U5
```

## Limits

- Qdrant: config.qdrantTimeoutSec, config.u4QdrantConcurrency (no change to DB).
- LLM rewrite/rerank: only on triggers; U4_LLM_* when implemented.

## Деградація

- Embedding failure → degraded_sources.lldbi=true, hits=[], U5 все одно enqueue.
- Qdrant unreachable → degraded_sources.lldbi=true, hits=[], U5 enqueue.
- Див. `decisions/degraded-policy.md`.
