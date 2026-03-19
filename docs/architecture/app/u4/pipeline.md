# U4 CacheRAG — Pipeline

## Stages (A–E)

- **A. Query understanding** — NFC, whitespace, typo fix; anchors from taxonomy only. Intent/domain from query_profile. **U2 domain source:** heuristic (rules) or LLM; optional **U2 AI domain classifier** (Phase 6, OFF by default): when heuristic confidence < 0.55 or domain === general, max 1 call/run, returns taxonomy family keys only; query_profile.domainHint + domain_confidence + domain_candidates_top2; trace meta.u2_domain, meta.u2_ai_domain.
- **A.1 Structural citation anchors** — U4 treats Ukrainian structural selectors (`ст./ч./п./пп./абз./примітка`) as first-class query evidence. Parsing is Cyrillic-safe, normalizes dotted selector variants (`п.п.`, `ч.ч.`), and note-only mentions without a note number no longer count as full explicit selectors. The signal flows into chunk scoring, diversity, golden eval, and query-rewrite policy so `пунктом 12 Правил ...` is not mistaken for a generic natural-language query.
- **B. Act candidate generation** — Taxonomy (alias/keyword/topic/title/summary) + Qdrant acts search + evidence from reranked top hits. U2/LLDBI hints лишаються soft prior only; сильний ранній chunk evidence може підняти правильний акт навіть при помилковому domain hint. Runtime: `retrieval/act-candidate-ranking.ts`.
- **B.1 Candidate metadata hydration** — Перед `selected_acts` policy runtime добирає `document_type/category/title` з LLDBI cache для актів, які прийшли тільки через chunk evidence. Це прибирає blind spots, коли правильний кодекс потрапив у hits, але виглядав як `UNKNOWN` під час act-kind policy. Runtime: `cache-rag.ts` + `act-taxonomy-store.ts`.
- **B.2 Grounded query builder** — Must-have procedural signals проходять selector-aware filter ще до embed. Якщо query уже grounded (`ст./п./пп./абз./примітка` + act/article cue), runtime не має права роздувати retrieval broad signals типу `строк` або `порядок`; лишаються лише вузькі concepts, що реально допомагають article competition. Runtime: `retrieval/grounded-query-builder.ts`.
- **C. Within-act chunks** — First pass: unfiltered chunks + acts. When act candidates exist: **per-act retrieval** (top N chunks per act, e.g. 35 per act) so relevant article can appear within act. No hardcode act names.
- **C.2 Article/point backfill** — Для explicit `ст./ч./п./пп./абз.` citation queries U4 після main retrieval робить cheap recovery pass. Спочатку пробує exact structural Qdrant filter; якщо для selector field у cluster немає індексу (`point_number` etc.), runtime падає назад до вузького within-act search + local structural post-filter і лише потім re-rank/noise/diversity. Це дозволяє лагідно пережити payload/index drift.
- **C.1 Within-act act pool assembly** — Single-goal і multi-goal paths будують один і той самий ranked pool актів із taxonomy, bootstrap/acts-search evidence і planner preferences. Мета: не дублювати `lldbi_acts` search перед within-act retrieval, а перевикористовувати first-pass act evidence. Runtime: `retrieval/within-act-pool.ts`.
- **C.1a Conditional within-act fanout** — У single-goal path within-act retrieval тепер gated: weak first-pass (`needTwoStage`) або explicit structural/act anchors. Strong generic runs не повинні платити за per-act Qdrant fanout лише “про всяк випадок”.
- **C.1b Within-act expansion policy** — Fanout decision винесений в окремий policy module. Structural/procedural single-goal queries можуть отримати ширший per-act pool навіть на strong first pass, якщо same-act article competition інакше занадто вузький. Runtime: `retrieval/within-act-expansion-policy.ts`.
- **D. Hybrid scoring + anti-noise + diversity** — vector + taxonomy alignment + explicit article_ref + structural chunk score. Hybrid score пишеться в `ordering_score`, а `hit.score` лишається сирим vector score для forensics/audit. **Anti-noise penalty** і **diversity cap** працюють поверх `ordering_score`, тобто post-processing не має права стирати rerank назад до vector-only ordering. Secondary-order leakage is further constrained in procedural-dominant traces: repeated evidence alone is not enough without family/hint support. Trace: noise_penalty_policy_version, noise_penalty_guard_blocked, noise_penalty_guard_reason_codes (NO_PRIMARY_ALTERNATIVE, ONLY_SOURCE_FOR_GOAL). Runtime модулі: `retrieval/hit-ranking.ts`, `retrieval/chunk-rerank.ts`.
- **D.1 Exact point/article dominance** — Якщо query містить explicit structural selector, rerank тепер сильніше винагороджує exact point/subpoint match і штрафує wrong-point lexical overlap. Це важливо для правил/наказів, де в одному акті часто є кілька різних `п. 12`, `п. 15` тощо.
- **E. Hits cap** — Після fusion → noise → diversity cap застосовується u4HitsCap (напр. 100). Trace: hits_total_before_cap, hits_total_after_cap, hits_cap_applied, topN_used_for_distribution, scores_computed_on/avg_score_source = "final_hits_after_cap_and_guards". Cap не впливає на low_confidence (reason_codes не "cap").
- **F. Selective LLM planner** — Тільки за тригерами (multi_goal або contract-like); tier 0/1/2; fallback reason_codes. Не використовується за замовчуванням (U4_PLANNER_ENABLED=false).

## Multi-goal evidence pipeline

- **Goal split** — Heuristic splitter (no LLM by default): multi_question (several "?", "і чия"), multi_topic (criminal+procedure, tax+admin, etc.), contract/table from routing_flags. Cap: goals_max = 3 (config).
- **Contrastive liability compaction** — Запити типу `... коли це адміністративна, а коли кримінальна` мають перетворюватися на компактні aspect-goals, а не на `broad liability + admin + criminal`. Це прибирає зайвий retrieval fanout і фальшиві coverage-miss paths.
- **Anchored-citation split guard** — If the original query already contains explicit structural selectors, heuristic splitting must not create extra goals only because of `і/та`; anchored point/article queries are usually one legal target, not a semantic multi-goal search.
- **Procedural semantic shaping** — Після structural split goal може отримати `must_have_signals`, якщо з формулювання випливає procedural concept, який часто не названий буквально в title статті: наприклад `хто розслідує ...` → `підслідність`, `внести відомості до ЄРДР` → `початок досудового розслідування`. Це дешевий query enrichment, без окремого LLM hop.
- **Goal split v2 (taxonomy-induced)** — When heuristic yields 1 goal: get taxonomy candidates, then **category-cluster split** (substance vs procedure) from taxonomy + chunks evidence only (no word triggers). Inputs: taxonomy alias_hits by category, chunks evidence distribution in top30. Two strongest clusters: substance (tax_customs/labor_social/civil/criminal/admin) and procedure (judiciary_justice/criminal_procedure/civil_procedure). Split rule: both clusters above threshold, top2 not "other", not direct_citation → 2 goals with required_categories. Trace: goals_summary[].split_source = TAXONOMY_CLUSTER_SPLIT_V2, meta.stage_decisions.goal_split_v2, meta.goal_split_inputs (top_categories, supports).
- **Per-goal act allocation** — When goals_count ≥ 2: act pool per goal filtered by goal.required_categories (from taxonomy alias_hits); minActsPerGoal = 2 when candidates exist; else reason_codes GOAL_ACT_POOL_WEAK. Trace: goals_summary[].act_pool_size, meta.retrieval_debug_bundle.per_goal_act_pool_size.
- **Selective LLM planner** — Only when: multi_goal_detected, or input_is_large && input_looks_like_contract. Returns JSON goals (goal_type, subquery, domain_hint, likely_acts, keywords, why). No article names. Semaphore + circuit breaker (U2); cache in RunContext.
- **Per-goal retrieval** — For each goal: embed(goal.subquery), getTaxonomyCandidates(goal.subquery, goal.domain_hint) filtered by required_categories when set, steps (chunks + acts), within-act, hybrid sort. Tag hits with goal_id.
- **Goal fusion + coverage** — Merge hits; dedupe by r2_key:json_path. Coverage: in top N ensure at least M hits per goal (config u4FusionTopN, u4FusionMinHitsPerGoal). Act diversity cap. Trace: goals_summary, fusion, planner, stage_decisions (used_goal_splitter, used_llm_planner, per_goal_act_retrieval).
- **Selected_acts multi-goal coverage** — When goals_count ≥ 2: minDistinctActs = goals_count (or goals_count+1 if procedure goal); max 8; PRIMARY_LAW priority. Exception: when one PRIMARY_LAW act has dominant early evidence and family conflict is absent, policy may allow single-act coverage for a multi-clause query and trim the noisy tail (`MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED`). If selected_acts still do not cover all goals → reason_codes COVERAGE_MISS_SELECTED_ACTS, low_confidence = true. Trace: selected_acts_decision, selected_acts_confidence, selected_acts_kinds_count.
- **Selected_acts multi-goal coverage** — When goals_count ≥ 2: minDistinctActs = goals_count (or goals_count+1 if procedure goal); max 8; PRIMARY_LAW priority. Exception: when one PRIMARY_LAW act has dominant early evidence and family conflict is absent, policy may allow single-act coverage for a multi-clause query and trim the noisy tail (`MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED`). This exception is blocked when another early `PRIMARY_LAW` from a different legal family already has material chunk evidence, so substantive+procedure queries do not collapse back to one code. If selected_acts still do not cover all goals → reason_codes COVERAGE_MISS_SELECTED_ACTS, low_confidence = true. Trace: selected_acts_decision, selected_acts_confidence, selected_acts_kinds_count.
- **Family guard evidence floor** — Family/coverage guard не може додавати PRIMARY_LAW акт без material chunk evidence у final retrieval head. Якщо taxonomy family fit є, а retrieval evidence немає, trace мусить дати `FAMILY_GUARD_NO_EVIDENCE`.
- **Selected_acts noise clamp** — Якщо multi-goal query уже має щонайменше два сильні `PRIMARY_LAW` акти, diversity/family guard не повинен реінжектити weak `KSU_DECISION`/`CASELAW_OPINION`/`BILL_DRAFT` у `selected_acts`. Для `SECONDARY_ORDER` support evidence alone also is not enough in procedural-dominant traces; потрібні family/hint signals або non-procedural support, інакше writer отримує шум.
- **Selected_acts final pass after routing** — Routing hints більше не є bypass-каналом повз policy. Late-added acts після family/routing recovery проходять окремий finalizer: unsupported additions без retrieval evidence можуть бути прибрані ще до writer handoff, а confidence піднімається лише коли recovery підтверджений retrieval trace.

## Кроки

1. **U4 event** — після U3a (search_plan + steps у RunContext/RunRecord).
2. **Load run** — RunRepository.findByRunId; search_plan/steps з RunContext або RunRecord.search_plan; query_profile (domain, entities).
3. **ActTaxonomyStore** — getTaxonomyCandidates(query, domainHint, entities). Джерело: Supabase legislation_documents (aliases, keywords, topics, category). TTL refresh; tolerant normalizer (NFC, trim, lower, dedup) for aliases/keywords/topics. getActMeta, scoreActCandidate, findCandidatesByAliasTokens. **Domain-based injection:** якщо domainHint від U2 є і не unknown — snap.byCategory(domainHint) додає до 15 актів категорії (без словників тема→акт).
4. **Domain bootstrap (multi-goal only)** — коли domainHint від U2 слабкий (порожній/general/unknown) і taxonomy candidates слабкі: один додатковий Qdrant acts search (limit 20), гістограма категорій по PRIMARY_LAW з taxonomy; якщо top1_support ≥ 2 і gap ≥ 1 → effective_domain_hint для goal; потім getTaxonomyCandidates(subquery, chosen_family_key). Trace: meta.domain_bootstrap (attempted, used, chosen_family_key, top_categories, reason_codes). Метрики: u4_domain_bootstrap_attempted_total, u4_domain_bootstrap_used_total, u4_domain_bootstrap_conflict_total. Бюджет: максимум 1 acts search на goal.
5. **Query shaping** — NFC, whitespace, typo fix; **anchors тільки з taxonomy**. Без hardcode домен→акт.
6. **Query rewrite policy** — LLM rewrite is budgeted and may be skipped before the call when the query is already strongly anchored by structural citation + act/title cues, або коли single-goal run already has strong LLDBI/taxonomy support (`taxonomy_act_count`, alias hits, category/doc-type hints). Мета: не платити за rewrite там, де deterministic metadata grounding already gives a strong act family and rewrite лише розширює запит та роздуває false multi-goal / multi-query fanout.
7. **Effective query** — нормалізація: короткий query ≤12k; довгий — head+tail (6k+6k).
8. **Embed** — embedQuery(effective) через OpenRouter (openai/text-embedding-3-small, 1536d). При помилці — degraded_sources.lldbi=true, 0 hits.
9. **Qdrant search** — за steps: lldbi_chunks (основне), lldbi_acts (опційно). Timeout + 1 retry.
10. **Within-act retrieval** — якщо є act candidates (taxonomy або acts search) і single-goal path справді потребує другого етапу, або query явно заякорений act/structure cues: для top acts — окремий Qdrant search по chunks з filter `rada_nreg = act`, limit 35. Merge + dedupe. Це дає релевантну статтю/пункт/підпункт у межах акту (act→article/point) без обов'язкового fanout на всіх strong generic runs.
11. **Hybrid re-score** — ordering без LLM. hit.score у trace залишається векторний.
    `ordering_score` зберігає final retrieval ordering для downstream stages; будь-який post-processing крок має спиратися на нього, а не на raw vector score.
12. **Diversity cap** — у топ 25 не більше 16 hits з одного акту (generalizable). Для structural retrieval cap now keys by full citation path when available, not only by article number.
13. **RawHits** — з payload: r2_key, json_path, score, rada_nreg, article_number, unit_number, unit_type, citation_path, title, source.
14. **Selected_acts (Writer)** — Кожен елемент містить: rada_nreg, act_title, score, why_selected, reason_tag, source_tags; **метадані (E.2):** document_type, category, act_kind (PRIMARY_LAW / SECONDARY_ORDER / CASELAW_OPINION / BILL_DRAFT / UNKNOWN), flags (recovered, keep_one, draft, opinion). Джерело act_kind/document_type/category: taxonomy snapshot + LLDBI metadata hydration для chunk-only acts, щоб policy не втрачала тип правильного акту. **Low confidence (E.3):** коли low_confidence=true, reason_codes містять один з: OUT_OF_SCOPE, NO_STRONG_ACT_EVIDENCE, LOW_EVIDENCE, ACT_SELECTION_LOW_CONFIDENCE (додається автоматично, якщо ще немає).
    `chunks_evidence_top_acts` тепер містить і ранні retrieval signals (`best_rank_in_top30`, `rank_mass_top30`, `max_ordering_score`), щоб policy могла відрізняти “2 дуже сильні top hits” від “8 шумних хвостових hits”.
    Для single-goal запитів policy може залишити один strong supporting secondary act, якщо той має повторний evidence у top-30; це дозволяє зберігати practically relevant orders без повернення до шумного order-dominance.
15. **RetrievalTrace.meta** — act_candidates_top, stage_decisions (used_taxonomy, used_acts_search, used_filtered_chunks, used_goal_splitter, used_llm_planner, per_goal_act_retrieval, used_global_fallback), **goals_summary**, **fusion** (coverage_enforced, per_goal_min_hits, topN, per_goal_counts_in_topN), **planner** (tier_selected, called, call_failed_reason, tier, model_id, duration_ms, degraded, reason_codes), **qdrant_calls_count_total**, **hits_total_before_cap**, **hits_total_after_cap**, **hits_cap_applied**, **topN_used_for_distribution**, **scores_computed_on**, **avg_score_source**, **distribution** (noise_penalty_applied_count, noise_penalty_policy_version, noise_penalty_guard_blocked, noise_penalty_guard_reason_codes, hits_by_act_top3, avg_score_by_act_top3), reason_codes, sample_hits, hits_count, low_confidence, query_variants_used, anchors_used.
    `within_act_policy` окремо фіксує, чому per-act fanout був або не був включений на цьому run.
    `article_backfill` тепер окремо фіксує, чи recovery path був structural, чи довелося падати назад до post-filter fallback через missing Qdrant index.
16. **Persist** — RunRepository.updateRetrievalTrace; RunContext: raw_hits + retrieval_trace.
17. **Enqueue U5** — Gate.

## MCP-аудит runs + чанки (read-only)

Скрипт `tools/mcp_audit_runs_chunks_quality.ts` (`pnpm brain:audit:runs-chunks --limit 15 --since-days 3`): тягне runs з Supabase, для кожного — топ 5–8 чанків з retrieval_trace.hits, опційно snippet з R2, пише звіт `_reports/mcp_audit_runs_chunks_quality_YYYY-MM-DD.md`. Таблиця: run_id, query, domainHint, lldbi, selected_acts, low_conf, reason_codes; деталі + юридична оцінка. Для пошуку системних багів.

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
