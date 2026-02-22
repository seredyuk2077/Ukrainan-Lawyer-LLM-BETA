# ADR: U4 Evidence Goals and Fusion

## Status

Accepted.

## Context

U4 retrieval originally assumed one query → one intent → one set of act candidates → one ranking. Real evidence search often needs:

- **Multi-intent:** e.g. "Що таке шахрайство? і чия по підслідності?" (definition + procedure) → need both criminal (ККУ) and criminal procedure (КПК).
- **Contract/compliance:** long input + "перевір на відповідність ЦКУ" → need compliance_check goal and civil acts.
- **Multi-domain:** e.g. "податкова перевірка і оскарження рішення" → tax + admin/procedure.

Without explicit goals and fusion, a single ranking can be dominated by one subquery and miss evidence for others.

## Decision

1. **EvidenceGoal** — Introduce a goal type: `id`, `goal_type` (definition | liability | procedure | compliance_check | reference_resolution), `subquery`, `domain_hint?`, `required_categories?`, `must_have_signals?`, `budget_hint?`. No article names at planning.
2. **Heuristic goal splitter** — No LLM by default. Detect: multi_question (several "?", "і чия"), multi_topic (criminal+procedure, tax+admin, labor+civil), contract/table from routing_flags. Cap: `goals_max = 3` (config).
3. **Per-goal retrieval** — For each goal: embed(goal.subquery), getTaxonomyCandidates(goal.subquery, goal.domain_hint), run chunks + acts + within-act, tag each hit with `goal_id`.
4. **Goal fusion + coverage** — Merge hits; dedupe by (r2_key, json_path). In top N (u4FusionTopN), ensure at least M hits per goal (u4FusionMinHitsPerGoal) when available. Then apply act diversity cap (existing). Score fusion uses existing hybrid (vector + alias + article + category + title); no extra LLM.
5. **Trace** — meta includes `goals_summary` (per goal: goal_id, goal_type, subquery_preview, act_candidates_top3, hits_count, top_score), `fusion` (coverage_enforced, per_goal_min_hits, topN), `stage_decisions` (used_goal_splitter, used_llm_planner, per_goal_act_retrieval, used_global_fallback).

## Consequences

- Multi-question and multi-domain queries get evidence from multiple acts without manual splitting.
- Coverage constraint prevents one goal from dominating the top list.
- Heuristic-only path keeps cost and latency low; LLM planner is optional and trigger-based (see u4-llm-retrieval-planner-policy.md).
- New categories/aliases in Supabase legislation taxonomy work without DB schema changes; retrieval uses taxonomy "as is."
