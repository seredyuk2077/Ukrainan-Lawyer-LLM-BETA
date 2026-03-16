# ADR: U10 Legal Agent scaffold — Claude Sonnet 3.7 Thinking (LEX-133)

**Date:** 2026-02-22  
**Status:** Accepted

## Context

U10 generates the final answer using an LLM. The stack uses OpenRouter; we need a single model for the legal agent writer, with timeout/retry and production readiness (Azure, concurrency).

## Decision

1. **Model:** Claude Sonnet 3.7 Thinking — OpenRouter id `anthropic/claude-3.7-sonnet:thinking`. Single source of truth: `config.legalAgentModelId` (env override: LEGAL_AGENT_MODEL_ID or U10_MODEL_ID).

2. **Timeout / retry:** 50–55s timeout (thinking model can be slower). One retry only on 429 or 5xx, with 800ms backoff. Implemented in runLegalAgent; openRouterChat already retries once on 5xx.

3. **Idempotency:** U10 consumer checks RunContext for existing `llm_result` before calling the LLM. If present, skip and enqueue U12. Prevents duplicate side effects on replay.

4. **Persistence:** Result stored in RunContext as `llm_result`. GET /v1/runs/:id merges llm_result from RunContext when available. No new DB column in this phase (optional later).

5. **Concurrency / Azure:** Handler and runLegalAgent are stateless. No global mutable state; OpenRouter concurrency limiter is process-wide (semaphore). Safe for multiple concurrent runs keyed by run_id.

6. **Security:** Do not log prompt or answer content; log only metadata (model, latency_ms, token counts, status).

## Consequences

- E2E pipeline U4 → U5 → U9 → U10 → U12 produces a real LLM answer and exposes it via GET /v1/runs/:id when RunContext is available.
- U11 (verify) and U12 (deliver/SSE) remain stubs; follow-up tasks for real verify and persistence to messages/outbox.
