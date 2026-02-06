# U2: Політика ambiguity rules-override (ADR)

## Контекст

LLM може по-різному класифікувати короткі загальні запити (наприклад «мобілізація») щодо ambiguity. Для відтворюваності й коректності потрібна детермінована ambiguity, коли rules впевнені.

## Рішення

- **Rules ambiguity detector** (U2d) завжди виконується (паралельно або до/після LLM). Повертає `strength: "hard" | "soft"` та `reason_codes` (наприклад `AMBIG_TERM_MATCH`, `TOO_SHORT_QUERY`).
- **Merge policy:**
  - Якщо rules дають `is_ambiguous === true` і `strength === "hard"` (наприклад AMBIG_TERMS, too-short query) → **фінальна ambiguity = результат rules**; LLM перевизначається. У meta: `ambiguity_source: "rules_hard_override"`, warning `ambiguity_overridden_by_rules:<reason_codes>`.
  - Якщо rules дають ambiguous і `strength === "soft"` → final = **OR**(LLM, rules). `ambiguity_source: "merged"`.
  - Інакше → final = LLM. `ambiguity_source: "llm"`.
- **Audit:** `query_profile.meta.ambiguity_source` та опційно `meta.warnings` (override warning + reason_code) забезпечують відтворюваність у проді.

## Reason codes (hard vs soft)

- **Hard** (перевизначення LLM): `AMBIG_TERM_MATCH`, `TOO_SHORT_QUERY`
- **Soft** (merge/OR): `GENERAL_DOMAIN_NO_DIRECT_REF`, `NO_ENTITIES_GENERIC_TOPIC` тощо.

## Статус

Реалізовано: `classify/ambiguity-detector.ts` (strength, reason_codes), `classify/consumer.ts` (`mergeAmbiguity`, підключення в LLM path, meta.ambiguity_source, routing_flags.ambiguous від фінального результату).
