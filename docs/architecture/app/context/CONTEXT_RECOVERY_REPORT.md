# Lexery Legal Agent — Context Recovery Report
**Дата оновлення:** 2026-03-03
**Джерело:** поточний код репозиторію + CLI прогони + Supabase forensics

---

> Для поточного канонічного стану пайплайну, реального verification snapshot і architectural drift див. `docs/architecture/app/context/CURRENT_PIPELINE_STATE.md`. Цей документ лишається коротким recovery summary раннього етапу.

---

## 1) Що це за сервіс (факт по коду)
Lexery Legal Agent — TypeScript мікросервіс у `scripts/lexery-legal-agent/`, який виконує пайплайн:

`U1 Gateway -> U2 Classify -> U3 Plan -> U4 CacheRAG -> U5 Gate -> U6 (stub) -> U9 Assemble -> U10 Write -> U11 Verify (stub) -> U12 Deliver`

Ключові каталоги:
- `classify/` — U2
- `plan/` — U3
- `retrieval/` — U4
- `assemble/` — U9
- `write/` — U10/U11/U12
- `gateway/` — оркестрація, queue, storage

---

## 2) Актуальний runtime (не історія)
Взято з `scripts/lexery-legal-agent/lib/config.ts` + ефективної конфігурації (`tmp/print_effective_config.ts`):

- `LEGAL_AGENT_MODEL_ID`: `openai/gpt-5.2`
- Реально повернутий model id у продзапусках: `openai/gpt-5.2-20251211`
- `U4_HITS_CAP`: `100`
- `LLDBI_TOP_K`: `50`
- `U9_MAX_LAW_SNIPPETS`: `20`
- `U9_BUDGET_PROFILE`: `default`
- `U9_META_TRIAGE_ENABLED`: `true`
- `U9_META_TRIAGE_THRESHOLD`: `25`
- `U9_META_TRIAGE_MODEL_ID`: `openai/gpt-5-nano`
- `EVIDENCE_TRIAGE_ENABLED`: `true`
- `EVIDENCE_TRIAGE_THRESHOLD`: `8`
- `EVIDENCE_TRIAGE_MODEL_ID`: `openai/gpt-5-nano`
- `EVIDENCE_TRIAGE_MIN_SELECTED`: `6`
- `U4_ACT_PLANNER_ENABLED`: `false`
- `U4_ROUTING_HINTS_ENABLED`: `false`

---

## 3) Як реально ріжеться контекст до GPT-5.2

### U9 (`assemble/assemblePrompt.ts`)
1. Береться `u4.rawHits`.
2. `dedupAndSort` по `(r2_key, json_path)` + sort за `score`.
3. Meta-triage (`assemble/metaTriage.ts`) на всіх deduped hits.
4. Якщо triage валідний: `top-10 ∪ selectedIndices`, потім `slice(0, U9_MAX_LAW_SNIPPETS=20)`.
5. Якщо triage невалидний/падає: fallback top-N (по score) з deduped масиву.
6. Завантаження текстів з R2 лише для вибраних hits.

### U10 (`write/consumer.ts`, `write/focusSpec.ts`)
1. Evidence triage (опціонально) може відфільтрувати law snippets.
2. Потім **обов’язковий FocusSpec cap**:
- `crime_composition -> maxLawSnippets=3`
- `general + gate.expand=true -> 6`
- `general + gate.expand=false -> 4`
3. `enforceFocusOnContextParts(...)` фінально обрізає law-контекст перед LLM.

Висновок: навіть якщо релевантна норма дійшла в U9, вона ще може бути зрізана в U10.

---

## 4) Що зберігається в `runs` (важливо для forensics)

`runs.assembled_prompt` з U9 зберігається у **compact** форматі (`assemble/consumer.ts`), не весь AssembledPrompt:
- `assembledAt`
- `sourcesSummary`
- `tokenEstimateTotal`
- `tokenEstimateByChannel`
- `truncated`
- `droppedChannels`
- `loadErrorsCount`
- `degraded`
- `sources`
- `lawSourceRefs`

Тобто поле `assembled_prompt.meta.budget` у БД не є canonical; для U10 фактичної подачі дивитись:
- `runs.snapshot.u10_selection`
- `runs.snapshot.u10_prompt_debug`

---

## 5) Результати CLI перевірок (2026-03-03)

Прогнано:
- `pnpm brain:test:u9-units` -> PASS
- `pnpm brain:test:u10-units` -> PASS
- `pnpm brain:verify:u5` -> PASS (A/B/C)
- `pnpm brain:db:capabilities` -> PASS
- `pnpm brain:r2:capabilities` -> PASS

Важливий сигнал з логів під час перевірок:
- `u9_meta_triage: failed (non-fatal) ... OpenRouter response missing content`
- `evidence_triage: failed (non-fatal) ... OpenRouter response missing content`

---

## 6) Два реальні CLI запити (GPT-5.2) і що сталося

### Run A
- `run_id`: `26e5fe50-6556-4182-95b3-677a12dbbc9a`
- Запит: порівняння адмін/кримінальної відповідальності за керування в стані сп’яніння
- U2: `degraded` (`Invalid JSON from LLM after retry`)
- U4: `hits=30`
- U9: `law_refs=20`, meta-triage non-fatal fail -> fallback
- U10: `law_before=20 -> law_after=6` (FocusSpec)
- Модель: `openai/gpt-5.2-20251211`

Трасування по статтях:
- ст.286: `raw=19`, `dedup=20`, `u9=20`, **`u10_final=false`**
- Причина: норма була в U9, але зрізана Focus cap в U10.

### Run B
- `run_id`: `60445b77-71fe-42e1-aca1-c7e8dd519107`
- Запит: склад злочину за незаконне переправлення через кордон
- U2: `degraded` (`Invalid JSON from LLM after retry`)
- U4: `hits=100`
- U9: `law_refs=20`, meta-triage non-fatal fail -> fallback
- U10: `task_type=crime_composition`, `law_before=20 -> law_after=3`
- Модель: `openai/gpt-5.2-20251211`

Трасування по статтях:
- ст.332: `raw=10`, але `dedup=29`, `u9=null`, `u10_final=false`
- ст.332-2: `raw=51`, `dedup=61`, `u9=null`, `u10_final=false`
- Причина: після dedup+sort релевантна ст.332 вийшла за межі top-20 U9 fallback і не дійшла до U10.

---

## 7) Коренева проблема “top-100 є, але GPT-5.2 не бачить правильні chunks”

Проблема не одна, а комбінація трьох вузьких місць:

1. **Нестабільність triage LLM-викликів (U9/U10)**
- Часті non-fatal fail: `OpenRouter response missing content`.
- У fallback U9 бере top-20 по score після dedup, що викидає частину релевантних норм.

2. **U9 bottleneck `maxLawSnippets=20` після dedup/sort**
- Якщо релевантна стаття опускається нижче 20 (навіть якщо була в raw top-100), вона не завантажується з R2.
- Кейс B: ст.332 була `raw rank=10`, але `dedup rank=29` -> відсіклась у U9.

3. **U10 FocusSpec додатково обрізає law-контекст (3/4/6)**
- Навіть якщо стаття дійшла в U9, вона може не потрапити у фінальний evidence пакет GPT-5.2.
- Кейс A: ст.286 дійшла до U9, але зникла після `law_after=6`.

Додатково:
- **U2 JSON-brittleness**: класифікатор часто падає в degraded (`Invalid JSON after retry`), що погіршує routing і якість retrieval.
- У retrieval видно шумні акти (напр. `2790-12`) з високими score, які зміщують релевантні кримінальні норми нижче.

---

## 8) Що в документі вважати неактуальним
Видалено/замінено:
- Твердження про дефолтний U10 на Claude 3.7 як актуальний runtime.
- Твердження, що в `runs.assembled_prompt` лежить повний `meta.budget` U9.
- Історичні DEV RUN наративи як основа “current state”.

Current state у цьому документі — тільки підтверджене кодом і реальними прогонами від 2026-03-03.

---

## 9) Короткий action plan
1. Підвищити надійність U9/U10 triage викликів (парсинг/формат відповіді, graceful extraction при non-string `content`).
2. Переглянути U9 селекцію: `20` занадто агресивно для багатозначних кримінальних запитів.
3. Послабити U10 Focus cap або робити “must-keep” для цільових статей, якщо вони вже відібрані U9.
4. Зменшити U2 degraded-rate (більш толерантний JSON extractor + fallback schema recovery).
