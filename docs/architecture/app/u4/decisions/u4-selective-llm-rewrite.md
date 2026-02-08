# ADR: U4 Selective LLM Rewrite / Rerank

## Context

U4 retrieval is currently non-LLM (embedding + hybrid re-score + diversity cap). For edge cases (low_confidence, diversity collapse, domain mismatch), optional LLM rewrite or rerank could improve results.

## Decision

- **Triggers** (any): hits < MIN_HITS, top_score < MIN_TOP_SCORE, diversity collapse, mismatch between domainHint and act_candidates_top.
- **When triggered**: (1) LLM rewrite: generate 3–5 legal paraphrases + synonyms (no requirement to name articles). (2) Optional 1–2 extra retrieval requests. (3) Optional LLM rerank of top 30 (refs + short titles only, no full text).
- **Limits**: U4_LLM_CONCURRENCY, U4_LLM_TIMEOUT_SEC, circuit breaker on 429/5xx. Same pattern as U2.
- **Current state**: Triggers and trace fields (used_llm_rewrite, used_llm_rerank) are defined; actual LLM calls are not implemented yet (used_llm_rewrite: false, used_llm_rerank: false).

## Consequences

- When implemented: better recovery on low-confidence runs; bounded latency and cost via concurrency/timeout/CB.
- No DB writes; retrieval engine only.
