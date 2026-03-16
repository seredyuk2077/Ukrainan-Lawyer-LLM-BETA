# U11 Verify — pipeline

- **Input:** llm_result (from runs.llm_result or RunContext), produced by U10.
- **Logic:** Verdict = `complete` if answerText non-empty, else `failed`. Optional `reasons`, `metrics` for future extension.
- **Output:** VerifyResult stored in RunContext; event U12 enqueued.
- **Flow:** U10 → U11 → U12. U11 is stateless; no LLM. Full Verify (CoverageCritic, Reranker, StopPolicy) deferred.
