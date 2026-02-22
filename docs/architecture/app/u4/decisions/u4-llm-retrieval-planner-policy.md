# ADR: U4 LLM Retrieval Planner — When and Limits

## Status

Accepted.

## Context

Multi-goal retrieval can be driven by heuristics (multi_question, multi_topic, contract/table). For complex or ambiguous inputs (e.g. long contract + "перевір на відповідність ЦКУ"), heuristics may under-split or mis-classify. An LLM can return structured goals (goal_type, subquery, domain_hint, likely_acts, keywords, why) to improve planning. We want to use the LLM only when needed and keep cost/latency bounded.

## Decision

1. **Triggers for LLM planner** — Call LLM planner only when:
   - `multi_goal_detected` (heuristic already produced 2+ goals), or
   - `input_is_large && input_looks_like_contract` (routing_flags from U2).
   - Do **not** call for every multi-topic query; heuristics handle most.
2. **Config** — `U4_PLANNER_ENABLED=true` to enable; default off. Model: `U4_PLANNER_MODEL_ID` (fallback CLF_MODEL_ID or anthropic/claude-sonnet-4). `U4_PLANNER_TIMEOUT_SEC`, `U4_PLANNER_MAX_TOKENS` (small, e.g. 512), `U4_PLANNER_CONCURRENCY` (e.g. 2).
3. **Guardrails** — Reuse U2-style: semaphore (limit concurrent planner calls), circuit breaker (recordLlmFailure / isCircuitOpen). On circuit open or planner failure, keep heuristic goals.
4. **Caching** — Planner result cached in RunContext by run_id; same run never calls planner twice.
5. **Output** — JSON goals only: goal_type, subquery, domain_hint, likely_acts, keywords, why. **No article numbers or titles**; planning only. Taxonomy and within-act retrieval remain data-driven (Supabase + Qdrant).
6. **Trace** — meta.planner: model_id, duration_ms, degraded, reason_codes; stage_decisions.used_llm_planner = true when LLM goals were used.

## Consequences

- LLM is used only when triggers fire; most traffic stays heuristic-only.
- Bounded tokens and timeout keep cost and latency acceptable.
- Circuit breaker avoids cascading failures when OpenRouter is degraded.
- Caching avoids duplicate planner calls for the same run (e.g. retries or re-runs).
