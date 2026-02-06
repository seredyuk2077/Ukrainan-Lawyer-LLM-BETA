# U2 Query Profiling Pipeline

## LLM-first flow

1. **Pre-extract (rule-based)** — завжди: entity-extractor (кодекси, статті, ч. 2 ст. 115, п. 1 ч. 2 ст. 115, ст. 115-1, 115¹, стаття 115 з позначкою один, ЗУ «Про …», органи). Результат — кандидати `pre_entities`.
2. **Класифікація:**
   - Якщо `USE_RULE_BASED_CLASSIFIER=true` або немає `OPENROUTER_API_KEY` → тільки rule-based (U2a, U2b, U2d), `classifier_mode: "rules"`.
   - Інакше → виклик LLM (OpenRouter): query + pre_entities + prompt v1; очікується **строго JSON** (zod-валідація). LLM повертає intent, domain, entities (нормалізовані), ambiguity, routing_flags.
   - При **невалідному JSON** — 1 повторний виклик, потім degraded.
   - При **помилці/таймауті LLM** — 1 retry (fallback model якщо задано), потім **degraded profile**: intent=question, domain=general, entities з pre-extract, ambiguity з rule-based, `profile_generation: "degraded"`, збереження причини в `meta.warnings`.
3. **Persistence:** запис у **RunContext** (in-memory, TTL 1 год) — `query_profile`, `routing_flags`; оновлення **RunRecord.query_profile** (повний JSON з meta для аудиту).
4. **Stub:** лог "would enqueue U3".

## Retry та timeout

- OpenRouter: таймаут `CLF_TIMEOUT_SEC` (default 5 с), при 5xx — 1 retry через 0.5 с.
- Fallback model: якщо задано `CLF_FALLBACK_MODEL_ID`, при помилці primary — один виклик fallback.
- Невалідний JSON відповідь: 1 повторний виклик тієї ж моделі, потім degraded.

## Schema validation

LLM output валідується zod-схемою (`classify/schema.ts`): intent, domain, entities[], ambiguity, routing_flags. Якщо не пройшло — retry або degraded.

## Merge policy (U2a–U2d + LLM)

- **entities:** union(pre_entities, llm_entities) з дедупом по type+value; rules extractor — мінімальний reliability layer.
- **ambiguity:** Rules "hard" (AMBIG_TERM_MATCH, TOO_SHORT_QUERY) перевизначають LLM — якщо rules дають `is_ambiguous=true` і strength hard або reason_codes містять hard-ознаки, фінальна ambiguity від rules незалежно від LLM; інакше soft → OR з LLM; інакше LLM. Детально: [decisions/ambiguity-rules-override.md](./decisions/ambiguity-rules-override.md). У meta: `ambiguity_source` (llm | rules_soft | rules_hard_override | merged), при override — warning `ambiguity_overridden_by_rules:<codes>`.
- **routing_flags:** LLM + overrides з InputNormalizer (input_is_large, need_clarification).

## U2-preprocessor (InputNormalizer)

Перед U2a/b/c/d: перевірка довжини (поріг ~12K), noise heuristic. Якщо довго — effective_query = head + tail + entities snippet; routing_flags.input_is_large, meta.input_truncated/original_length/effective_length. Якщо noise — need_clarification, ambiguity true.

## RunContext (dev implementation)

In-memory Map з TTL: `runContextGet(run_id)`, `runContextSet(run_id, payload, ttlSec)`, `runContextDel(run_id)`. Інтерфейс готовий для заміни на Redis.

## QueryProfile (JSON)

- `query_profile_version`: 1
- `intent`, `domain`, `entities`, `ambiguity`, `computed_flags`, `routing_flags?`
- `meta`: `classifier_mode`, `prompt_version`, `model_id`, `provider`, `latency_ms`, `retries`, `warnings`, `ambiguity_source` (llm | rules_soft | rules_hard_override | merged)
- `pipeline_step`: "U2d_done", `updated_at`

## Observability

Логи: U2 started, U2 rules path / U2 LLM path / U2 LLM failed degraded, U2 finished з run_id, duration_ms, classifier_mode. Метрики: u2_processed_total, u2_failed_total, u2_ambiguous_total, u2_intent_*, u2_domain_*.
