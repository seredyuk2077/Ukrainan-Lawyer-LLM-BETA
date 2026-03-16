# Lexery Legal Agent — реальний стан пайплайну (U1–U10) та контекст для вимог

Документ збирає поточний стан системи від U1 до U10 з акцентом на **U9 Assemble** та **U10 Legal Agent**: промпти, JSON-схеми, RAG-джерела, структура LLDBI, якість топ-100 результатів, сховища (Supabase, Cloudflare R2, Qdrant), env та результати останніх тестів. Призначення — підтримка написання вимог та впровадження покращень.

**Дата знімку:** 2026-02-28 (після DEV RUN v16: meta-triage U9, evidence_insufficient без gate.expand, min_selected top-up U10).

---

## 1. Огляд пайплайну U1–U10

| Крок | Назва | Вхід | Вихід | Сховища |
|------|--------|------|--------|---------|
| **U1** | Gateway | HTTP POST /v1/runs | Run створено, U2 enqueue | Supabase `runs` (create), RunContext (in-memory/Redis) |
| **U2** | Classify | RunContext, query | QueryProfile (intent, domain), U3 enqueue | RunContext.query_profile |
| **U3** | Plan | QueryProfile | SearchPlan (sources: lldbi, memory, doclist, web), U3a→U4 | RunContext.search_plan |
| **U3a** | Plan steps | SearchPlan | step_kinds (lldbi_chunks, lldbi_acts, doclist, import_fast) | — |
| **U4** | CacheRAG | RunContext, SearchPlan | rawHits (до 100), retrieval_trace | Qdrant (chunks/acts), R2 (fragments), Supabase (memory), runs.retrieval_trace |
| **U5** | Gate | U4Result, RunContext | GateDecision (expand, reason_codes) | RunContext.gate_decision |
| **U6** | Expand | (stub) | — | — |
| **U9** | Assemble | RunContext, U4Result, GateDecision | AssembledPrompt, law/memory/history contextParts | R2 (load snippets), runs.assembled_prompt, runs.snapshot.u9_meta_triage |
| **U10** | Legal Agent | AssembledPrompt, RunContext | LegalAgentResult (answerText, model, usage) | OpenRouter LLM, runs.llm_result, runs.snapshot.u10_selection |
| **U11** | Verify | llm_result | VerifyResult (verdict) | runs.verify_result |
| **U12** | Deliver | Run, llm_result | Message persisted, outbox | Supabase messages, outbox |

**Ключові точки для вимог:**
- U4 не змінюється за вимогою; всі покращення релевантності — через U9 (meta-triage, вибір хітів) та U10 (evidence triage, focus).
- RunContext — in-memory або Redis; критичні артефакти дубльовані в Supabase (`runs`) для durability та forensics.

---

## 2. U9 Assemble — промпти, схеми, логіка

### 2.1 Призначення

U9 збирає повний промпт для U10: **system** + **user** + **context** (law + docs + memory + history). Evidence-only: Writer бачить лише підтверджений контекст. Канали:
- **LAW:** топ-N canonical chunks з R2 за rawHits (після dedup, сортування за score, опційно після **metadata pre-triage**).
- **MEMORY:** memory_summaries + memory_items з RunContext (заповнені U4).
- **HISTORY:** останні K повідомлень діалогу.

### 2.2 Промпти U9

**Системний промпт (legacy, підставляється в assembled.systemPrompt; U10 замінює на PromptStack, якщо є):**
```text
You are a legal assistant. Answer only using the provided evidence (laws, memory, dialogue).
Do not invent sources. Cite the law article when available.
If there is no sufficient data in the context, say so clearly.
```
Джерело: `assemble/assemblePrompt.ts` — `SYSTEM_PROMPT_EVIDENCE_ONLY`.

**U9 Metadata Pre-Triage (DEV RUN v16)** — промпт для вибору індексів хітів з усіх 100 за метаданими (article_number, act title, score), без завантаження R2:
- **System:** «You are a legal article relevance selector. Given a user question and a numbered list of legal article metadata (article number, act title, relevance score), select the indices of articles most likely to contain the specific legal norms needed to answer the question. Pay special attention to: articles that cover both sides of a comparison question, articles with specific article numbers relevant to the topic, and lower-scored articles that are specifically about the topic (not just generally related). Select at most {maxSelect} indices. Output ONLY a JSON array of integers. Example: [0, 5, 12, 87]»
- **User:** «Question: {userQuery.slice(0,400)}\n\nArticles (index: article_number [act_title] score):\n{metaLines}»
- Вихід: один JSON-масив цілих (індекси). Парсинг: `raw.match(/\[[\s\S]*?\]/)` → JSON.parse; валідні індекси 0..length-1, обрізані до `u9MetaTriageMaxSelect`.
- Джерело: `assemble/metaTriage.ts`.

### 2.3 Логіка вибору law-хітів (після DEV RUN v16)

1. **Dedup + sort:** `dedupAndSortHits(rawHits)` по (r2_key, json_path), потім score desc, tie-break по ключу.
2. **Meta-triage (якщо увімкнено і hits > threshold):**
   - Умова: `u9MetaTriageEnabled` та `sortedHits.length > u9MetaTriageThreshold` (default 25).
   - Виклик `metaTriageHits(dedupedAll, user_input, run_id)` → `selectedIndices`.
   - Якщо triage не skipped і є вибрані індекси: об’єднання **top-10 за score** ∪ **meta_triage selectedIndices**, dedup, slice(0, maxLawSnippets) → ці хіти йдуть на R2.
   - Інакше: класичний **top-N по score** (N = u9MaxLawSnippets).
3. **R2 load:** для кожного обраного хіта — `loadCanonicalSnippet(ref, maxSnippetChars)` (concurrency 6), обрізка по `u9MaxTotalLawChars`, при помилці — маркер «Норма недоступна» та loadErrorsCount++.
4. **Provenance:** кожен law ContextPart має sourceRef (LawSourceRef); з тексту витягується normRef (extractNormRef) для focus/triage.

### 2.4 JSON-схеми та типи (U9)

**RawHit (retrieval/types.ts):**
- `r2_key`, `json_path`, `score`, `source?`, `rada_nreg?`, `article_number?`, `title?`, `goal_id?`, `metadata?`.

**LawSourceRef (contracts.ts):**
- `r2_key`, `json_path`, `score`, `rank`, `rada_nreg?`, `article_number?`, `act_title?`, `goal_id?`, `loaded`, `normRef?`.

**ContextPart:**
- `type: 'law' | 'memory' | 'history'`, `text`, `sourceIds: string[]`, `sourceRef?: SourceRef`.

**AssembledPrompt.meta:**
- `assembledAt`, `tokenEstimate`, `sourcesSummary`, `budget` (tokenEstimateByChannel, truncated, droppedChannels), `loadErrorsCount`, `degraded`, `sources` (lawCount, memoryCount, historyCount), `lawSourceRefs`, `lawIndex`, `u9MetaTriage?` (skipped, selected_count, total_hits, model?, latency_ms).

### 2.5 Конфіг U9 (env)

| Env | Default | Опис |
|-----|---------|------|
| `U9_MAX_LAW_SNIPPETS` | 20 | Макс. кількість law-сніпетів після dedup/selection |
| `U9_MAX_SNIPPET_CHARS` | 2000 | Макс. символів на один сніпет |
| `U9_MAX_TOTAL_LAW_CHARS` | 30000 | Бюджет: сумарні символи law |
| `U9_MAX_TOTAL_MEMORY_CHARS` | 6000 | Бюджет: memory |
| `U9_MAX_HISTORY_MESSAGES` | 10 | Макс. повідомлень історії |
| `U9_R2_CONCURRENCY` | 6 | Паралельні R2-запити |
| `U9_META_TRIAGE_ENABLED` | true (`!== 'false'`) | Увімкнути metadata pre-triage |
| `U9_META_TRIAGE_THRESHOLD` | 25 | Мін. кількість raw hits для meta-triage |
| `U9_META_TRIAGE_MAX_SELECT` | 20 | Макс. індексів від triage (merge з top-10) |

---

## 3. U10 Legal Agent — промпти, схеми, логіка

### 3.1 Призначення

U10 викликає configured OpenRouter model для генерації відповіді. Evidence-only: промпт зібраний у U9. Додатково: Prompt Stack (global/project/chat/user), evidence insufficient prefix, контекстні секції (LAW / USER DOCUMENTS / MEMORY / HISTORY), опційно Prompt Composer, **Evidence Triage** (Haiku по excerpts), **Focus Spec** (task type, primary norm, maxLawSnippets).

### 3.2 Промпти U10

**Глобальний safety (завжди перший):**
- `GLOBAL_SAFETY_PROMPT` = «You are Lexery Legal Agent — a professional Ukrainian legal assistant.» + RAG_AWARENESS + «You answer ONLY based on the evidence (laws, memory, dialogue history) in the context. Do not invent legal norms… Respond in the same language as the user query (default: Ukrainian). If evidence is insufficient, clearly state this.»
- `RAG_AWARENESS` = «You are operating inside Lexery Legal Agent. The context below was retrieved by the system from an internal legislation database (RAG). The user did not provide these documents. Do NOT say "надані матеріали", "матеріали користувача". Prefer: "витяги з норм законодавства з внутрішньої бази Lexery".»

**Evidence insufficient (префікс до system):**
- `EVIDENCE_INSUFFICIENT_PREFIX` = «⚠️ EVIDENCE INSUFFICIENT: The legal retrieval returned zero or degraded law snippets… Do NOT attempt to answer from general knowledge. Inform the user that insufficient legal norms were found…»

**Структура контексту в user message:**
- `=== LAW EVIDENCE ===` + текст law parts
- `=== MEMORY CONTEXT ===` + memory
- `=== CHAT HISTORY ===` + history

**Crime composition (шаблон у system при taskType crime_composition):**
- CRIME_COMPOSITION_TEMPLATE: норма (цитування), цитата, склад злочину (об’єкт, об’єктивна сторона, суб’єкт, суб’єктивна сторона), санкція.

**Evidence Triage (U10, Stage 1 — вибір сніпетів за excerpts):**
- System: «You are a legal evidence relevance selector. Given a user question and a numbered list of law snippet excerpts, select the ones needed to answer (admin vs criminal, specific articles, etc.). Output ONLY a JSON array of selected indices (0-based integers). Select at least 4 and at most 8 snippets so the answer can cite and compare norms. Example: [0, 2, 5, 7]»
- User: «User question: {query}\n\nLaw snippets:\n{idx}: [act_title] ст.article \"excerpt\"»
- Вихід: один JSON-масив індексів; потім **min_selected top-up**: якщо обрано менше ніж `evidenceTriageMinSelected` (6), добирання по score до мінімуму (cap 8).
- Джерело: `write/evidenceTriage.ts`.

**Focus Spec (детерміновано):**
- Task type: crime_composition / citation_only / general (за ключовими словами запиту).
- primaryNormSourceId: найкращий lawSourceRef за scoreSnippetForQuery (напр. ст.115, ст.185) або top-scored.
- maxLawSnippets: crime_composition 3; general при gateExpand 6; інакше 4.
- bannedPhrases: «надані матеріали», «наданих матеріалів», «надані в контексті матеріали», «матеріали користувача».
- citationStyle: ua_dstu_npa; tone: юридична українська.
- Джерело: `write/focusSpec.ts`.

### 3.3 Evidence insufficient policy (DEV RUN v16)

- **Умова:** `lawCount === 0` OR `(degraded === true AND loadErrorsCount > 0)`.
- **Не входить:** `gate.expand === true` більше не робить evidence insufficient; при expand лише додається warning `ambiguous_query` і форситься triage.
- Джерело: `write/legalAgent.ts` — `isEvidenceInsufficient()`.

### 3.4 JSON-схеми та типи (U10)

- **AssembledPrompt** — див. U9.
- **FocusSpec:** taskType, primaryNormSourceId, primaryNormConfidence, requiredSections, maxLawSnippets, citationStyle, bannedPhrases, tone.
- **TriageResult:** selected (ContextPart[]), triagedCount, droppedCount, skipped, model?, latencyMs.
- **LegalAgentResult:** answerText, model, latencyMs, finishReason?, usage?, warnings?, citations?, usedSources?.
- **PromptStack:** global?, project?, chat?, user?.

### 3.5 Конфіг U10 та triage

| Env | Default | Опис |
|-----|---------|------|
| `LEGAL_AGENT_MODEL_ID` | anthropic/claude-3.7-sonnet:thinking | Модель U10 |
| `LEGAL_AGENT_TIMEOUT_SEC` | 55 | Таймаут LLM |
| `LEGAL_AGENT_MAX_TOKENS` | 4096 | Макс. токенів відповіді |
| `EVIDENCE_TRIAGE_ENABLED` | true (`!== 'false'`) | Увімкнути evidence triage |
| `EVIDENCE_TRIAGE_THRESHOLD` | 8 | Мін. law-частин для triage |
| `EVIDENCE_TRIAGE_MODEL_ID` | anthropic/claude-3-5-haiku | Модель triage |
| `EVIDENCE_TRIAGE_EXCERPT_CHARS` | 200 | Символів excerpt на сніпет |
| `EVIDENCE_TRIAGE_MIN_SELECTED` | 6 | Мін. сніпетів після triage (top-up якщо менше) |
| `PROMPT_COMPOSER_*` | (skip threshold 2, complex 6) | Composer до U10 |

---

## 4. RAG-джерела та структура LLDBI

### 4.1 Джерела

- **Qdrant:** векторний пошук. Колекції: `lexery_legislation_chunks` (за замовчуванням), `lexery_legislation_acts`. Embedding: 1536d, `openai/text-embedding-3-small`. U4 повертає до `u4HitsCap` (100) raw hits з полями r2_key, json_path, score, article_number, title тощо.
- **Cloudflare R2 (LLDBI):** бакет законодавства (`r2BucketLegislation`, default `legislation`). Ключі — шлях до JSON (наприклад `legislation/administrative/80731-10.json`). Фрагмент — за `json_path` (наприклад `$.content.chunks[337].text`). U9 завантажує тільки обрані після dedup/meta-triage хіти.
- **Supabase (Lexery Legal Agent DB):** `runs` (query, retrieval_trace, assembled_prompt, llm_result, snapshot), `mm_memory_items` для memory (U4), tenants, messages тощо.
- **Supabase Legislation (опційно):** метадані для ActTaxonomyStore (U4).

### 4.2 Структура LLDBI та топ-100

- **RawHit** містить: r2_key (шлях до акту в R2), json_path (chunk у JSON), score (similarity), article_number, title (act title). Qdrant повертає hits відсортовані за score; U4 може застосовувати fusion, rerank, multi-query тощо, але фінальний список — до 100 пунктів.
- **Якість топ-100:** на реальному run (запит про водіння в нетверезому стані) ст.130 КУпАП та ст.286 ККУ потрапляли в топ-100, але на позиціях ~88–98 (score 0.629, 0.633). Топ-20 лише за score їх не включав — звідси **U9 metadata pre-triage**: LLM по метаданих обирає релевантні індекси з усіх 100, їх об’єднують з top-10 і завантажують з R2. Це покращило включення ст.130 у контекст і відповіді про адмін/кримінал (наприклад, згадка ст.130 КУпАП ч.2 у відповіді).
- **Forensics:** `pnpm brain:forensics:law-refs -- --run-id <uuid>` виводить lawSourceRefs з assembled_prompt, gate_decision, snapshot.u9_meta_triage, snapshot.u10_selection (law_source_ids_before/selected/final, triage_used, evidence_insufficient, reasons).

---

## 5. Сховища (Supabase, R2, Qdrant) та MCP

### 5.1 Supabase (user-supabase-lexery-legal-agent-db)

- **Таблиці:** `runs` (run_id, status, query, query_profile, search_plan, retrieval_trace, assembled_prompt, llm_result, verify_result, snapshot, created_at, updated_at, completed_at), tenants, messages, outbox тощо.
- **runs.retrieval_trace:** version, **hits** (масив RawHit-подібних об’єктів), top_score, latency_ms, degraded_sources, meta. У forensics використовується ключ `hits` (не rawHits).
- **runs.assembled_prompt:** compact meta (lawSourceRefs, sources, budget, loadErrorsCount, degraded); без повних текстів сніпетів.
- **runs.snapshot:** JSON; зберігаються u9_meta_triage, u10_selection (law_source_ids_before/selected/final, triage_used, evidence_insufficient, reasons), prompt_stack тощо.
- **MCP:** сервер `user-supabase-lexery-legal-agent-db` — execute_sql, list_tables, list_migrations тощо (для forensics і перевірок).

### 5.2 Cloudflare R2

- **Бакети:** legislation (LLDBI canonical JSON), опційно runs (attachments/overflow). Конфіг: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, r2BucketLegislation (або LLDBI_R2_BUCKET, R2_LEGISLATION_BUCKET). LLDBI_R2_PREFIX — опційний префікс для ключів.
- Завантаження фрагмента: getObject по r2_key, парсинг JSON, вибір за json_path (наприклад chunks[i].text).

### 5.3 Qdrant

- **ENV:** QDRANT_URL, QDRANT_API_KEY, QDRANT_TIMEOUT_SEC, LLDBI_COLLECTION_CHUNKS, LLDBI_COLLECTION_ACTS, LLDBI_TOP_K, MIN_SCORE_THRESHOLD. U4 використовує їх для пошуку та формування rawHits.

---

## 6. ENV змінні (узгоджені з U9/U10 та RAG)

- **Supabase:** SUPABASE_LEXERY_LEGAL_AGENT_DB_URL, SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY; опційно SUPABASE_LEGISLATION_URL / RAG, SERVICE_ROLE для taxonomy.
- **R2:** R2_ENDPOINT, R2_ACCESS_KEY_ID (або R2_ACCESS_KEY), R2_SECRET_ACCESS_KEY (або R2_SECRET_KEY), R2_LEGISLATION_BUCKET / LLDBI_R2_BUCKET, R2_RUNS_BUCKET, LLDBI_R2_PREFIX, R2_REGION.
- **Qdrant:** QDRANT_URL, QDRANT_API_KEY, LLDBI_COLLECTION_CHUNKS, LLDBI_COLLECTION_ACTS, LLDBI_TOP_K, MIN_SCORE_THRESHOLD; для memory — QDRANT_MEMORY_URL, QDRANT_MEMORY_API_KEY (опційно).
- **OpenRouter:** OPENROUTER_API_KEY_BRAIN або OPENROUTER_API_KEY_ONLINE (U2, U9 meta-triage, U10, triage, composer, embeddings).
- **U4 hits cap:** U4_HITS_CAP (default 100) — максимум raw hits у відповіді U4.

---

## 7. Останні тести та спостереження

### 7.1 Unit-тести U10

- `pnpm brain:test:u10-units`: 13 тестів (buildMessagesFromAssembled, buildPromptStack, isEvidenceInsufficient при law=0, gate.expand+law present → false, degraded+loadErrors, contextTruncated, composer skip threshold). Усі проходять; тест 7 явно перевіряє, що gate.expand при наявних law не дає evidenceInsufficient.

### 7.2 Реальні runs (термінали / логи)

- **Водіння в нетверезому стані (після DEV RUN v16):** U9 meta_triage: selected_count 2, final_for_r2 11; U10 triage min_selected top-up 5→6; відповідь вже містить ст.130 КУпАП (ч.2), ст.21 ККУ, ст.9 КУпАП; зауваження про відсутність точних порогів алкоголю в контексті залишаються коректними.
- **Незаконний перетин кордону:** meta_triage selected 4, final 12; U10 дав ст.332 ККУ з санкціями (ч.1–3).
- **Позовна давність:** meta_triage selected 5, final 12; відповідь за ЦКУ (види/типи, тривалість, обчислення).
- **«Конкретніше розпиши» (без контексту попереднього питання):** U2 intent=other, domain=general; U9 meta_triage повернув порожній масив → fallback top-N, 20 сніпетів; U10 відповів коректно — «Не вказано конкретної теми».

### 7.3 Відомі обмеження

- Meta-triage залежить від парсингу JSON з Haiku; при поверненні `[]` або невалідному масиві — fallback на top-N (логи: `u9_meta_triage: no valid indices parsed — falling back to top-N`).
- Evidence triage іноді залишає 2–5 сніпетів до top-up; min_selected (6) гарантує мінімум для writer при gateExpand.
- Ст.286-1 ККУ може не потрапляти в топ-100 векторного пошуку для частини формулювань — це обмеження U4 (індекс/запит), не U9/U10.

---

## 8. Висновки для вимог і покращень

- **U9:** Фіксація контракту вибору хітів (meta-triage + top-K merge), можливе розширення метаданих у prompt (наприклад heading), збереження u9_meta_triage у snapshot для аналізу.
- **U10:** Чіткі вимоги до мінімальної кількості сніпетів після triage, до формату відповіді (crime_composition, citation_only), до заборони фраз і до RAG-aware формулювань.
- **RAG:** Якість топ-100 залишається критичною; покращення embedding/запиту/індексу (U4) або додаткові механізми (наприклад, явний пошук за номером статті) можна описувати в окремих вимогах, не змінюючи контракт U4.
- **Observability:** runs.retrieval_trace.hits, runs.assembled_prompt.lawSourceRefs, runs.snapshot.u9_meta_triage та u10_selection дають достатньо даних для forensics і метрик якості відбору.

---

*Документ створено на основі коду в `scripts/lexery-legal-agent` (assemble/, write/, lib/, gateway/, retrieval/), конфігу `lib/config.ts`, контрактів `lib/pipeline/contracts.ts`, типів `retrieval/types.ts`, документації в `docs/architecture/app/` та логів/терміналів сесій brain:chat.*
