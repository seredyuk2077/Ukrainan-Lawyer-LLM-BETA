# ADR: U4 Goal splitting v2 (taxonomy-induced, substance vs procedure)

## Status

Accepted (Phase 3). Implemented in goal-splitter.ts + cache-rag.ts.

## Context

Real-dev KPI was stuck at 27/43 hard_pass. Bottleneck: many queries need both substance (e.g. tax, labor, criminal) and procedure/judiciary (appeal, proceedings). Heuristic goal split (multi_question, multi_topic, contract/table) did not reliably split these. We needed a data-driven split using taxonomy and chunks evidence only — no new word→act dictionaries.

## Decision

**Goal split v2 (category-cluster split):**

1. **When:** After heuristic goal split yields exactly 1 goal. Then fetch taxonomy candidates for the query and run category-cluster split.
2. **Inputs:**
   - Taxonomy candidates: alias_hits with category per act (from ActTaxonomyStore).
   - Optional: chunks evidence distribution in top30 (category histogram). Single-goal path may not have chunks yet; then only taxonomy counts.
   - query_profile.routing_flags, domain, ambiguity (no new “word” triggers).
3. **Algorithm:**
   - Build **category_support**: from taxonomy alias_hits, count (or score) per category; optionally from chunks evidence count_in_top30 per category.
   - Define two clusters: **substance** (tax_customs, labor_social, civil, criminal, admin) and **procedure** (judiciary_justice, criminal_procedure, civil_procedure). Categories come from taxonomy snapshot; if "judiciary_justice" is absent, procedure = “second strongest category ≠ substance”.
   - **Split rule:** Split into 2 goals only if:
     - top1_support and top2_support both above threshold (e.g. CATEGORY_SPLIT_MIN_SUPPORT = 2),
     - top2 category is not "other/unknown",
     - query is not direct_citation (article/act number already present).
   - Result: goal A with domain_hint=substance, required_categories=[cat_substance]; goal B with domain_hint=procedure/judiciary, required_categories=[cat_procedure]. Both use original query; anchor_tokens only from respective category buckets (ActTaxonomyStore), no manual synonyms.
4. **Trace:** goals_summary[].split_source = "TAXONOMY_CLUSTER_SPLIT_V2", meta.stage_decisions.goal_split_v2 = true, meta.goal_split_inputs = { top_categories, supports }.
5. **Per-goal act allocation:** When goals_count ≥ 2, act pool per goal is filtered by goal.required_categories; minActsPerGoal = 2 when candidates exist; else reason_codes GOAL_ACT_POOL_WEAK. Trace: per_goal_act_pool_size, goals_summary[].act_pool_size.
6. **Selected_acts multi-goal:** minDistinctActs = goals_count (or goals_count+1 if procedure goal); max 8; PRIMARY_LAW priority. If selected_acts do not cover all goals → reason_codes COVERAGE_MISS_SELECTED_ACTS, low_confidence = true.

**Order of stages:** heuristicGoalSplit → [if 1 goal] getTaxonomyCandidates → tryCategoryClusterSplitV2 → [if 2 goals] per-goal act pool (required_categories) → per-goal retrieval → fusion → buildSelectedActs (coverage check).

## Constraints

- No Supabase/Qdrant/R2 schema or data changes.
- No golden on banned topics (шахрайство/ст.130/ККУ-115/нетверезе водіння).
- No word→act heuristics; anchors/variants only from taxonomy snapshot, query_profile, or LLM planner output.
- Max 3 goals (config goals_max).

## Consequences

- Real-dev hard_pass improved 27 → 30/43; quality gate (MIN_HARD_PASS=30, MAX_HARD_FAIL=13) allows iteration without requiring 43/43.
- Multi-goal path runs more often when taxonomy + evidence show two strong category clusters (e.g. tax+appeal, labor+procedure).
- Trace enables debugging: goal_split_inputs, per_goal_act_pool_size, COVERAGE_MISS_SELECTED_ACTS, GOAL_ACT_POOL_WEAK.
