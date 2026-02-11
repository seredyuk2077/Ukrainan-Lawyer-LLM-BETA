# U4 Routing-hints LLM (Phase 6.1)

## Context

After taxonomy, chunks evidence, acts search, and family coverage guard (Phase 5), we still have bucket A (wrong family routing) on real-dev. The routing-hints LLM provides **hints only**: families (from taxonomy or "unknown"), goal decomposition, query variants — no word→family dictionaries, no concrete act/article IDs.

## Policy

- **Default:** `U4_ROUTING_HINTS_ENABLED=false`. LLM is not called unless explicitly enabled.
- **Triggers (any one):** family_weak_evidence, family_conflict, selected_acts_confidence < 0.55, COVERAGE_GUARD_FAILED, NO_STRONG_ACT_EVIDENCE, or query short/cryptic with high entropy.
- **Output usage:** families_ranked → family-prioritized act allocation (ensure ≥1 PRIMARY_LAW from top2 families if available); suggested_goals → optional replacement of heuristic goals (capped 3); query_variants → optional rescue ACTS search; overall_confidence low → low_confidence + ROUTING_HINTS_LOW_CONF.
- **family_key:** Only values from taxonomy categories or "unknown". Unknown LLM output is mapped to "unknown".
- **Trace:** meta.routing_hints (enabled, called, call_failed_reason?, model_id?, tokens_approx?, families_ranked_top2, goals_count).
- **Metrics:** u4_routing_hints_called_total, u4_routing_hints_failed_total, u4_routing_hints_used_total.
- **Budget:** U4_ROUTING_HINTS_MAX_TOKENS=256, U4_ROUTING_HINTS_MAX_CALLS_PER_RUN=1, U4_ROUTING_HINTS_CONCURRENCY=1.

## Real-dev KPI (before/after Phase 6.1)

- **Before (Phase 5):** hard_pass 30/43, hard_fail 13, gate PASS. Bucket A ~10 (stable), D ~2.
- **After (routing-hints disabled):** unchanged. Routing-hints is opt-in; when enabled, target ≤25% DEV cases called, hard_pass ≥33 or hard_fail ≤10 with no regression on quality/multigoal.

## DoD

- routing-hints called rarely (≤25% DEV when enabled).
- family_key only from taxonomy or "unknown".
- No word→family/act dictionaries.
- Trace and metrics in place; no raw prompt logging.
