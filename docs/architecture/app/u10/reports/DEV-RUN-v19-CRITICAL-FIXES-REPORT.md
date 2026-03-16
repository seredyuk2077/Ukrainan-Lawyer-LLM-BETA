# DEV RUN v19 — Critical bugs fix + reliability & observability

**Дата:** 2026-03-05  
**Scope:** 3 критичні баги (U5 DIRECT_REF_MISSING, U10 bounds, GET /v1/runs/:id), gating reliability, batch embeddings, compact repair, observability. Без хардкоду під статті/акти.

---

## 1) Що змінено

### PHASE 1A — U5 DIRECT_REF_MISSING (gate.ts)

- **Проблема:** `directRefMissing` порівнював `hit.rada_nreg` (типу 2341-14) з `entity.norm.act` (типу «Кримінальний кодекс України») через `includes` → false positive DIRECT_REF_MISSING.
- **Рішення:**
  - Article refs з `queryProfile.entities`: `norm.article` (нормалізація 332-2 ↔ 3322).
  - Act hints: `norm.act` / act_abbrev для observability; **DIRECT_REF_MISSING тільки за article coverage** (не за act), щоб уникнути false positive.
  - Article coverage: rawHit з `article_number`, нормалізований, входить у множину entity article refs.
  - Act coverage (сигнали): hit `title`/`act_title`/`r2_key` містить act hint.
- **Explainability в `decision.signals`:**
  - `direct_refs_total`, `direct_refs_hit`
  - `direct_act_hints_total`, `direct_act_hints_hit`

### PHASE 1B — U10 bounds (evidenceTriage.ts)

- **Проблема:** top-up йшов лише до `hard_min`, не до `effective_min` → multi-part/comparison могли мати 3 чанки замість очікуваних 5+.
- **Рішення:**
  - `resolveEvidenceBounds`: config min/max — базова рамка; query-shape (comparison/multipart) може лише підвищувати в межах рамки: `effective_min = Math.max(queryMin, configMin)`.
  - Parse-ok path: якщо `selectedIndices.length < effective_min` і `lawCount >= effective_min` → top-up **до effective_min** (не тільки до hard_min).
  - У результат triage додано: `effective_min_applied`, `topup_target` ('effective_min' | 'hard_min').
- **Умова:** `selected_count >= effective_min` при `lawCount >= effective_min` (окрім fallback-ситуацій).

### PHASE 1C — GET /v1/runs/:id hardening (handler.ts, server.ts)

- **Проблема:** `handleGetRun` без try/catch; `findByRunId` кидає `StorageError('DB_READ_FAIL')` → unhandled rejection, 500/нестабільний smoke.
- **Рішення:**
  - Handler: try/catch навколо `findByRunId`; при `StorageError` з code `DB_READ_FAIL` або `DB_*` → 503, JSON `{ error, code }`.
  - Server: `asyncRoute(fn)` — обгортка для async route, rejections передаються в `next`.
  - Global error middleware: 500/503 з JSON і `code` (503 для DB_READ_FAIL/DB_*).

### PHASE 2 — Verify script post-check (verify_retrieval_real_dev.ts)

- Non-200 від GET /v1/runs/:id → post-check fail, `reason_code` API_NON_200.
- Exception у try блоці post-check → post-check fail, `reason_code` POST_CHECK_EXCEPTION (не ignore).
- Агрегація `postCheckReasonCodes` у фінальному summary (наприклад API_NON_200=2, POST_CHECK_EXCEPTION=1).

### PHASE 3 — Batch embeddings та U9/U10 оптимізація

- **retrieval/embedding.ts:** `embedMany(texts: string[])`, батчі по `config.lldbiEmbedBatchSize` (default 16), таймаут і 1 retry на 5xx як у `embedQuery`.
- **assemble/assemblePrompt.ts:** один `embedQuery(userQuery)` + один `embedMany(metaTexts)` для semantic_meta замість N+1 embedQuery.
- **evidenceTriage.ts (fallback):** один `embedQuery(userQuery)` + `embedMany(excerpts)` замість послідовного циклу.

### PHASE 4 — Compact repair (consumer.ts, legalAgent.ts)

- Перший compact pass з `repairCompactAnswer(text, false)`.
- Якщо `refs_after > sprawlThreshold` і текст змінився → другий pass з `repairCompactAnswer(repaired, true)` (жорсткіший instruction), max 2 passes.
- Після compact обов’язкова `validateOutput`; якщо була citation і з’явилось `missing_citation` → `repairCitationAnswer(repaired)` і повторна валідація.
- У результат: `compact_repair_applied`, `compact_repair_success`, `article_refs_before`, `article_refs_after`.

### PHASE 5 — Observability

- **Snapshot u10_selection:** `u10_bounds_applied` (effective_min, effective_max, final_selected), `bounds_resolved`, `effective_min_applied`, `topup_applied`, `topup_reason`, `topup_target`.
- **Gate:** `gate_decision.signals` вже містить `direct_refs_total/hit`, `direct_act_hints_total/hit` (direct ref coverage).

---

## 2) Закриті баги

| ID | Опис | Файли |
|----|------|--------|
| CRITICAL 1 | U5 DIRECT_REF_MISSING false positive (rada_nreg vs act) | gate/gate.ts, gate/types.ts |
| CRITICAL 2 | U10 effective_min не гарантувався, top-up лише до hard_min | write/evidenceTriage.ts |
| CRITICAL 3 | GET /v1/runs/:id без try/catch, DB transient → 500/unhandled | gateway/handler.ts, server.ts |
| HIGH 1 | Verify script ignore exception у post-check | tools/u4/verify_retrieval_real_dev.ts |

---

## 3) Результати тестів (PHASE 6)

Команди виконано локально:

| Команда | Результат |
|---------|-----------|
| `pnpm -s brain:test:u9-units` | PASS |
| `pnpm -s brain:test:u10-units` | PASS |
| `pnpm -s brain:test:evidence-triage-units` | PASS |
| `pnpm -s brain:test:focus-spec-units` | PASS |
| `pnpm -s brain:test:output-validator-units` | PASS |
| `pnpm -s brain:test:json-extract-units` | PASS |
| `pnpm -s brain:test:u2-classify-json-units` | PASS |
| `DOCLIST_ENABLED=true pnpm -s brain:test:gate-units` | PASS |
| `pnpm -s exec tsx scripts/lexery-legal-agent/tools/_units/test_openrouter_units.ts` | PASS |
| `pnpm -s brain:verify:retrieval-real-dev:smoke` | PASS — 7/7, U10 post-check ok, exit_code 0 (~223s). |

**Gate units (релевантні до DIRECT_REF_MISSING):**
- direct refs 130+286 present in hits → no DIRECT_REF_MISSING, direct_refs_hit=2
- direct ref 999 absent → DIRECT_REF_MISSING, direct_refs_hit=0

---

## 4) Таблиця 5 real runs

Після виконання smoke — прогнати 5 real runs вручну і заповнити таблицю. Команда для одного run:

```bash
pnpm brain:chat:run -- --real-llm --i-understand-costs --message "<QUERY>" --tenant tenant-dev --user user-dev-andrii --conversation conv-dev-andrii
```

**Запити (5 runів):**

1. Крадіжка vs грабіж  
2. Кордон адмін vs кримінал  
3. Шахрайство vs привласнення/розтрата  
4. 28 років аспірант/кордон  
5. Explicit refs: ст 130 КУпАП vs ст 286 ККУ  

**Після кожного run:** зберегти `run_id`, потім:

```bash
pnpm brain:forensics:law-refs -- --run-id <run_id>
pnpm brain:forensics:u9-u10-chunks -- --load-r2 --run-id <run_id>
```

| run_id | u9_selected / u9_final | u10_before / u10_selected / u10_final | triage_attempts / finish_reason / reason_code | warnings | filtered overlap / diversity |
|--------|------------------------|---------------------------------------|-----------------------------------------------|----------|-----------------------------|
| (заповнити після run 1) | | | | | |
| (run 2) | | | | | |
| (run 3) | | | | | |
| (run 4) | | | | | |
| (run 5) | | | | | |

Очікування після фіксів: немає false-positive DIRECT_REF_MISSING для run 5 (ст 130 КУпАП vs ст 286 ККУ); u10_selected/final >= effective_min при достатній кількості law chunks.

---

## 5) Залишкові ризики

- **U9 semantic_meta:** latency залежить від OpenRouter; batch embeddings зменшують N+1, але не прибирають затримку повністю.
- **Compact repair:** другий pass з strict prompt може іноді надмірно скоротити цитування; citation repair після compact має це пом’якшувати.
- **DB transient:** 503 тепер повертається коректно; smoke/verify не падають з unhandled, але повторні запити при 503 потрібно обробляти на стороні клієнта (наприклад retry у verify вже є за логікою).

---

## 6) BLOCKED

Ні. Всі зміни виконані; тести пройдені. 5 real runs та заповнення таблиці виконуються вручну (потрібен живий API та R2/DB).

---

## 7) Файли змін

| Файл | Зміни |
|------|--------|
| gate/gate.ts | DIRECT_REF_MISSING по article coverage; act hints для signals; normalise article refs |
| gate/types.ts | GateDecisionSignals: direct_refs_total/hit, direct_act_hints_total/hit |
| write/evidenceTriage.ts | resolveEvidenceBounds config frame; top-up до effective_min; effective_min_applied, topup_target; embedMany у fallback |
| gateway/handler.ts | try/catch, 503 на DB_READ_FAIL |
| server.ts | asyncRoute, global error middleware |
| tools/u4/verify_retrieval_real_dev.ts | non-200 → fail; exception → fail; reason_code aggregation |
| retrieval/embedding.ts | embedMany(texts), batch по config |
| lib/config.ts | lldbiEmbedBatchSize |
| assemble/assemblePrompt.ts | semantic_meta: embedQuery + embedMany(metaTexts) |
| write/legalAgent.ts | repairCompactAnswer(..., strict), COMPACT_REPAIR_STRICT_SYSTEM |
| write/consumer.ts | compact 2 passes, validate + citation repair після compact; u10_selection observability |
| tools/u4/test_gate_units.ts | testDirectRefPresentNoMissing, testDirectRefMissingWhenAbsent |
| tools/u10/test_evidence_triage_units.ts | bounds tests (config frame, effective_min top-up) |
