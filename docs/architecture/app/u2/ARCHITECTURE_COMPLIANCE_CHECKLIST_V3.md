# Architecture Compliance Checklist v3 (U2)

Підтверджується тестами: `pnpm brain:u2:test`, `pnpm brain:u2:stress`, `pnpm brain:u2:loadtest`.

## U1 → U2 boundary

| Пункт | Статус | Примітка |
|-------|--------|----------|
| POST /v1/runs повертає 202 + run_id | ✅ | handler.ts |
| RunRecord створюється в Postgres (tenant_id, user_id, query, snapshot) | ✅ | storage.ts create() |
| RunEvent { run_id, step: "U2", created_at, trace_id } у чергу | ✅ | handler.ts taskQueue.enqueue() |
| Attachments overflow → R2, у DB manifest | ✅ | attachments.js, gateway |

## U2 pipeline

| Пункт | Статус | Примітка |
|-------|--------|----------|
| U2(0) consumer обробляє step "U2" | ✅ | consumer.ts handleU2Event |
| Pre-extract entities (U2c) завжди | ✅ | extractEntities(query) |
| InputNormalizer (довгий/шум) перед U2a/b/d | ✅ | normalizeInput(), effectiveQuery |
| U2a Intent, U2b Domain, U2d Ambiguity (rules) | ✅ | intent-classifier, legal-domain-tagger, ambiguity-detector |
| LLM-first: OpenRouter при наявному ключі та !USE_RULE_BASED_CLASSIFIER | ✅ | config.openRouterApiKey, OPENROUTER_API_KEY_ONLINE пріоритет |
| Degraded при помилці/таймауті LLM (intent=question, domain=general, entities з pre-extract) | ✅ | buildDegradedProfile |
| Entities merge: union(pre_entities, llm_entities) | ✅ | mergeEntities() у consumer |
| QueryProfile з meta (classifier_mode, prompt_version, model_id, latency_ms, retries, warnings) | ✅ | query_profile.meta |
| routing_flags (need_deep_retrieval, need_web, ambiguous, input_is_large, need_clarification; optional: has_attachments, input_looks_like_contract/table/legal_text, contains_sensitive_data_possible) | ✅ | types.ts, consumer (extended types; heuristics optional) |
| RunContext set(run_id, { query_profile, routing_flags }, TTL) | ✅ | runContextSet |
| RunRecord.query_profile оновлюється (audit) | ✅ | runRepo.updateQueryProfile |
| Stub "would enqueue U3" | ✅ | logger у consumer |

## Concurrency & stores (prod-ready)

| Пункт | Статус | Примітка |
|-------|--------|----------|
| RunContextStore interface (get/set/del) | ✅ | lib/run-context-store.ts |
| InMemoryRunContextStore (dev) | ✅ | default when no REDIS_URL |
| RedisRunContextStore (prod, optional) | ✅ | when REDIS_URL + RUN_CONTEXT_DRIVER=redis |
| TaskQueue interface; Redis adapter optional (pending) | ✅ | gateway/queue.ts InMemoryQueue; Redis queue not implemented |
| U2 worker concurrency limit | ✅ | U2_WORKER_CONCURRENCY (config); inflight tracked by metric |
| U2 LLM concurrency limit (semaphore) | ✅ | U2_LLM_CONCURRENCY, Semaphore around classifyWithLLM in consumer |
| Метрики: queue_depth, inflight, llm_inflight, rate_limited | ✅ | observability.ts; consumer increments/decrements |
| Circuit breaker / fast-degrade при серії помилок LLM | ✅ | circuit-breaker.ts; consumer uses isCircuitOpen, recordLlmFailure, 429→incrementU2LlmRateLimited |

## Multi-tenant & safety

| Пункт | Статус | Примітка |
|-------|--------|----------|
| run_id — UUID, унікальний | ✅ | randomUUID() у handler |
| RunContext ключується тільки run_id | ✅ | namespace lexery:runctx:{run_id} у Redis |
| DB RunRecord містить tenant_id, user_id | ✅ | storage |
| Load test: 50 concurrent, різні tenant/user — без змішування | ✅ | brain:u2:loadtest |

## Observability & secrets

| Пункт | Статус | Примітка |
|-------|--------|----------|
| Логи без секретів (key_present: true/false) | ✅ | server.ts U2 config (safe) |
| Логи U2 started/finished, classifier_mode, duration_ms | ✅ | consumer.ts |
| Метрики u2_processed_total, u2_failed_total, u2_ambiguous_total | ✅ | observability.js |

## R2 policy (inputs)

| Пункт | Статус | Примітка |
|-------|--------|----------|
| Query text: якщо bytes > QUERY_R2_THRESHOLD_BYTES — overflow у R2, у DB preview + snapshot.input | ✅ | gateway/query-overflow.ts, handler.ts |
| Bucket для run inputs: lexery-legal-agent | ✅ | config.r2BucketRuns, key runs/{tenant}/{run_id}/input/query.txt |
| U2 використовує preview (head+tail) з snapshot.input, не тягне повний текст з R2 | ✅ | consumer resolves query from query_preview; meta input_source |

## Ambiguity (rules-override)

| Пункт | Статус | Примітка |
|-------|--------|----------|
| Rules ambiguity-detector завжди (strength: hard/soft, reason_codes) | ✅ | ambiguity-detector.ts |
| Merge: rules hard → override LLM; soft → OR; else LLM | ✅ | consumer mergeAmbiguity() |
| meta.ambiguity_source, override warning + reason_code | ✅ | query_profile.meta |
| "мобілізація", "поліція", "права", "обов'язки" → ambiguous true (LLM mode) | ✅ | u2_test_queries.ts 25 queries |

## Tests

| Пункт | Статус | Примітка |
|-------|--------|----------|
| brain:u2:test — 25/25 rules, 25/25 LLM (або degraded де очікується) | ✅ | u2_test_queries.ts (25 queries); 429 = fail, підніміть env |
| brain:u2:stress — 20/20, валідний profile (large/table/essay/multi-ref) | ✅ | u2_stress_queries.ts; poll timeout 25 s |
| brain:u2:loadtest --concurrency=10 --requests=30 | ✅ | u2_loadtest.ts; 429 count + tip у summary |
| brain:u2:loadtest 50/50 (server MAX_CONCURRENT_RUNS=50, RUNS_PER_MINUTE=120) | ✅ | gateway.md; 0 × 429 when server env set |
| Jurist suite (довгі тексти, таблиці, абсурд, есе ~10k) | ✅ | stress 20 queries |

## R2 (U2 read-only)

| Пункт | Статус | Примітка |
|-------|--------|----------|
| U2 не пише input у R2; тільки читає preview з snapshot | ✅ | r2-usage-policy-inputs.md, consumer |

## Prod readiness (U2)

| Пункт | Статус | Примітка |
|-------|--------|----------|
| RunContext TTL, prune on get, no unbounded growth | ✅ | run-context-store.ts |
| Inflight decrement in finally (handler + LLM path) | ✅ | consumer.ts |
| Circuit breaker reset after openMs, resetCircuit() for tests | ✅ | circuit-breaker.ts |
| Multi-tenant: run_id key, tenant_id/user_id in DB and logs | ✅ | storage, loadtest unique tenant |
| u2:test / u2:stress unique tenant per run (no 429 from sharing) | ✅ | U2_TEST_TENANT_ID, U2_STRESS_TENANT_ID override |
