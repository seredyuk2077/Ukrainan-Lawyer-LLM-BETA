# [U2] Query Profiling Pipeline — Implementation

Пайплайн профілювання запиту: **LLM-first** (OpenRouter) + rule-based fallback. Pre-extract (rule-based entities) → LLM classify (intent, domain, entities normalization, ambiguity) або повністю rules при `USE_RULE_BASED_CLASSIFIER=true` / відсутньому API key. Результат зберігається в **RunContext** (in-memory TTL) та **RunRecord.query_profile** (аудит з meta).

## Документація

| Документ | Опис |
|----------|------|
| [pipeline.md](./pipeline.md) | LLM-first flow, retry, timeout, schema, RunContext, ambiguity rules-override |
| [test-results.md](./test-results.md) | Smoke, 25 тест-запитів, stress 20, loadtest, Release Report |
| [ARCHITECTURE_COMPLIANCE_CHECKLIST_V3.md](./ARCHITECTURE_COMPLIANCE_CHECKLIST_V3.md) | Чекліст відповідності архітектурі |
| [decisions/](./decisions/) | ADR-лайт (versioning, U2→U3, LLM choice, ambiguity override, R2 policy, concurrency) |

## Код

Усі шляхи відносно `scripts/lexery-legal-agent/`:

- `classify/consumer.ts` — U2 queue consumer (LLM/rules/degraded, merge ambiguity)
- `classify/llm-classifier.ts` — OpenRouter, JSON parse, zod, 1 retry
- `classify/prompts/u2_classify_v1.ts` — prompt v1
- `classify/schema.ts` — Zod schema для LLM output
- `classify/intent-classifier.ts` — U2a rule-based
- `classify/legal-domain-tagger.ts` — U2b rule-based
- `classify/entity-extractor.ts` — U2c (pre-extract, ст. 115-1, 115¹, п. 1 ч. 2 ст. 115 тощо)
- `classify/ambiguity-detector.ts` — U2d (strength hard/soft, reason_codes)
- `classify/input-normalizer.ts` — U2-preprocessor (довгий/шум, effective_query, routing overrides)
- `lib/openrouter.ts` — OpenRouter chat (timeout, retry)
- `lib/run-context-store.ts` — RunContext (in-memory або Redis), get/set/del, TTL

## Feature flags та ENV

| Env | Опис | Default |
|-----|------|--------|
| `U2_DISABLE_CONSUMER` | Вимкнути U2 consumer | `false` |
| `USE_RULE_BASED_CLASSIFIER` | Тільки rule-based (offline/stub) | `false` |
| `U2_INTENT_LLM_ENABLED` | Увімкнути LLM для classify | `true` (якщо не rules) |
| `U2_DOMAIN_LLM_ENABLED` | Увімкнути LLM для domain | `true` |
| `OPENROUTER_API_KEY_ONLINE` (canonical) / `OPENROUTER_API_KEY` | Ключ OpenRouter | — |
| `CLF_MODEL_ID` | Модель класифікатора | `openai/gpt-4o-mini` |
| `CLF_FALLBACK_MODEL_ID` | Fallback модель при помилці | — |
| `CLF_TIMEOUT_SEC` | Таймаут LLM (с) | `5` |

При відсутності API key або `USE_RULE_BASED_CLASSIFIER=true` використовується лише rule-based; при помилці LLM — degraded profile (intent=question, domain=general) з `profile_generation: "degraded"` та warnings.

## Audit metadata (query_profile.meta)

- `classifier_mode`: `llm` | `rules` | `degraded`
- `prompt_version`, `model_id`, `provider`, `latency_ms`, `retries`, `warnings`

## Запуск і тести

Consumer працює разом із сервером (порт 3081). Перевірка: `GET /v1/runs/:id`. Тести (потрібен запущений сервер, однаковий `DEV_API_KEY` для сервера й клієнта):

- `pnpm brain:u2:test` — 25 тест-запитів (LLM або rules-only за env сервера)
- `pnpm brain:u2:stress` — 20 stress-запитів (довгі тексти, таблиці, шум)
- `pnpm brain:u2:loadtest --concurrency=10 --requests=30` або `--concurrency=50 --requests=50` (для 50/50 сервер з `MAX_CONCURRENT_RUNS=50 RUNS_PER_MINUTE=120`)
