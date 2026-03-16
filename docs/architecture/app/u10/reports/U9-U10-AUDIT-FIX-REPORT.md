# U9/U10 Audit Fix Report (Post-Stabilization)

**Date:** 2026-03-03  
**Scope:** Phase A (bugfix) — E (tests, real runs). TZ: виправити дефекти після попереднього патчу, підвищити якість law-context, зберегти стабільність та observability.

---

## 1) Файли і що змінено

### Phase A — Bugfix
- **write/evidenceTriage.ts**
  - **A1:** Токенізація замінена з `split(/\W+/)` на Unicode-safe: `replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(t=>t.length>0)`. Працює для кирилиці (крадіжка, статті тощо).
  - `queryAwareExcerpt` та top-up overlap тепер коректно рахують overlap для UA-запитів.
- **lib/openrouter.ts**
  - **A2:** У body додано окреме поле `max_completion_tokens`, коли воно задане в options. Збережено `max_tokens` для сумісності. Для reasoning-моделей тепер передаються обидва поля (політика в коментарі в коді).

### Phase B — U9 Quality
- **assemble/assemblePrompt.ts**
  - **B1:** Додано Unicode `tokenizeForLexical(s)` і лексичний сигнал: `lexicalSignal(i)` — overlap query vs (title + article_number + r2_key tail), нормалізований до 0..1.
  - Combined score: `0.25*scorePrior + 0.25*modelSignal + 0.15*queryNumSignal + 0.25*lexical`.
  - **B2:** Fill кандидатів при `candidateIndices.size < maxLawSnippets` тепер за комбінованим скором (включно з lexical), а не за голим rank.

### Phase C — Observability
- **assemble/metaTriage.ts**
  - Додано `triage_attempt_trail`: масив `{ attempt_no, model_id, finish_reason, raw_content_type, reasoning_tokens, token_budget, outcome }`. Запис при кожній спробі (ok/retry/fallback/parse_fail/error).
  - Поля `triage_model_chain` та `triage_attempts` залишено.
- **write/evidenceTriage.ts**
  - Аналогічно: `triage_attempt_trail` у TriageResult, заповнення на кожній спробі.
- **lib/pipeline/contracts.ts**
  - У `u9MetaTriage` додано опціональне поле `triage_attempt_trail`.
- **assemble/assemblePrompt.ts**
  - У meta.u9MetaTriage проброс `triage_attempt_trail`.
- **write/consumer.ts**
  - У snapshot `u10_selection` додано `triage_attempts` та `triage_attempt_trail`.

### Phase D — Forensics
- **tools/forensics/u9_u10_chunk_diagnostic.ts**
  - **D1:** Unicode tokenize; `rawTokenOverlap` (token-based, не substring); `filteredOverlap` — без stopwords (UA/EN), Jaccard.
  - Вивід: raw_overlap, filtered_overlap, jaccard на кожен snippet; у підсумку — % з non-zero raw overlap, % з non-zero filtered overlap, avg Jaccard (filtered).

### Phase E — Tests
- **tools/u10/test_evidence_triage_units.ts**
  - Додано тест `testQueryAwareExcerptCyrillicMiddle`: запит «крадіжка грабіж», текст з цими словами в середині; на старому `\W+` токени порожні, тест падає; на новому Unicode — проходить.

---

## 2) Які баги закрито

| Проблема | Рішення |
|----------|---------|
| **Critical: queryAwareExcerpt/overlap зламані для UA** | Unicode tokenization у evidenceTriage; unit-тест на кирилицю (Cyrillic middle). |
| **High: max_completion_tokens не передавався окремо** | У openrouter body додано `max_completion_tokens` при наявності в options. |
| **High: U9/U10 часто потребують 2-ї спроби (nano length)** | Політика не змінена (retry з більшим budget), але тепер у snapshot повний attempt trail — видно всі спроби. |
| **Medium: U9 multi-signal без lexical** | Додано lexical signal (query vs title/article/r2_key), нормалізація, fill за combined score. |
| **Medium: triage_model_chain неповний** | Додано `triage_attempt_trail` з повним ланцюжком спроб (attempt_no, model_id, finish_reason, outcome тощо). |
| **Low: forensic overlap завищений** | Додано filtered overlap (stopwords + Jaccard), вивід і raw, і filtered. |

---

## 3) Тести

- `pnpm brain:test:u9-units` — **PASS**
- `pnpm brain:test:u10-units` — **PASS**
- `pnpm brain:test:focus-spec-units` — **PASS**
- `pnpm brain:test:evidence-triage-units` — **PASS** (включно з `queryAwareExcerpt: Cyrillic middle (Unicode tokenize)`)
- `tsx scripts/lexery-legal-agent/tools/_units/test_openrouter_units.ts` — **PASS**

---

## 4) Три (чотири) run forensic summary

| # | Query | run_id | U9 EMPTY? | U9 attempts / final model | U10 triage EMPTY? | U10 attempts / final model | U9 sources_count | Шум контексту (коротко) |
|---|-------|--------|-----------|----------------------------|-------------------|----------------------------|------------------|-------------------------|
| 1 | Крадіжка vs грабіж, процитуй ККУ | b934cc72-9262-4f5f-b32f-0c59954b4a24 | Ні (attempt 1 stop) | 1 / gpt-5-nano | Так → retry 2 ok | 2 / gpt-5-nano | 4 | Низький: ст.185/186 у відповіді. |
| 2 | Незаконний перетин кордону | 0a9d0e1a-e583-4902-a9a0-db5326f2b5a8 | Ні (attempt 1 stop) | 1 / gpt-5-nano | Так → retry 2 ok | 2 / gpt-5-nano | 4 | Помірний: релевантні ст.332²/332. |
| 3 | Шахрайство vs привласнення ввіреного майна | 2eec7309-c1ab-4df7-88d6-f08ceb3ce21c | Так → retry 2 length → gap-free | 2 / gap-free | Так → retry 2 fail → fallback | 3 / gpt-4o-mini | 5 | Помірний: ст.190 + пленум; fallback дав 6 обраних. |
| 4 | Правила перетину кордону і мобілізація… | 2b648892-161d-481c-94cd-0a8fb04545d5 | Так → retry 2 ok | 2 / gpt-5-nano | Ні (attempt 1 stop) | 1 / gpt-5-nano | 3 | Помірний: 12 law snippets, 8 після triage, 6 після focus. |

- Жодного silent fail: у всіх run-ах або успіх на 1–2 (або 3) спробі, або явний gap-free/fallback з записом у логах і в snapshot (`triage_attempt_trail`).
- Unicode excerpt: підтверджено unit-тестом (Cyrillic middle); у run-ах query-aware excerpt використовується для prompt evidence triage.
- Повний attempt trail: у snapshot зберігаються `u9_meta_triage.triage_attempt_trail` та `u10_selection.triage_attempt_trail` (де triage виконувався).

---

## 5) Залишкові ризики

- **gpt-5-nano** продовжує часто давати EMPTY_OUTPUT_LENGTH або обрізаний JSON (finish_reason=length) на першій спробі; retry з 800 tokens або fallback (gpt-4o-mini) це покривають, але додають latency.
- **Run 3:** U9 дав обрізаний JSON на спробі 2 → використано gap-free deterministic fallback (20 індексів); U10 потребував fallback на gpt-4o-mini. Це прийнятна поведінка, але показує, що nano для triage залишається нестабільним за length.
- Рекомендація з ТЗ (canary: gpt-4o-mini primary, nano shadow) не реалізована — залишається на потім.

---

## Команди для відтворення

```bash
# Unit tests
pnpm brain:test:u9-units
pnpm brain:test:u10-units
pnpm brain:test:focus-spec-units
pnpm brain:test:evidence-triage-units
pnpm exec tsx scripts/lexery-legal-agent/tools/_units/test_openrouter_units.ts

# Real runs
pnpm brain:chat:run -- --message "яка різниця між крадіжкою та грабіжем? процитуй ККУ" --real-llm --i-understand-costs
pnpm brain:chat:run -- --message "Незаконний перетин кордону під час воєнного стану" --real-llm --i-understand-costs
pnpm brain:chat:run -- --message "Шахрайство vs привласнення ввіреного майна, процитуй ККУ" --real-llm --i-understand-costs
pnpm brain:chat:run -- --message "правила перетину кордону і мобілізація: кому можна виїзджати, кому не можна, які підстави для звільнення від призову за мобілізацією" --real-llm --i-understand-costs

# Forensics (після run)
pnpm brain:forensics:u9-u10-chunks -- --run-id <run_id> --load-r2
```

**Acceptance:** (1) Жодного silent fail — виконано. (2) Unicode-aware excerpt працює — unit + run. (3) У логах/snapshot повний attempt trail — виконано. (4) Якість U9 selection покращена за рахунок lexical signal та fill за combined score — виконано; оцінка шуму в таблиці вище.
