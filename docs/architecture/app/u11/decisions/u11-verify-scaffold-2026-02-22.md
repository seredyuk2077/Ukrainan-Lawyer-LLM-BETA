# ADR: U11 Verify minimal scaffold (2026-02-22)

## Context

U11 Verify (LEX-133 follow-up) must integrate into U10 → U12 flow without blocking. Full verification (CoverageCritic, CrossEncoderReranker, StopPolicy) is future work.

## Decision

- Implement **verdict-only scaffold**: read llm_result from DB or RunContext; set verdict `complete` | `retry` | `failed`; store VerifyResult in RunContext; enqueue U12.
- **Complete** when llm_result.answerText is non-empty; **failed** otherwise. **Retry** reserved for future retry_with_more_evidence.
- No LLM calls in U11 for this run. Contract allows metrics (e.g. coverageScore) and reasons for observability.

## Status

Accepted. Implemented in `write/verifyConsumer.ts`.
