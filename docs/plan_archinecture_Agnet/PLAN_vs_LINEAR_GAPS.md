# Порівняння plan.md з Linear (Agent Architecture): прогалини та рекомендації

**Мета:** щоб при об’єднанні архітектури не повертатися назад — усі важливі блоки з плану мають бути покриті тасками або чітко винесені в «потім».

---

## 1. Що вже добре покрито (plan ↔ Linear)

| Блок у plan | Linear | Коментар |
|-------------|--------|----------|
| Концепт 4C, user intents, non-goals | LEX-33 | Ок |
| Tools inventory, 768 vs 1536 | LEX-34 | Ок |
| Model pool, routing draft | LEX-35, LEX-50 | Ок |
| Brain API (POST/run, streaming) | LEX-36, LEX-59 | Частково — див. прогалини |
| Модулі (Router, Memory, Retrieval, Writer, Verifier, Billing) | LEX-37 | Ок; Reasoner — уточнити |
| Retrieval 3 шари (LLDBI, DocList, Import) | LEX-38 | Ок; деталі — нижче |
| Web scaffolding (Writer не бачить web) | LEX-39 | Ок; WebHints schema — доп. |
| State machine S0–Sx | LEX-40 | Ок |
| EvidencePack / ClaimGraph | LEX-41 | Потрібне узгодження з plan |
| Misalignment detector | LEX-42 | Ок |
| Failure matrix, degradation | LEX-43, LEX-44 | Ок |
| Azure target, deployment | LEX-45, LEX-46 | Ок; free tier — доп. |
| Memory 3 рівні, summarization | LEX-47, LEX-48 | Ок; schema та API — доп. |
| Cost accounting, routing policy, UX limits | LEX-49, LEX-50, LEX-51 | Ок |
| Final doc, algorithmic chain, beta checklist | LEX-52, LEX-53, LEX-54 | Ок |
| Observability, Security, Evaluation, Billing simulator, Streaming | LEX-55–59 | Ок |

---

## 2. Прогалини: що є в plan, але слабо або взагалі не зафіксовано в Linear

### 2.1 Gateway та API (план §2–3, §6)

- **Повний контракт запиту:** у plan є Auth envelope (JWT, X-Request-Id, **Idempotency-Key**), User routing (user_id, tenant_id, chat_id, project_id), **Limits/Plan** (plan_tier, monthly_budget_remaining, hard_limits: max_cost_per_run_usd, max_runs_per_day, web_allowed, deep_allowed, max_imports_per_day), policy_flags (citations_required, privacy_mode, store_memory), Chat settings (language, verbosity, answer_style, jurisdiction), Attachments як **вказівники** (file_id, mime_type, download_url, ingestion_hint).
- **Linear:** LEX-36 описує «поля запиту» загалом, але не вимагає Idempotency-Key, plan_tier, hard_limits, policy_flags, формат attachments.
- **Рекомендація:** або **розширити LEX-36** (acceptance criteria: повний request schema з plan §2.2), або завести підтаск «Gateway request/response schema (full)» з посиланням на plan.

- **RunRecord і зберігання:** plan §3.2 — RunRecord (run_id, user_id, chat_id, project_id, limits_snapshot, status, trace_pointer), зберігання в beta в Supabase. У Linear окремого таска немає.
- **Рекомендація:** додати в **LEX-36** або в **LEX-40**: «RunRecord структура та зберігання (Supabase для beta)».

- **Правило inline vs queue:** plan §3.3 — якщо `likely_long` (attachments або очікувана тривалість > X с) → Service Bus, інакше inline.
- **Рекомендація:** в **LEX-40** (state machine) додати acceptance criterion: «Правило передачі в Orchestrator: inline vs черга (за attachments / оцінкою тривалості)».

---

### 2.2 Memory Manager (план §Memory — схема, інтерфейси, ContextPack)

- **Схема даних (mm_*):** у plan є повна логічна схема: mm_users, mm_user_profile, mm_cases (case_digest_current, case_digest_struct), mm_conversations (rolling_summary_*), mm_messages (content_inline vs content_r2_key), mm_summaries, mm_memory_items (scope_type, item_type, status proposed/confirmed, sensitivity), mm_run_context_snapshots; R2 шляхи; Qdrant колекція + payload (user_id, scope_type, object_type тощо).
- **Linear:** LEX-47 говорить «storage: Supabase + Qdrant + R2», але не вимагає опису таблиць і ключів.
- **Рекомендація:** **розширити LEX-47** або створити підтаск «Memory data schema (Supabase mm_* tables, R2 layout, Qdrant payload)».

- **ContextPack і квоти блоків:** plan §5.1 — profile_block, case_block, conversation_summary_block, memory_items_block, recent_messages_block, retrieved_history_block з **токеновими лімітами** (напр. 300–600, 600–1200 тощо).
- **Рекомендація:** в **LEX-47** або **LEX-48** додати: «ContextPack: структура блоків і token budget на блок».

- **CaseDigest і rolling summary:** plan — case_digest_struct (parties[], key_dates[], issues[], acts[]), rolling_summary_struct (facts, open_questions, decisions, acts). LEX-48 згадує «per chat summary, per project summary», але не формалізує поля.
- **Рекомендація:** в **LEX-48** додати: «Формат CaseDigest і rolling summary (структуровані поля)».

- **Memory items: типи і flow:** plan — item_type (preference, fact, constraint, glossary, note), status proposed/confirmed/rejected, «1-клік запам’ятати» (confirm/reject).
- **Рекомендація:** в **LEX-47/48** зафіксувати: «Типи memory items і flow proposed → confirmed/rejected (UI 1-клік)».

- **Memory Manager API (Read/Write/Background):** plan §12 — get_context, get_case_digest, list_memory_items; append_message, confirm_memory_item, update_profile; run_summarization, run_case_digest_update, run_memory_extraction, run_semantic_index, retention_cleanup.
- **Рекомендація:** **новий підтаск або розширення LEX-47**: «Memory Manager API spec (Read/Write/Background) — сигнатури та контракт».

- **Memory failure modes:** plan §9 — Qdrant down (fallback без semantic recall), R2 down (pending upload), Summarizer fail (більше recent messages), idempotency/outbox, privacy.
- **Рекомендація:** в **LEX-43** додати рядок «Memory: Qdrant/R2/Summarizer fallbacks, outbox idempotency» або короткий підрозділ у 04_failures.

---

### 2.3 Retrieval Engine (план §Retrieval — шари, контракти, якість)

- **Query Understanding layer:** plan §3.1 — IntentClassifier, LegalDomainTagger, Entity & Citation Extractor, Ambiguity Detector → QueryProfile, RoutingFlags.
- **Linear:** LEX-38 описує «3 шари retrieval», але не вимагає опису Query Understanding і QueryProfile.
- **Рекомендація:** **розширити LEX-38** або 02_components: «Retrieval: Query Understanding (QueryProfile, routing flags)».

- **Legal Navigator і SearchPlan:** plan §3.2 — Synonymizer, Hypothesis Builder, Plan Builder (cache → DocList → web → import).
- **Рекомендація:** в **LEX-38** додати: «Legal Navigator: SearchPlan (план пошуку до RAG)».

- **Три рівні Candidate Discovery (A/B/C):** plan §3.3 — A = прямі посилання (рада_nreg, «ККУ ст.115»), B = LLDBI act-index, C = DocListDB resolver.
- **Рекомендація:** в **LEX-38** явно вказати: «3 рівні: direct citations → LLDBI acts → DocListDB».

- **Act Acquisition / ActIngestionOrchestrator:** plan §3.4 — перевірка legislation_documents, черга імпорту, fast mode (1–3 акти) vs deep (5–15).
- **Рекомендація:** в **LEX-38** додати: «Import orchestration: умови постановки в чергу, fast vs deep mode».

- **Rerank, CoverageCritic, QueryRefiner, StopPolicy:** plan §3.7 — переранжування, перевірка покриття, переформулювання запиту, обмеження ітерацій.
- **Рекомендація:** в **LEX-38** або **LEX-42**: «Retrieval: Rerank, CoverageCritic, QueryRefiner, stop policy (max iterations)».

- **EvidencePack і RetrievalTrace (формат з plan):** plan §1 — answerability, act_candidates, evidence_items (source_type, source_id, extracts з provenance), recommended_next_steps; RetrievalTrace (лог кроків).
- **Linear:** LEX-41 — Evidence + ClaimGraph; формату EvidencePack з plan немає.
- **Рекомендація:** **узгодити LEX-41 з plan**: EvidencePack (evidence_items, extracts, provenance) як основний артефакт; ClaimGraph опційно; RetrievalTrace окремо.

- **WebHints schema:** plan §3.8 — candidate_act_titles, keywords, possible_document_types, procedure_clues. Writer ніколи не бачить web-контент.
- **Рекомендація:** в **LEX-39** додати: «WebHints schema (що саме повертає web) + hard rule: Writer не отримує web-текст».

- **Кешування retrieval:** plan §6 — act resolution cache (hash query+domain, TTL 24–72h), evidence snippets cache (rada_nreg, content_hash, chunk_id).
- **Рекомендація:** **новий підтаск або LEX-38**: «Retrieval: caching (act resolution, snippet cache, TTL)».

- **Retrieval Confidence Model:** plan §5.1 — relevance_top1, coverage_score, source_diversity, act_confidence, freshness; політика (coverage < threshold → ще ітерація).
- **Рекомендація:** в **LEX-38** або **LEX-42**: «Retrieval confidence model і політика ітерацій (коли зупинятися / уточнювати)».

- **Case Law RAG (Supreme Court):** plan §2.3 — плагін CaseLawRetriever, той самий контракт provenance.
- **Рекомендація:** в **LEX-33** (Concept) або **LEX-38** зафіксувати: «Case Law RAG: non-goal для beta / майбутній плагін з тим самим EvidencePack».

---

### 2.4 Інше (план)

- **Reasoner:** plan §8 — окремий блок «Reasoner (legal reasoning строго з Evidence)» між Retrieval і Writer. У LEX-37 є «Evidence builder» — можлива змішана роль.
- **Рекомендація:** в **LEX-37** уточнити: «Reasoner: вхід EvidencePack, вихід структуроване міркування; Writer не бачить сирого evidence без Reasoner».

- **Streaming (події):** plan §4 — state, progress, cost_so_far_usd, citations_count, need_user_clarification.
- **Рекомендація:** в **LEX-59** переконатися, що acceptance criteria включають ці поля та назви станів з state machine.

- **Azure free tier:** plan — 180k vCPU-s, 360k GiB-s, 2M requests (Container Apps); 1M requests, 400k GB-s (Functions); min replicas 0.
- **Рекомендація:** в **LEX-45** додати: «Відповідність free tier (числа, scale-to-zero) для beta».

- **Attachments / Document Parser:** plan — вкладення як указатели; «пізніше» парсер pdf→text, додавання в контекст/LLDBI.
- **Рекомендація:** в **LEX-36** зафіксувати «attachments як указатели (file_id, download_url, ingestion_hint)»; окремий таск «Attachment ingestion (parser, context vs LLDBI)» можна винести в «після beta» або в Concept як non-goal.

- **Мова та юрисдикція:** plan — uk (default), en optional, jurisdiction UA.
- **Рекомендація:** в **LEX-33** або **LEX-36** однією фразою: «Мова (uk/en) та юрисдикція (UA)».

- **Verifier / consistency:** plan — «QA-чан» перевірка відповіді.
- **Рекомендація:** в **LEX-42** вже є corrective loop; додати «Verifier: перевірка консистентності відповіді (QA pass)» якщо ще немає.

---

## 3. Блоки, які варто «доробити» перед об’єднанням

Коротко: **що додати / у які таски**, щоб при злитті plan → 01–09 не довелося повертатися.

| # | Блок | Де в plan | Що зробити в Linear | Наслідок частини |
|---|------|-----------|---------------------|-------------------|
| 1 | Gateway: повний request/response + RunRecord | §2.2, 2.3, 3.2 | Розширити LEX-36 (+ опц. підтаск) | **02_components** (API Contract) |
| 2 | Inline vs queue правило | §3.3 | Додати в LEX-40 | **03_pipelines** |
| 3 | Memory: схема mm_*, R2, Qdrant | §3 (Memory) | Розширити LEX-47 або підтаск | **05_memory** |
| 4 | ContextPack формат + token budgets | §5.1 (Memory) | LEX-47 або LEX-48 | **05_memory** |
| 5 | CaseDigest / rolling summary структури | §2.2, 6.1–6.2 (Memory) | LEX-48 | **05_memory** |
| 6 | Memory items типи + confirm flow | §2.2, 6.3 (Memory) | LEX-47/48 | **05_memory** |
| 7 | Memory Manager API (Read/Write/Background) | §12 (Memory) | LEX-47 або окремий підтаск | **05_memory** |
| 8 | Memory failure modes | §9 (Memory) | LEX-43 | **04_failures** |
| 9 | Query Understanding + QueryProfile | §3.1 (Retrieval) | LEX-38 | **02_components / 03** |
| 10 | Legal Navigator + SearchPlan | §3.2 (Retrieval) | LEX-38 | **02 / 03** |
| 11 | 3-tier discovery (A/B/C) + Act Acquisition | §3.3–3.4 (Retrieval) | LEX-38 | **02 / 03** |
| 12 | Rerank, CoverageCritic, QueryRefiner, StopPolicy | §3.7 (Retrieval) | LEX-38 / LEX-42 | **03_pipelines** |
| 13 | EvidencePack + RetrievalTrace (формат plan) | §1 (Retrieval) | Узгодити LEX-41 | **03_pipelines** |
| 14 | WebHints schema + hard rule Writer | §3.8 (Retrieval) | LEX-39 | **02_components** |
| 15 | Retrieval caching | §6 (Retrieval) | LEX-38 або підтаск | **02 / 03** |
| 16 | Retrieval confidence + ітерації | §5.1 (Retrieval) | LEX-38 / LEX-42 | **03_pipelines** |
| 17 | Case Law RAG (плагін / non-goal) | §2.3 (Retrieval) | LEX-33 або LEX-38 | **01_concept / 02** |
| 18 | Reasoner (окремий модуль) | §8 (Retrieval) | LEX-37 | **02_components** |
| 19 | Streaming events (state, cost_so_far, need_clarification) | §4 (Gateway) | LEX-59 | **02_components** |
| 20 | Azure free tier | §0–1 (Azure) | LEX-45 | **07_azure_hosting** |
| 21 | Attachments (указатели + майбутній parser) | §2.2 E), сценарії | LEX-36 + опц. таск | **02 / non-goal** |
| 22 | Мова / юрисдикція | plan сценарії | LEX-33 / LEX-36 | **01_concept** |

---

## 4. Рекомендований порядок «доробок» (щоб не повертатися)

1. **Контракти (щоб все інше на них спиралося):**
   - LEX-36: повний Gateway request/response, RunRecord, Idempotency-Key, attachments як указатели.
   - LEX-41: узгодити EvidencePack + RetrievalTrace з plan (evidence_items, extracts, provenance).

2. **Memory (одним блоком після контрактів):**
   - LEX-47: схема mm_*, ContextPack з квотами, типи memory items, опційно — Memory Manager API.
   - LEX-48: CaseDigest і rolling summary структури, confirm/reject flow.
   - LEX-43: рядок про memory failure modes.

3. **Retrieval (деталізація LEX-38 + суміжні):**
   - LEX-38: Query Understanding, Legal Navigator/SearchPlan, 3-tier discovery, Act Acquisition (fast/deep), Rerank/CoverageCritic/QueryRefiner/StopPolicy, caching, confidence model.
   - LEX-39: WebHints schema.
   - LEX-37: Reasoner.

4. **Pipeline і інфра:**
   - LEX-40: правило inline vs queue.
   - LEX-59: повний набір streaming events.
   - LEX-45: free tier.
   - LEX-33: мова/юрисдикція, Case Law як майбутній плагін/non-goal.

Після цього злиття plan.md у 01–09 і збірка 08_final_architecture.md матимуть повну відповідність без «забутих» рішень.

---

## 5. Підсумок

- **В Linear вже є** майже вся висока карта (Concept, Components, Pipelines, Failures, Memory, Billing, Azure, Final, Beta, Observability, Security, Evaluation, Streaming, Billing simulator).
- **Прогалини** — це переважно **деталі з plan**: повний Gateway schema, RunRecord, Memory schema та API, ContextPack квоти, Retrieval (Query Understanding, SearchPlan, 3-tier, Act Acquisition, Rerank/Coverage, EvidencePack формат, WebHints, caching, confidence), Reasoner, streaming events, Azure free tier, attachments, мова/юрисдикція.
- **Щоб не повертатися:** послідовно доробити прийняті вище пункти в відповідних LEX-тасках (або невеликих підтасках), потім переносити plan.md у структуру 01–09 і збирати 08_final_architecture.md.

Файл можна використати як чекліст перед фінальним merge архітектури.
