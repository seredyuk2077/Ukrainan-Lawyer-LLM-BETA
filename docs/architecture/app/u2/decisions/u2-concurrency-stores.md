# ADR: U2 Concurrency & Stores (production-ready)

## Context

U2 consumer and RunContext were dev-friendly (in-memory). For 50+ concurrent runs and scale-out we need:
- RunContext store that can be shared across instances (Redis).
- Optional Redis-backed queue for U2 events.
- Concurrency limits so that many parallel runs do not overload LLM (rate limits, latency).

## Decision

### RunContextStore
- **Interface:** `get(run_id)`, `set(run_id, data, ttlSec)`, `del(run_id)` (async).
- **Implementations:**
  - **InMemoryRunContextStore** — default when `RUN_CONTEXT_DRIVER=inmemory` or `REDIS_URL` not set.
  - **RedisRunContextStore** — when `REDIS_URL` set and `RUN_CONTEXT_DRIVER=redis`. Key prefix: `lexery:runctx:{run_id}`. No tenant in key — run_id is UUID, globally unique.
- **Redis dependency:** optional; add `ioredis` when using Redis. If REDIS_URL set but ioredis missing, fallback to in-memory and log warning.

### TaskQueue
- **Interface:** `enqueue(event)`, `onEvent(handler)` (existing). In-memory remains default.
- **Redis adapter:** optional; when `QUEUE_DRIVER=redis` and REDIS_URL — namespace `lexery:q:u2`. (Implementation deferred; interface ready.)

### Concurrency
- **U2_WORKER_CONCURRENCY** — not used to cap parallel handleU2Event (queue consumes as fast as handlers run). Inflight metric tracks active U2 jobs.
- **U2_LLM_CONCURRENCY** — semaphore around LLM call (default 4). Prevents burst of LLM requests and reduces rate-limit/429 risk.
- **Circuit breaker:** after N failures (timeouts/429/5xx) in a time window, temporarily skip LLM and use rules/degraded. Config: U2_CIRCUIT_FAILURE_THRESHOLD, U2_CIRCUIT_WINDOW_SEC, U2_CIRCUIT_OPEN_SEC.

### Metrics
- u2_queue_depth, u2_inflight_total, u2_llm_inflight_total, u2_llm_rate_limited_total — for observability and tuning.

### Multi-tenant
- run_id is UUID; DB RunRecord has tenant_id, user_id. RunContext key is only run_id — no cross-tenant leak. Redis keys use prefix `lexery:runctx:` to avoid collisions with other apps.

## Status

Implemented: RunContextStore (InMemory + Redis), config (REDIS_URL, RUN_CONTEXT_DRIVER, U2_LLM_CONCURRENCY), semaphore, circuit breaker, metrics. Queue remains in-memory; Redis queue adapter optional later.
