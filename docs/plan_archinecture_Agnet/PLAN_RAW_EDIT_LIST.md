# Що дописати, допрацювати та додати в сирий документ архітектури (plan.md)

**Призначення:** чекліст для сирого документу. Виконувати по пунктах; потім збирати все в один структуризований архітектурний документ. Без прив’язки до тасків — тільки конкретний вміст.

---

## 1. ОГЛЯД І КОНЦЕПТ (початок документу)

### 1.1 Додати в документ

- **Єдине місце для «4C» (Concept):** один короткий підрозділ «Цільові принципи (4C)» з явним переліком: evidence-first, web as scaffolding (не як доказ), контрольована пам’ять, бюджет/ліміти. Зараз це розкидано по тексту.
- **User intents (типи задач):** один список з назвами: quick Q&A, standard консультація, deep research, draft документ, doc review/compliance, enforcement path. Згадати, що роутинг і пайплайн залежать від типу.
- **Non-goals для beta:** окремий підрозділ «Що не входить у beta»: глобальна колективна пам’ять (за замовчуванням), повний Cursor-level long-horizon memory, Case Law RAG (плагін — пізніше), APIM у перший тиждень, повний Document Parser (тільки вказівники на файли).
- **Мова та юрисдикція:** одна явна фраза: основна мова — українська (uk), опційно англійська (en); юрисдикція за замовчуванням — UA. Де це фіксується: у концепті та в контракті Gateway (chat settings).
- **Джерела істини та firewall:** один підрозділ «Джерела істини»: фінальна відповідь базується лише на canonical (R2/LLDBI), судова практика (пізніше), прикріплені документи з provenance; веб — лише для discovery/сигналів, ніколи не в контекст Writer.

### 1.2 Допрацювати / уточнити

- **LLM Orchestrator:** розділити ролі: окремо **Reasoner** (вхід: EvidencePack, вихід: структуроване правове міркування, без веб-контенту) і **Writer** (вхід: вихід Reasoner + контекст, вихід: текст відповіді українською). Зараз «Orchestrator» змішує обробку запиту, збір контексту, генерацію і пост-обробку — додати явне місце Reasoner між Retrieval і Writer.
- **Evidence builder:** уточнити, що це частина Retrieval Engine (збір EvidencePack), а не окремий модуль між Retrieval і Reasoner.

---

## 2. GATEWAY І API

### 2.1 Додати в документ

- **Повний контракт запиту (одна таблиця або список):** звести в один блок усі поля, які Gateway отримує: Auth (Authorization, X-Request-Id, Idempotency-Key), User routing (user_id, tenant_id, workspace_id, chat_id, project_id), Limits (plan_tier, monthly_budget_usd_remaining, hard_limits: max_cost_per_run_usd, max_runs_per_day, web_allowed, deep_allowed, max_imports_per_day), policy_flags (citations_required, privacy_mode, store_memory), Chat settings (language, verbosity, answer_style, jurisdiction), User input (message, attachments[] з полями file_id, mime_type, size_bytes, sha256, download_url, ingestion_hint), client_context. Щоб не дублювати — посилатися на розділ «2.2 Вхідні дані», але додати підсумкову таблицю «Request schema (повний перелік полів)».
- **RunRecord (структура і зберігання):** окремий підрозділ «RunRecord» з полями: run_id, user_id, chat_id, project_id, created_at, mode (standard/saver/deep), limits_snapshot (копія лімітів на момент запуску), status (queued/running/completed/failed), trace_pointer. Написати явно: у beta RunRecord зберігається в Supabase; пізніше можна Azure storage/Cosmos.
- **Правило inline vs queue:** в розділі про передачу далі (після створення Run) додати: «Правило маршрутизації: якщо очікувана тривалість > X секунд АБО є attachments — запит йде в чергу (наприклад, Azure Service Bus `brain-runs`); інакше — виклик Orchestrator inline.» Вказати конкретний поріг X (наприклад 30 с) або «TBD».
- **Відповідь Gateway (повний перелік):** окремо перелічити всі поля відповіді «fast ack»: run_id, status (queued | running), stream_url, estimated_mode (standard | saver | deep), budget_reserved_usd (опційно). І що саме повертається в кінці run: answer, citations, trace summary, token_cost, actions_taken (згадати в контракті «відповідь по завершенні»).

### 2.2 Допрацювати

- **Стрімінг подій:** в розділі про стрімінг додати повний перелік типів подій/полів, які йдуть клієнту: state (назва стану: classify, cache_retrieve, doclist_resolve, import, write, verify тощо), progress (% або «step i/n»), cost_so_far_usd, citations_count, need_user_clarification (true/false + текст). Уточнити: які внутрішні деталі показуємо, які приховуємо (правило «вау, але чесно»).
- **Idempotency:** залишити як є, але в одному реченні явно: «Повторний запит з тим самим Idempotency-Key повертає той самий run_id і поточний status, без створення другого run.»

---

## 3. MEMORY MANAGER

### 3.1 Додати в документ

- **Повна логічна схема даних (Supabase):** один розділ «Схема даних Memory (Supabase)» з переліком таблиць і ключових полів (без обов’язкового SQL): mm_users (user_id, created_at, status, default_language, privacy_mode), mm_user_profile (user_id, specialization, experience_level, response_prefs, auto_detected_signals), mm_cases (case_id, user_id, title, type, status, case_digest_current, case_digest_struct, last_activity_at), mm_conversations (conversation_id, user_id, case_id, title, last_message_at, message_count, rolling_summary_current, rolling_summary_struct), mm_messages (message_id, conversation_id, role, content_inline, content_r2_key, content_excerpt, token_count_est, created_at, metadata_json), mm_summaries (summary_id, conversation_id, range_*, summary_text, summary_struct, embedding_ref, created_at), mm_memory_items (item_id, user_id, scope_type, scope_id, item_type, content_text, content_struct, status, confidence, sensitivity, provenance, embedding_ref, supersedes_item_id), mm_run_context_snapshots (run_id, conversation_id, assembled_context_manifest, token_budget_plan, created_at). Коротко: що в SQL, що в R2, що в Qdrant.
- **R2 (Memory):** перелік ключів/шляхів: mm/messages/{conversation_id}/{message_id}.txt, mm/attachments/{user_id}/{file_id}, mm/archives/{user_id}/{export_id}.jsonl.
- **Qdrant (Memory):** одна колекція (наприклад lexery_memory_semantic_v1), розмірність 1536; payload-фільтри: user_id, scope_type, scope_id, object_type (message|summary|memory_item|attachment_note), object_id, status, timestamps, sensitivity. Правило: не робити окрему колекцію на користувача.
- **ContextPack — структура і токенові квоти:** підрозділ «ContextPack (формат контексту для Orchestrator)» з блоками і верхніми межами токенів: profile_block (≤ 300–600), case_block (≤ 600–1200), conversation_summary_block (≤ 600–1200), memory_items_block (≤ 600–1200), recent_messages_block (≤ 1500–3000), retrieved_history_block (≤ 600–1200). Написати: «Кожен блок має квоту; це запобігає переповненню контексту.»
- **CaseDigest і rolling summary — структуровані поля:** для case_digest_struct вказати приклад полів: parties[], key_dates[], issues[], acts[], open_questions. Для rolling_summary_struct: facts, open_questions, decisions, acts (або аналогічний набір). Коротко опис кожного поля.
- **Типи memory items і flow:** перелік item_type: preference, fact, constraint, glossary, note. Перелік status: proposed, confirmed, rejected, expired. Опис flow: «Кандидати створюються зі статусом proposed; користувач підтверджує або відхиляє (1-клік в UI). confirmed використовуються в контексті; secret ніколи не виходять за scope.»
- **Memory Manager API (сигнатури):** підрозділ «Інтерфейс Memory Manager». Read: get_context(user_id, conversation_id, case_id, query, limits_snapshot) → ContextPack + Manifest; get_case_digest(case_id) → CaseDigest; list_memory_items(user_id, scope). Write: append_message(conversation_id, role, content, run_id, metadata, blob_pointer?); confirm_memory_item(item_id) / reject_memory_item(item_id); update_profile(user_id, prefs_patch). Background: run_summarization(conversation_id, range); run_case_digest_update(case_id); run_memory_extraction(conversation_id, range); run_semantic_index(object_refs); retention_cleanup().
- **Memory failure modes:** підрозділ «Відмови Memory і fallback»: (1) Qdrant недоступний — Context Assembler працює без semantic recall (rolling summary + last N messages + confirmed items з SQL). (2) R2 недоступний — великі тексти тимчасово inline (обрізано) або pending upload; в UI можливе попередження «архів тимчасово недоступний». (3) Summarizer падає — більше recent messages, summarization пізніше; не блокувати відповідь. (4) Idempotency/конкурентність — client_message_id/run_id unique; outbox pattern для подій summarization/extraction (таблиця mm_outbox, воркер з lock). (5) Приватність — нічого в global memory за замовчуванням; proposed facts тільки після confirm; secret items тільки в своєму scope.

### 3.2 Допрацювати

- **Таксономія пам’яті (рівні):** залишити Session/Conversation, Case/Project, User, Team/Global (opt-in); явно сказати, що Team/Global у beta — лише шаблони/плейбуки без персональних фактів.
- **WOW для beta:** залишити список MUST WOW (Case isolation + CaseDigest, Resume after days, Preferences memory, 1-клік memory proposals); додати одну фразу про те, що Semantic recall через Qdrant — nice-to-have / фіче-флаг.

---

## 4. RETRIEVAL ENGINE

### 4.1 Додати в документ

- **EvidencePack (канонічний формат):** один підрозділ «Формат EvidencePack» з полями: answerability (score, missing_aspects[], ambiguity_flags[]), act_candidates (список актів з LLDBI/DocListDB і поясненням «чому»), evidence_items[] з полями: source_type (legislation | case_law | user_doc), source_id (наприклад rada_nreg + content_hash), title, jurisdiction, validity_status, act_date, document_type, extracts[] (text, article_number, chunk_id/json_path, relevance_score, citation_stub). Жорстка гарантія: кожен extract має provenance (r2_key + json_path або еквівалент). recommended_next_steps (для Planner/Reasoner). Окремо: **RetrievalTrace** — покроковий лог (індекси, запити, моделі, пороги, час/токени/вартість).
- **ClaimGraph (опційно):** якщо залишається в архітектурі — коротко: claim → evidence_ids → confidence → required_clarifications; зв’язок з EvidencePack (claims можуть посилатися на evidence_items).
- **Query Understanding layer:** підрозділ «Query Understanding» з модулями: IntentClassifier (Q&A / procedure / drafting / doc-review / research / enforcement), LegalDomainTagger (галузь права), Entity & Citation Extractor (ст. 115, ККУ, ЗУ, органи, ролі), Ambiguity Detector (неоднозначності). Вихід: QueryProfile (структура) + RoutingFlags.
- **Legal Navigator і SearchPlan:** підрозділ «Legal Navigator (pre-RAG)»: Synonymizer/Query Expander, Hypothesis Builder (3–7 гіпотез «які акти регулюють»), Plan Builder — план пошуку: (1) cache LLDBI acts/chunks, (2) якщо не вистачає — DocListDB, (3) якщо й там слабко — web-assisted discovery, (4) імпорт кандидатів в LLDBI, повтор chunk-search. Вихід: SearchPlan з пріоритетами.
- **Три рівні Candidate Discovery (A/B/C):** явно назвати: **Рівень A** — прямі посилання (рада_nreg, «ККУ ст.115» тощо); **Рівень B** — LLDBI act-index (embedding 1536d → lexery_legislation_acts); **Рівень C** — DocListDB resolver (768d), після синонімізації/нормалізації. Порядок: спочатку A, потім B, при низькій впевненості C.
- **Act Acquisition (ActIngestionOrchestrator):** підрозділ «Отримання актів (імпорт у LLDBI)»: перевірка legislation_documents (чи акт є, чи проіндексований); якщо нема — постановка в чергу імпорту. Політика: **fast mode** — 1–3 акти (найкращі), решта відкласти; **deep mode** — 5–15 актів партіями. Умови вибору режиму — за latency/budget з constraints.
- **Rerank, CoverageCritic, QueryRefiner, StopPolicy:** підрозділ «Якість і ітерації»: (1) CrossEncoder/LLM Reranker — переранжування extracts, відкидання «сміття». (2) CoverageCritic — перевірка покриття аспектів запиту (підстава/норма, процедура/строки/орган, наслідки). (3) QueryRefiner — якщо coverage низький, пропозиція переформулювання запиту. (4) StopPolicy — max ітерацій, max час, бюджет. Якщо після N ітерацій coverage низький — web-assisted або уточнююче питання користувачу.
- **Retrieval Confidence Model:** підрозділ «Скоринг і політика»: метрики relevance_top1, coverage_score, source_diversity, act_confidence, freshness/validity. Політика: якщо coverage_score < threshold — ще одна ітерація (QueryRefiner → знову пошук); якщо 2 ітерації не допомогли — web-assisted або «уточніть X» користувачу.
- **WebHints (контракт веб-модуля):** підрозділ «Вихід Web-assisted discovery»: Writer **ніколи** не отримує сирий веб-контент. Web повертає лише структуровані **WebHints**: candidate_act_titles[], keywords[], possible_document_types[], procedure_clues[] (без «як істина»). Ці дані йдуть у QueryRefiner / DocListDB / Ingestion, не в Writer.
- **Кешування retrieval:** підрозділ «Кешування»: (1) Act resolution cache — ключ hash(normalized_query + domain_tag + user_profile_tags), значення top актів (nreg) + «чому», TTL 24–72 год. (2) Evidence snippets cache — ключ (rada_nreg, content_hash, chunk_id), значення витяг тексту, TTL довгий (доки content_hash не змінився). Паралельність: query understanding, LLDBI act-index, DocListDB resolve (speculative за потреби), canonical snippet loading — можна паралелити.
- **Case Law RAG (Supreme Court):** в розділі про джерела додати підпункт: «Case Law RAG (майбутній плагін): той самий контракт EvidencePack (provenance), окремий retriever. Для beta — non-goal; архітектура плагінна.»

### 4.2 Допрацювати

- **Вхід/вихід Retrieval:** на початку розділу Retrieval явно: вхід — user_query, conversation_context (від Memory), constraints (бюджет, latency, мова), workspace (case_id, pinned_acts), attachments (пізніше). Вихід — EvidencePack + RetrievalTrace.
- **Місце в пайплайні:** одна схема/абзац: Gateway → Orchestrator → [Memory Manager → ContextPack; Retrieval Engine → EvidencePack]; далі Reasoner → Writer → Verifier → відповідь. Retrieval постачає докази, не «пояснює право».

---

## 5. FAILURES, DEGRADATION, OBSERVABILITY, SECURITY

### 5.1 Додати в документ

- **Failure modes matrix (згадка Memory):** в таблиці/списку failure modes додати рядки для Memory: Qdrant down → fallback без semantic recall; R2 down → inline/pending; Summarizer fail → більше recent messages; outbox/idempotency — унікальність, lock воркера.
- **Observability (мінімум для збору в один документ):** підрозділ «Спостережність»: trace schema (run_id, step_id, model_id, tokens_in/out, cost_usd, latency_ms, tool_calls); що логувати і де (Application Insights, structured logs); дашборди (p50/p95 latency, cost/query, misalignment rate, citations coverage); алерти (спайки відмов інструментів, аномалії вичерпання бюджету).
- **Security (мінімум):** підрозділ «Безпека (beta та prod)»: Brain приймає запити лише з allowlist IP бекенду або з валідним signed JWT. PII: за замовчуванням redact у логах, не логити raw attachments. Timeout і max body size. Prod: private networking (VNet), APIM, mTLS, WAF — пізніше. Політика web-scout: що саме може повертати (лише WebHints); Writer ніколи не бачить веб-контент. PII handling: storage, redaction, retention — high-level правила. Auth між product backend і brain + rate limiting.

---

## 6. AZURE, BILLING, STREAMING (уточнення в сирому документі)

### 6.1 Додати / уточнити

- **Azure free tier (числа в одному місці):** в розділі про Azure звести в один блок: Container Apps — 180,000 vCPU-s, 360,000 GiB-s, 2 млн requests на підписку; Functions — 1 млн requests, 400,000 GB-s. Умова «влізе в beta»: min replicas = 0, трафік невеликий. Коротка оцінка: скільки «20-секундних» запитів на місяць приблизно покриває free grant.
- **Billing (для фінального збору):** якщо ще нема окремого розділу — додати короткий «Білінг і ліміти»: per user monthly budget; per run max budget; ledger (run_id → step costs → total → remaining); прогноз before execute (expected cost за планом кроків); tier policy (Premium/Standard/Saver/Exhausted) і що дозволено на кожному; cost simulator (estimate_cost(run_plan)), pricing snapshot (частота оновлення прайсів моделей для beta).
- **Streaming (повний набір подій):** переконатися, що в документі є перелік: state (відповідає станам state machine), progress, cost_so_far_usd, citations_count, need_user_clarification; timeout messaging і partial results strategy.

---

## 7. STATE MACHINE І ПАЙПЛАЙН

### 7.1 Додати / систематизувати

- **Повний список станів в одному місці:** Intake → Classify → Plan → Cache RAG → Gate → Expand → DocList → Import → Assemble → Write → Verify → Deliver. Для кожного: max retries, timeout (де застосовно). Діаграма (ASCII або mermaid) з переходами.
- **Правило inline vs queue:** біля станів або біля Gateway — як вище: «якщо likely_long (attachments або тривалість > X с) — черга, інакше inline».
- **Паралелізація:** де саме паралелимо: embedding + retrieval + memory fetch на початку; за потреби — query understanding + LLDBI act-index + DocListDB speculative.

---

## 8. ATTACHMENTS І DOCUMENT PARSER

### 8.1 Додати в документ

- **Attachments у запиті:** явно: у запиті передаються не файли, а **вказівники**: file_id, mime_type, size_bytes, sha256, download_url (signed URL або «backend proxy»), ingestion_hint (pdf/word/text/image). Brain за потреби завантажує контент по download_url.
- **Document Parser (пізніше):** один абзац «Обробка вкладень (після beta)»: парсер pdf/docx → текст, розбиття на частини, ембедінги; додавання в локальний контекст або в LLDBI за політикою. Для beta достатньо вказівників і, за можливості, метаданих (розмір, тип).

---

## 9. VERIFIER І КОНСИСТЕНТНІСТЬ

### 9.1 Додати / уточнити

- **Verifier:** один підрозділ: вхід — чернетка відповіді + EvidencePack + запит; перевірка — кожне твердження має підтримку в evidence; форматування посилань; мовні корекції. «QA-чан» (перевірка консистентності відповіді з запитом) — частина Verifier або окремий крок перед Deliver.
- **Misalignment і corrective loop:** залишити як є; додати одну фразу: «Якщо Verifier або CoverageCritic виявляють невідповідність (topic drift, wrong doc family, procedural gap) — corrective ladder: refine query → expand acts → DocList → web scaffolding → planner; stop condition — abstain + уточнення користувачу.»

---

## 10. СИСТЕМАТИЗАЦІЯ ДОКУМЕНТУ (структура для збору)

Щоб потім збирати «один великий документ», має сенс:

- **Дати великим розділам стабільні назви** (наприклад: 1. Концепт і цілі; 2. Gateway і API; 3. Memory Manager; 4. Retrieval Engine; 5. Reasoner, Writer, Verifier; 6. Пайплайн і state machine; 7. Failure modes і degradation; 8. Білінг і ліміти; 9. Azure та інфраструктура; 10. Observability і безпека; Додатки: схеми, інтерфейси, псевдокод).
- **В кінці документу додати «Зміст (для збору)»** — список цих розділів з номерами сторінок/якорів, щоб при злитті в один файл не губити порядок.
- **Уніфікувати терміни:** скрізь однаково EvidencePack (не «evidence pack» і «Evidence Pack» по-різному); ContextPack; RunRecord; WebHints; QueryProfile; SearchPlan. Один раз дати скорочення (LLDBI, DocListDB, mm_*) і далі вживати їх однаково.

---

## Підсумок

- **Додати:** повні схеми (Gateway request/response, RunRecord, Memory mm_* + R2 + Qdrant), ContextPack з квотами, CaseDigest/rolling summary структури, memory items типи і flow, Memory API, EvidencePack + RetrievalTrace, Query Understanding, Legal Navigator/SearchPlan, 3-tier discovery (A/B/C), Act Acquisition (fast/deep), Rerank/CoverageCritic/QueryRefiner/StopPolicy, Retrieval confidence і ітерації, WebHints, кешування retrieval, memory failure modes, observability, security, Azure free tier числа, streaming події, attachments як вказівники, Verifier і QA-чан, Case Law як плагін/non-goal, Reasoner окремо.
- **Допрацювати:** 4C і user intents в одному місці, non-goals, мова/юрисдикція, Reasoner vs Writer, правило inline vs queue, стрімінг (повний набір полів), Idempotency однією фразою.
- **Уточнити:** Evidence builder = частина Retrieval; Writer ніколи не бачить веб; Team/Global memory тільки opt-in шаблони.
- **Систематизувати:** стабільні назви розділів, зміст для збору, уніфіковані терміни і скорочення.

Після виконання цього списку сирий документ можна збирати в один структуризований архітектурний документ без «забутих» рішень.
