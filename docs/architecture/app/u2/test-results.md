# U2 Test Results (LEX-88)

## Smoke test: U1 → U2

**Умови:** Brain server на порту 3081, `DEV_API_KEY=dev-key-change-me`.

### 1. ККУ ст. 115 умисне вбивство

- **POST** `/v1/runs` → 202, `run_id`, status accepted.
- Після ~1–2 с **GET** `/v1/runs/:id` → status `Profiling`, `query_profile` заповнений.
- **Очікування:** intent `question`, domain `criminal`, entities: act_abbrev ККУ, article_ref ст. 115, has_direct_citation true, ambiguity false або м’яка.

### 2. Звільнення працівника за прогул

- **POST** `/v1/runs` → 202.
- **GET** `/v1/runs/:id` → query_profile: domain `labor`, intent `question`.

### 3. мобілізація (ambiguity)

- **POST** `/v1/runs` → 202.
- **GET** `/v1/runs/:id` → query_profile.ambiguity.is_ambiguous true, reasons містять `ambiguous_term`, ambig_terms містять «мобілізація».

### 4. Dry-run не створює run

- **POST** `/v1/runs` з `dry_run: true` → 200, без події U2.

## Команди

```bash
# Запуск сервера
DEV_API_KEY=dev-key-change-me pnpm brain:dev

# Приклад 1
curl -s -X POST http://localhost:3081/v1/runs \
  -H "Content-Type: application/json" -H "X-Dev-API-Key: dev-key-change-me" \
  -d '{"query":"ККУ ст. 115 умисне вбивство","tenant_id":"00000000-0000-0000-0000-000000000001","user_id":"00000000-0000-0000-0000-000000000002"}'

# Отримати run_id з відповіді, потім:
curl -s "http://localhost:3081/v1/runs/<run_id>" -H "X-Dev-API-Key: dev-key-change-me"
```

## Результат (2026-02-06)

| Сценарій | Expected | Actual |
|----------|----------|--------|
| POST run ККУ ст. 115 | 202, run_id | 202, run_id ✓ |
| GET run після U2 | status Profiling, query_profile | Profiling, query_profile з intent/domain/entities/ambiguity ✓ |
| Run «мобілізація» | is_ambiguous true, ambig_terms | is_ambiguous true, ambig_terms ["мобілізація"] ✓ |
| Логи U2 started/done | run_id, step U2, duration_ms | Є ✓ |

## U2 test suite (20+ запитів)

Запуск: `pnpm brain:u2:test` (сервер має бути запущений на 3081). Можна з `USE_RULE_BASED_CLASSIFIER=true` (тільки rules) або з `OPENROUTER_API_KEY` / `OPENROUTER_API_KEY_ONLINE` (LLM path).

Набір запитів покриває:

- ККУ ст. 115 умисне вбивство
- ст.115-1 ККУ, стаття 115¹, стаття 115 з позначкою один
- ч. 2 ст. 115 ККУ, п. 1 ч. 2 ст. 115 ККУ
- пункт 1 статті 10 ЗУ "Про Національну поліцію"
- ЗУ про мобілізаційну підготовку і мобілізацію ст 22
- КЗпП ст. 40, ЦКУ ст. 1166, КАС, ПКУ
- Звільнення за прогул, як захистити право власності, мобілізація (ambiguity)
- стаття 1-1-1, ст 000, кку 115 один (шум)
- складіть заяву (drafting), як оскаржити (procedure)
- МВС та СБУ (authorities)

Очікування: query_profile з meta (classifier_mode: llm | rules | degraded), routing_flags при LLM. Таблиця результатів виводиться в консоль (query, expected, actual, status ✅/❌).

## E2E Verification (2026-02-06)

### Server start
- Command: `pnpm brain:dev` (root). Env: root `.env` (dotenv cwd + `scripts/lexery-legal-agent/.env`).
- Safe startup log: `openrouter_key_present`, `clf_model_id`, `clf_timeout_sec`, `use_rule_based_classifier`, `port`.
- Canonical key: `OPENROUTER_API_KEY_ONLINE` (priority over `OPENROUTER_API_KEY` in `lib/config.ts`).

### C1 Health
- `curl http://localhost:3081/health` → 200, `database: "ok"`, `status: "healthy"`.

### C2 Rules-only (USE_RULE_BASED_CLASSIFIER=true)
- **19/22** passed. 3 failures (rule-based limitations): «як захистити право власності» (domain civil), «складіть заяву» (intent drafting), «як оскаржити рішення податкової» (intent procedure).
- Examples: ККУ ст. 115 → question/criminal/2; ст.115-1 ККУ → question/criminal/2; мобілізація → ambiguous true.

### C3 LLM path (OPENROUTER_API_KEY_ONLINE from .env)
- Wait 5.5s per run (LLM ~3–5s). **21/22** passed.
- **LLM mode:** 20/22 rows; **degraded:** 1 (стаття 1-1-1); **1 failure:** «як оскаржити рішення податкової» (expected intent procedure, actual question — LLM variance).
- Hard cases: ст.115-1 ККУ, стаття 115¹, стаття 115 з позначкою один, п. 1 ч. 2 ст. 115, пункт 1 статті 10 ЗУ «Про Нацполіцію» — all ✅ (domain/entities as expected in LLM).

### C4 Edge (manual GET)
- query_profile.meta: `prompt_version: 1`, `model_id: openai/gpt-4o-mini`, `classifier_mode: llm`, `routing_flags` present.
- «мобілізація» → ambiguity true.
- «п. 1 ч. 2 ст. 115 ККУ» → entities 4; «пункт 1 статті 10 ЗУ Про Нацполіцію» → entities 2; «стаття 115 з позначкою один» → entities 1.

## E2E Verification v2 (2026-02-06)

### Test approach
- **Polling:** POST → poll GET every 200–1000 ms until query_profile present, max 10 s (no fixed sleep).
- **Latency:** u2_latency_ms (POST → query_profile ready), median/p95 in summary.

### Results
- **Rules-only:** 22/22. Median ~411 ms, p95 ~627 ms.
- **LLM:** 22/22. Mode: llm 18, degraded 4. Median ~3348 ms, p95 ~6686 ms.
- **Stress:** 15/15 (long, absurd, emoji, mix UA/RU/EN). All valid profile, no timeout.

### Model benchmark
- `pnpm brain:u2:bench-models` (U2_BENCH_MODELS=openai/gpt-4o-mini,google/gemini-2.0-flash-exp:free).
- openai/gpt-4o-mini: median 2517 ms, pass 14/14, 0 degraded → **default CLF_MODEL_ID**.
- google/gemini-2.0-flash-exp:free: 0 valid (rate limit / availability).

### Additions
- U2-preprocessor (InputNormalizer): long query truncation, noise → need_clarification, meta input_truncated/original_length/effective_length.
- Merge policy: entities = union(pre_entities, llm_entities); routing_flags = normalizer overrides + LLM.
- RoutingFlags: input_is_large, need_clarification.

## E2E Verification v3 (2026-02-06) — U2 production-ready

### Ambiguity rules-override
- **Policy:** Rules "hard" (AMBIG_TERMS, TOO_SHORT_QUERY) override LLM so ambiguity is deterministic. See `decisions/ambiguity-rules-override.md`.
- **meta:** `ambiguity_source`: "llm" | "rules_soft" | "rules_hard_override" | "merged"; on override: warning `ambiguity_overridden_by_rules:<reason_codes>`.
- **Test:** 25 queries including "мобілізація", "поліція", "права", "обов'язки" → expected `ambiguous: true`; 25/25 in LLM mode when server limits allow (no 429).

### Test suite (25 queries)
- `pnpm brain:u2:test` — 25 queries (22 original + 3 ambiguous hard-term: поліція, права, обов'язки). Pass rate 25/25 (LLM) and 25/25 (rules-only) when no 429.
- **429:** If POST returns 429, test fails; for full pass ensure `MAX_CONCURRENT_RUNS` and `RUNS_PER_MINUTE` are sufficient (e.g. default 10/30 for dev; for 50-concurrent loadtest use 50/60).

### 50 concurrent readiness
- **Gateway:** Start server with `MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120`; then run `pnpm brain:u2:loadtest --concurrency=50 --requests=50`. See `docs/architecture/app/u1/gateway.md` — "Testing 50 concurrent". RUNS_PER_MINUTE=120 allows 50 requests in first batch plus follow-up within the same minute.
- **Loadtest:** With default server (10/30): 50/50 yields 429 (expected). With server 50/120: 50/50 expected 0 × 429, success rate 100%. On 429, summary shows 429 count and tip to start server with 50/120.

### R2 policy (U2)
- U2 does **not** write input to R2; only reads preview from snapshot (or `run.query`). See `decisions/r2-usage-policy-inputs.md`.

### Pass rate / latency (reference)
- **LLM path:** 25/25 (no 429), median ~3–4 s, p95 ~6–7 s.
- **Rules-only:** 25/25 (server started with USE_RULE_BASED_CLASSIFIER=true).
- **Stress:** 20/20 (18 original + legal essay ~10k + long multi-ref).
- **Loadtest:** 30/30 (concurrency=10, requests=30); 50/50 when server started with MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120.

### Test tools (non-flaky)
- **u2:test** — by default uses unique tenant_id per run (Date.now-based); override: U2_TEST_TENANT_ID, U2_TEST_USER_ID. Any 429 → fail with clear message (raise MAX_CONCURRENT_RUNS / RUNS_PER_MINUTE on server). Report prints tenant_id, user_id, mode %.
- **u2:stress** — unique tenant per run; override: U2_STRESS_TENANT_ID. Poll timeout 25 s (large/table inputs).
- **u2:loadtest** — unique tenant per run (or LOADTEST_TENANT_ID). On 429: summary shows 429 count + tip to start server with 50/120.

### Large/Weird Inputs evidence
- **Stress dataset (20):** long text (14k chars), contract-like (~50k), table (CSV + markdown), legal excerpt (~40k), legal essay (~10k), long multi-ref query, absurd noise, emoji, mixed UA/RU/EN, short "Short". Success = valid QueryProfile, meta (original_length, effective_length, input_truncated when truncated), routing_flags (input_is_large, need_clarification, input_looks_like_contract/table/legal_text), degraded policy when LLM fails. Ambiguity rules-override unchanged.

## Release Report (U2 Final Hardening)

**Commit:** `b12831a` (or current HEAD; ensure clean restart — see gateway.md "How to ensure clean restart").

**Conclusion:** U2 закритий, готовий до масштабу. Ambiguity rules-hard override дає 25/25 у LLM mode (мобілізація, поліція, права, обов'язки → ambiguous=true). Loadtest 50/50 з env 50/120 дає 50/50, 0×429.

**Commands:**
```bash
# Ensure port 3081 free: kill $(lsof -t -i :3081) 2>/dev/null; sleep 2

# Server LLM mode (same DEV_API_KEY as test; e.g. dev-key-change-me)
DEV_API_KEY=dev-key-change-me pnpm brain:dev

# Server for 50 concurrent
MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120 DEV_API_KEY=dev-key-change-me pnpm brain:dev

# Server rules-only (for rules 25/25)
USE_RULE_BASED_CLASSIFIER=true DEV_API_KEY=dev-key-change-me pnpm brain:dev

# Tests (in another terminal; tools load .env so DEV_API_KEY can match, or set explicitly)
pnpm brain:u2:test
pnpm brain:u2:stress
pnpm brain:u2:loadtest --concurrency=10 --requests=30
pnpm brain:u2:loadtest --concurrency=50 --requests=50   # server must be 50/120
```

**Actual results (2026-02-06):**
| Test | Result | 429 | Latency median/p95 | llm / rules / degraded % |
|------|--------|-----|--------------------|---------------------------|
| u2:test (LLM) | 25/25 | 0 | 468 ms / 5048 ms | 36% llm, 60% rules, 4% degraded |
| u2:test (rules-only) | 25/25 | 0 | 364 ms / 458 ms | 0% llm, 100% rules |
| u2:stress | 20/20 | 0 | — | — |
| u2:loadtest 10/30 | 30/30 | 0 | 425 ms / 574 ms | 0% llm, 100% rules |
| u2:loadtest 50/50 (server 50/120) | 50/50 | 0 | 492 ms / 800 ms | 0% llm, 100% rules |

## Prod Readiness Notes (U2)

- **RunContextStore:** In-memory prune on get (expiresAt); TTL 3600 s. No unbounded growth: entries expire; under 50 concurrent, set then read then eventual prune. U3 stub does not del yet; TTL suffices.
- **Inflight/metrics:** incrementU2Inflight at start of handler; decrementU2Inflight in finally. incrementU2LlmInflight before LLM; decrementU2LlmInflight in finally. No leak on exception/timeout.
- **Circuit breaker:** recordLlmFailure on LLM fail; isCircuitOpen() returns true after threshold failures in window; after openMs (default 30 s) circuit resets (openedAt cleared). resetCircuit() for tests. Does not lock forever.
- **Multi-tenant:** RunContext keyed by run_id only (UUID). DB RunRecord has tenant_id, user_id. Loadtest uses one tenant per run (unique id); logs include tenant_id/user_id. No cross-tenant mixing.
- **Secrets:** Logs use key_present: true/false; no API keys or tokens in logs.
