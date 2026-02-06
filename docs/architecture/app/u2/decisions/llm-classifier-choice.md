# ADR: LLM-based classifier choice & prompt templates (LEX-92 Spike)

## Context

U2a (Intent) і U2b (Domain) зараз rule-based. Можлива підстановка LLM для кращої точності.

## Decision

- **Feature flags:** `U2_INTENT_LLM_ENABLED`, `U2_DOMAIN_LLM_ENABLED` (default false). Якщо true — викликати LLM з промптом; інакше — поточний rule-based.
- **Модель:** не фіксувати в spike; при реалізації використовувати той самий пул, що й для інших кроків (OpenRouter), з окремим коротким промптом для intent/domain.
- **Prompt templates:** окремий файл або константи (наприклад `classify/prompts.ts`): system + user з плейсхолдером `{query}`; вихід — один токен або коротка фраза (question/drafting/…, criminal/civil/…). Парсинг відповіді — enum map.
- **Fallback:** при таймауті/помилці LLM — використовувати rule-based результат і встановити `profile_generation: "degraded"`.

## Status

Spike closed. Decision: env flags готові; реалізація LLM — окрема задача, коли буде потреба.
