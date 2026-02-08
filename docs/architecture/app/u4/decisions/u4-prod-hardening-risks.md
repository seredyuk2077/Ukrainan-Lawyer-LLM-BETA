# U4 Prod Hardening — Top 5 Risks and Mitigations

## Status

Accepted. Concrete mitigations tied to code + tests + trace.

## Risk 1: Goal split gives wrong or missing goals

**Reality:** Heuristic split by "?" or " і " can miss multi-intent (e.g. "порядок оскарження і строки" without "?") or over-split ("і" inside a phrase). Single-question queries with multi-topic keywords (criminal + procedure) may get one goal and miss the second act family.

**Mitigation:**
- **Code:** Broaden patterns in goal-splitter (e.g. "порядок … і строки", "визначення … та відповідальність"). When multi_topic detected but subqueries.length === 1, optionally create 2 goals from domain hints (goal_0 = first domain, goal_1 = second).
- **Test:** Hard Queries Pack: multi-intent and cross-act cases with assertions `minGoals >= 2` and `minDistinctActsInTop >= 2`. Fail if single-goal path is used where we expect two act families.
- **Trace:** `goals_summary` already; add `stage_decisions.used_goal_splitter` and reason_codes so we can see why we got 1 vs 2 goals.

## Risk 2: LLM planner cost / flakiness / 429

**Reality:** Planner uses same OpenRouter as U2. Timeout or 429 can cascade; no tier means every trigger does a full planner call; no explicit fallback reason in trace.

**Mitigation:**
- **Code:** Tiered policy (Tier 0 = no LLM, Tier 1 = cheap/short max_tokens, Tier 2 = full). On planner throw: set `planner_degraded=true`, keep heuristic goals, append `PLANNER_FAILED` or `PLANNER_RATE_LIMIT` to reason_codes. Circuit breaker + cache already.
- **Test:** Assert % llm_planner_used ≤ 20% (or configured threshold). Assert cases that must not use planner (single question, no contract) have `used_llm_planner === false`.
- **Trace:** `meta.planner.tier` (0|1|2), `meta.planner.degraded`, `reason_codes` include PLANNER_*.

## Risk 3: Fusion skew — one goal or one act dominates top

**Reality:** Coverage takes first M per goal, then fills by score. A goal with many high-score hits can still occupy most of the "remaining" slots. One act can dominate if diversity cap is not strict enough.

**Mitigation:**
- **Code:** Emit `fusion.per_goal_counts_in_topN` in trace (actual counts per goal in top N). Optionally cap max hits per goal in top N after coverage (e.g. no goal > 50% of top 30). Downweight dominant goal: after reserved M per goal, limit each goal’s additional slots.
- **Test:** Multi-goal cases assert at least 2 distinct acts in top 30 and, when minGoals=2, both goals appear in goals_summary with hits_count > 0.
- **Trace:** `fusion.per_goal_counts_in_topN`, `distribution.hits_by_act_top3` (already).

## Risk 4: Latency explosion with 3 goals × acts

**Reality:** 3 goals × (1 embed + taxonomy + 2 Qdrant steps + 5 acts × chunk search) = many sequential Qdrant calls. p95 can exceed acceptable UX.

**Mitigation:**
- **Code:** Config cap: max 3 goals (already), consider max acts per goal (e.g. 3 per goal, total 8) to bound within-act calls. Track and expose `qdrant_calls_count` (or per-stage) in trace for debugging.
- **Test:** Harness collects duration_ms per run; assert median ≤ threshold (e.g. 15s), p95 ≤ threshold (e.g. 45s). Assert qdrant_calls ≤ cap (e.g. goals * (2 + acts_per_goal) + overhead).
- **Trace:** `meta.retrieval_debug_bundle` or `meta.qdrant_calls_count` (and per-stage time_ms).

## Risk 5: Too many hits to downstream (U5/U9)

**Reality:** If retrieval returns 100+ hits, U5/U9 or RunRecord payload can grow. Today fusion topN=30 and diversity cap limit the list, but multi-goal merge-before-fusion can be large.

**Mitigation:**
- **Code:** After fusion + diversity cap, hard-cap final `rawHits` length (e.g. 100). Slice before returning and before persisting to RunContext.
- **Test:** Assert `retrieval_trace.hits.length <= 100` (or configured cap) in verify harness.
- **Trace:** `meta.hits_count` already; no change.

---

## Implementation order

1. Hard Queries Pack (≥45 cases) + budget/latency assertions.
2. Planner tiers (0/1/2) + fallback reason_codes (PLANNER_FAILED, PLANNER_RATE_LIMIT).
3. Fusion: per_goal_counts_in_topN, optional dominant-goal cap, anti-noise ("Окрема думка" penalty).
4. Observability: retrieval_debug_bundle, meta.qdrant_calls_count_total (реальний лічильник викликів Qdrant), metrics: u4_planner_tier_selected_0/1/2_total, u4_planner_calls_1/2_total (тільки коли LLM викликався), u4_qdrant_calls_total, u4_goals_count_1/2/3_total, u4_coverage_enforced_total, u4_hits_cap_applied_total, u4_hits_before_cap_le_100/101_200/gt_200_total, u4_noise_penalty_total.
5. Final hard-cap on hits length (u4HitsCap), trace cap transparency (hits_total_before_cap, hits_total_after_cap, hits_cap_applied). Harness assertion: verify:retrieval-multigoal 62 cases, budget (median/p95/llm%/cap%), cap transparency regression.
