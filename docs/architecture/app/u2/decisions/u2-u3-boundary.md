# ADR: U2→U3 boundary contract (LEX-93 Spike)

## Context

Після U2 пайплайну потрібно передати керування кроку U3 (Planning). Зараз U3 не реалізований; потрібен контракт події/даних.

## Decision

- **Event:** той самий RunEvent: `{ run_id, step: "U3", created_at, trace_id }`. Черга (InMemoryQueue) підтримує той самий тип; зараз U2 лише логить "would enqueue U3", без реального enqueue (немає U3 consumer).
- **Input для U3:** U3 consumer при старті завантажить RunRecord по run_id; дані беруться з `runs.query_profile`, `runs.snapshot`, `runs.query`. Контракт: наявність `query_profile` з `pipeline_step === "U2d_done"` достатня для старту U3.
- **Якщо зробити enqueue U3 зараз:** додати в consumer після persist: `taskQueue.enqueue({ run_id, step: 'U3', created_at: now, trace_id })`. Для цього consumer має отримати посилання на taskQueue (або через getTaskQueue()); зараз не робимо, щоб не створювати «сирі» події U3 без handler.

## Status

Spike closed. Stub: log "would enqueue U3". Contract: U3 reads run by run_id, uses query_profile + snapshot + query.
