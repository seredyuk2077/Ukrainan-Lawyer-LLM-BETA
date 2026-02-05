# Block Cards — Matrix (11 fields per block)

Картки блоків: кожен блок має 11 полів (Purpose, Inputs, Outputs, Storage side-effects, Dependencies, Secrets & Config, Failure Modes, Retries/Timeouts, Observability, Test Hooks/Injectables). Джерела: `docs/plan_archinecture_Agnet/answer.md`, `answarGRAPHIC.md`, `plan.md`. Якщо поля не описані в документації — вказано **«Не описано в документації»**.

---

## Online Serving

### [U1] Gateway/Intake
| Поле | Значення |
|------|----------|
| **Purpose** | Прийом POST /v1/runs, перевірка прав/лімітів, ініціалізація Run, enqueue. |
| **Inputs** | HTTP POST /v1/runs: user_id, tenant_id, chat settings, текст запиту, вкладення. |
| **Outputs** | Ack (run_id), RunRecord, подія в черзі. |
| **Storage side-effects** | Postgres RunRecord (runs/run_records), статус Intake; великі вкладення → R2, посилання в БД. |
| **Dependencies** | Backend API, Supabase, Internal Task Queue. |
| **Secrets & Config** | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, queue URL, конфіг лімітів планів. |
| **Failure Modes** | Unauthorized 401/403; rate limit 429 ERR_BUDGET_EXHAUSTED; DB down 503; queue fail → Run failed. |
| **Retries/Timeouts** | Немає HTTP retry; внутр. retry 1–2 рази при тимч. недоступності БД; таймаут кілька с. |
| **Observability** | Лог run_id, user, plan; метрики count runs, rate rejected. |
| **Test Hooks/Injectables** | Dry-run endpoint; self-test з тестовими токенами. |

### [U2] Classify
| Поле | Значення |
|------|----------|
| **Purpose** | Початковий аналіз запиту: намір, категорія права, сутності, згадки актів; QueryProfile + RoutingFlags. |
| **Inputs** | Текст запиту з [U1], метадані користувача (мова, юрисдикція). |
| **Outputs** | QueryProfile (тип, галузь, сутності, ambiguous), RoutingFlags. |
| **Storage side-effects** | RunContext (RAM/Redis), RunRecord.query_profile для аудиту. |
| **Dependencies** | LLM 4o-mini через OpenRouter або ruleset. |
| **Secrets & Config** | OPENROUTER_API_KEY, CLF_MODEL_ID, CLF_TIMEOUT_SEC (~5 с). |
| **Failure Modes** | LLM 500/timeout → дефолтний профіль, profile_generation degraded; неприпустимий контент → run failed. |
| **Retries/Timeouts** | Retry 1x з резервною моделлю; таймаут ~5 с. |
| **Observability** | Лог QueryProfile(type, domain, entities); метрики типів питань, ambiguity. |
| **Test Hooks/Injectables** | Unit tests на тестових запитах; USE_RULE_BASED_CLASSIFIER=true stub. |

### [U2a] IntentClassifier
| Поле | Значення |
|------|----------|
| **Purpose** | Визначення типу питання (intent). |
| **Inputs** | Текст запиту. |
| **Outputs** | intent. |
| **Storage side-effects** | Не описано в документації. |
| **Dependencies** | LLM або rules. |
| **Secrets & Config** | Не описано в документації. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Не описано в документації. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [U2b] LegalDomainTagger
| Поле | Значення |
|------|----------|
| **Purpose** | Галузь права (domain). |
| **Inputs** | Текст запиту / QueryProfile. |
| **Outputs** | domain. |
| **Storage side-effects** | Не описано в документації. |
| **Dependencies** | Не описано в документації. |
| **Secrets & Config** | Не описано в документації. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Не описано в документації. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [U2c] Entity Extractor
| Поле | Значення |
|------|----------|
| **Purpose** | Витягування сутностей (акти, статті) з запиту. |
| **Inputs** | Текст запиту. |
| **Outputs** | entities. |
| **Storage side-effects** | Не описано в документації. |
| **Dependencies** | Не описано в документації. |
| **Secrets & Config** | Не описано в документації. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Не описано в документації. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [U2d] Ambiguity Detector
| Поле | Значення |
|------|----------|
| **Purpose** | Ознаки неоднозначності запиту. |
| **Inputs** | Текст запиту, QueryProfile. |
| **Outputs** | routing_flags.ambiguous. |
| **Storage side-effects** | Не описано в документації. |
| **Dependencies** | Не описано в документації. |
| **Secrets & Config** | Не описано в документації. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Не описано в документації. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [U3] Plan
| Поле | Значення |
|------|----------|
| **Purpose** | Планувальник пошуку: чи достатньо LLDBI, чи DocList, чи web; SearchPlan, RoutingFlags. |
| **Inputs** | QueryProfile з [U2], feature flags (doclist_enabled, web_assist_enabled). |
| **Outputs** | SearchPlan, RoutingFlags (need_deep_retrieval, need_web). |
| **Storage side-effects** | RunRecord run_context_snapshot.search_plan, RunLimits. |
| **Dependencies** | Внутр. правила, таблиця релевантності LLDBI, словник тригерів web. |
| **Secrets & Config** | MIN_CHUNKS_OK, ENABLE_WEB_FALLBACK, фічі-флаги. |
| **Failure Modes** | Некоректний профіль → дефолт LLDBI; виняток → fallback-план LLDBI або fail run; web_assist_enabled=false → пропуск веб. |
| **Retries/Timeouts** | Немає зовн. викликів; очікувано <100 мс. |
| **Observability** | Лог SearchPlan use_cache, use_doclist, use_web; RunRecord routing_flags. |
| **Test Hooks/Injectables** | Config tests з різними flags; simulation з JSON QueryProfile. |

### [U3a] Plan Builder
| Поле | Значення |
|------|----------|
| **Purpose** | Legal Navigator build_plan, політика A/B/C discovery (ActsA/B/C). |
| **Inputs** | QueryProfile, pinned_acts, constraints. |
| **Outputs** | SearchPlan (кроки: LLDBI, DocList, Web). |
| **Storage side-effects** | Не описано в документації. |
| **Dependencies** | plan.md §7: DirectCitationsResolver, LLDBI_ActIndex, DocListDB.resolve. |
| **Secrets & Config** | Не описано в документації. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Не описано в документації. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [U4] CacheRAG
| Поле | Значення |
|------|----------|
| **Purpose** | Пошук по LLDBI (lexery_legislation_chunks, lexery_legislation_acts) та Memory; RawHits[], MemoryRefs. |
| **Inputs** | SearchPlan, текст запиту, refs з [U2]. |
| **Outputs** | RawHits[] (r2_key, json_path, метадані), MemoryRefs. |
| **Storage side-effects** | RunRecord RetrievalTrace; не зберігає постійних даних. |
| **Dependencies** | Qdrant LLDBI, Supabase mm_*, опц. Qdrant lexery_memory_semantic_v1. |
| **Secrets & Config** | QDRANT_URL, QDRANT_API_KEY, QDRANT_TIMEOUT ~3–5 с, LLDBI_TOP_K, MIN_SCORE_THRESHOLD, MEMORY_SEMANTIC_ENABLED. |
| **Failure Modes** | Qdrant down → degraded_sources lldbi, порожні RawHits або SQL fallback; низький score → low_confidence; пам’ять fail → не критично. |
| **Retries/Timeouts** | Qdrant retry 1x 0.5 с; таймаут ~3 с на запит. |
| **Observability** | RetrievalTrace; лог LLDBI_hits, top_score, time; метрики час пошуку, розмір результатів. |
| **Test Hooks/Injectables** | Integration test з тестовим Qdrant; SIMULATE_QDRANT_DOWN fault injection. |

### [U5] Gate
| Поле | Значення |
|------|----------|
| **Purpose** | Рішення: expand=true/false за RawHits та порогах; якщо false — одразу [U9] Assemble. |
| **Inputs** | RawHits[] з [U4], QueryProfile/RoutingFlags з [U3]. |
| **Outputs** | Expand true/false, причина (low coverage, direct ref missing). |
| **Storage side-effects** | RunRecord.flags deep_retrieval, RunLimits. |
| **Dependencies** | MIN_HITS_THRESHOLD, MIN_AVG_SCORE, doclist_enabled. |
| **Secrets & Config** | MIN_HITS_THRESHOLD, MIN_AVG_SCORE, doclist_enabled. |
| **Failure Modes** | Хибно-негативне/позитивне — налаштовується порогами; exception → Expand=false. |
| **Retries/Timeouts** | Немає зовн. дій; мілісекунди. |
| **Observability** | Лог Gate expand, reason; метрики % Expand, середній RawHits. |
| **Test Hooks/Injectables** | Threshold tests; FORCE_EXPAND=true. |

### [U6] Expand
| Поле | Значення |
|------|----------|
| **Purpose** | Розширення запиту синонімами (Legal Navigator); expanded query. |
| **Inputs** | Оригінальний запит, флаги з Gate. |
| **Outputs** | Expanded Query, список синонімів/термінів. |
| **Storage side-effects** | RunRecord query_expanded (дебаг); нічого постійного. |
| **Dependencies** | LLM OpenRouter, опц. LEGAL_THESAURUS_PATH. |
| **Secrets & Config** | OPENROUTER_API_KEY, EXPAND_MODEL_ID, EXPAND_MAX_TOKENS, LEGAL_THESAURUS_PATH. |
| **Failure Modes** | LLM failure → повертає оригінальний запит; nonsense expansion — фільтрація. |
| **Retries/Timeouts** | Немає retry; таймаут ~5 с. |
| **Observability** | Лог expanded query diff; метрики к-сть термінів, частка LLM skip. |
| **Test Hooks/Injectables** | QA tests на відомих запитах; DISABLE_EXPAND_LLM bypass. |

### [U6a] Synonymizer
| Поле | Значення |
|------|----------|
| **Purpose** | Генерація синонімів/переформулювань (plan §7). |
| **Inputs** | user_query, QueryProfile. |
| **Outputs** | ExpandedQuery / синоніми. |
| **Storage side-effects** | Не описано в документації. |
| **Dependencies** | LLM. |
| **Secrets & Config** | Не описано в документації. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Не описано в документації. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [U7] DocList
| Поле | Значення |
|------|----------|
| **Purpose** | Пошук по каталогу актів DocListDB; ActCandidates[] (rada_nreg, назва, рейтинг). |
| **Inputs** | Expanded Query з [U6], QueryProfile. |
| **Outputs** | ActCandidates[] (до 10–20), порожній при збої. |
| **Storage side-effects** | Кеш на кілька хв (read-only). |
| **Dependencies** | DocList Resolver API POST /catalog/resolve, Qdrant legislation-catalog-index 768d, Supabase legislation_documents. |
| **Secrets & Config** | DOCLIST_API_URL або QDRANT_*, DOC_EMBEDDING_MODEL. |
| **Failure Modes** | API down → порожній список, деградація; no results — не збій; partial mismatch — фільтрує Reranker. |
| **Retries/Timeouts** | Retry 1x 1 с; таймаут ~5–7 с. |
| **Observability** | Лог DocList results N; used_doclist в audit. |
| **Test Hooks/Injectables** | Integration test з Dev DocList; simulated timeout fallback. |

### [U8] Import
| Поле | Значення |
|------|----------|
| **Purpose** | Ініціює імпорт актів у LLDBI; fast mode 1–3 акти; чернетки EvidencePack якщо встигне. |
| **Inputs** | ActCandidates[] з [U7], Supabase перевірка. |
| **Outputs** | Оновлений LLDBI або чернетки; інакше — задача в бекграунді. |
| **Storage side-effects** | legislation_documents indexed, import_jobs; R2, Qdrant через O7–O12. |
| **Dependencies** | O7–O12 pipeline, Rada, R2, векторна модель, черга/ThreadPool. |
| **Secrets & Config** | SUPABASE_KEY, IMPORT_FAST_MODE_COUNT, IMPORT_TIMEOUT_SEC (5–10 с), CRITICAL_ACTS. |
| **Failure Modes** | Таймаут → degrade_reason import_timeout; помилка завантаження → кандидат failed; всі вже indexed — швидко skip. |
| **Retries/Timeouts** | На рівні [U8] не повторює той самий акт; таймаут очікування конфіг (напр. 8 с на 1 акт). |
| **Observability** | Лог Import start N, Fetched act X; метрики час імпорту, к-сть імпортів; RunRecord список імпортованих. |
| **Test Hooks/Injectables** | E2E DocList→Import→відповідь; cancel import test. |

### [U8b] ActRelevanceValidator
| Поле | Значення |
|------|----------|
| **Purpose** | Валідація top 3 перед Import: чи відповідають запиту? confidence ≥70–80% → імпорт top 3. Інакше → Web (Perplexity Sonar) enrichment → re-rank → імпорт 1 найкращий. **Fallback:** якщо Web fail (немає інфи, ліміт) → імпорт top 3. |
| **Inputs** | top 3 ActCandidates з [U8a], user query, QueryProfile. |
| **Outputs** | [immediate[], queued[]] для [U8]. |
| **Dependencies** | gpt-4o-mini (confidence), **perplexity/sonar** (Web enrichment via OPENROUTER_API_KEY_WEB). |
| **Secrets & Config** | ACT_RELEVANCE_THRESHOLD (0.70–0.80), WEB_BUDGET_PER_RUN. |
| **Failure Modes** | Web fail → fallback top 3; Sonar timeout → fallback top 3. |
| **Retries/Timeouts** | Web retry 1x; таймаут ~15 с. |
| **Observability** | Лог U8b path (direct/web/fallback); метрики web_fallback_count. |
| **Test Hooks/Injectables** | MOCK_WEB_EMPTY=true; MOCK_WEB_BUDGET_EXCEEDED=true. |

### [U8a] ActIngestionOrchestrator
| Поле | Значення |
|------|----------|
| **Purpose** | Визначає **які акти імпортувати першими** (fast mode vs queue): фільтр Missing → rank за score → pick top N для синхронного чекання, решта в чергу. |
| **Inputs** | ActCandidates[] з [U7], QueryProfile.entities (для boost), constraints (latency/budget). |
| **Outputs** | [immediate[], queued[]] — упорядкований список для [U8]; enqueue import_jobs. |
| **Логіка (4 кроки)** | 1) Filter Missing: перевірка Supabase `legislation_documents` — виключити qdrant_status=indexed. 2) Rank: DocList score (U7) + опц. boost актів з entities. 3) Pick top N: IMPORT_FAST_MODE_COUNT (1–3) для синхронного чекання. 4) Rest → queue. |
| **Storage side-effects** | import_jobs. |
| **Dependencies** | Supabase legislation_documents, job runner. |
| **Secrets & Config** | IMPORT_FAST_MODE_COUNT (1–3), IMPORT_TIMEOUT_SEC. |
| **Failure Modes** | Всі вже indexed → швидко skip; Supabase down → degraded, fallback до всіх у queue. |
| **Retries/Timeouts** | Немає retry на рівні U8a; timeout задається в [U8]. |
| **Observability** | Лог pick_top N immediate, M queued; метрики filtered_count. |
| **Test Hooks/Injectables** | Mock Supabase indexed status; FORCE_QUEUE_ALL=true. |

### [U9] Assemble
| Поле | Значення |
|------|----------|
| **Purpose** | Збір ContextPack + EvidencePack; system/user/context blocks для LLM. **Evidence-only:** Writer бачить лише підтверджений контекст (RawHits→R2 snippets, Memory). |
| **Inputs** | User query, conversation history (messages), Memory, EvidencePack/RawHits (r2_key), preferences. |
| **Outputs** | Complete Prompt (system + user + context). |
| **Storage side-effects** | Читання messages, R2 CanonicalSnippetLoader; опц. виклик Semantic Indexer. |
| **Dependencies** | Supabase messages, R2, Memory Manager; CONTEXT_LIMIT, MEMORY_SUMMARY_LENGTH. |
| **Secrets & Config** | SUPABASE_KEY, R2_ACCESS_KEY_ID, R2_SECRET_KEY, CONTEXT_LIMIT. |
| **Failure Modes** | R2 down → обмежений evidence, попередження; overflow → обрізання контексту; помилка формування → Run failed. |
| **Retries/Timeouts** | R2 retry 3x 1 с; Memory Qdrant не retry; таймаут складання 2–3 с. |
| **Observability** | Лог assembled context X msgs Y evidence Z tokens; assembled_context_manifest у RunRecord. |
| **Test Hooks/Injectables** | Prompt template tests; context overflow test; R2 error injection. |

### [U10] Write
| Поле | Значення |
|------|----------|
| **Purpose** | Виклик LLM для генерації відповіді; **evidence-only instruction** у промпті: не цитувати те, чого немає в EvidencePack. Stream токенів у [U12]. |
| **Inputs** | Complete Prompt з [U9], Model choice (gpt-4o). |
| **Outputs** | Draft Answer, stream токенів. |
| **Storage side-effects** | messages assistant, RunRecord tokens_used model_id; R2 якщо дуже велика відповідь; billing_ledger. |
| **Dependencies** | OpenRouter, Model Selector, Streaming Handler. |
| **Secrets & Config** | OPENROUTER_API_KEY, MODEL_POLICY, MAX_TOKENS_ANSWER. |
| **Failure Modes** | API 500/503 → retry до 3x; timeout → fail; hallucination — ловить [U11]. |
| **Retries/Timeouts** | Retry 1–2x при 502/timeout; таймаут GPT-4 ~30–40 с, GPT-3.5 ~15 с; circuit breaker. |
| **Observability** | Telemetry tokens, cost; метрики час генерації, downgraded. |
| **Test Hooks/Injectables** | USE_FAKE_MODEL sandbox; token counter stub; model switch test. |

### [U11] Verify
| Поле | Значення |
|------|----------|
| **Purpose** | Rerank + CoverageCritic; verdict complete / retry_with_more_evidence / failed; repair loop. |
| **Inputs** | Draft Answer, EvidencePack, QueryProfile, SearchPlan. |
| **Outputs** | Verdict, відформатована відповідь. |
| **Storage side-effects** | RunRecord citations_count, degrade_reason; опц. feedback store. |
| **Dependencies** | LLM Critic (Claude/GPT-4), Cross-encoder, StopPolicy. |
| **Secrets & Config** | VERIFIER_MODEL_ID, VERIFIER_MAX_LOOPS, MIN_COVERAGE_SCORE, REQUIRE_CITATION. |
| **Failure Modes** | Недостатнє покриття → retry; хибні цитати → filter або failed; Critic down → complete by default, degraded_verification. |
| **Retries/Timeouts** | Critic retry 1x; таймаут ~15 с; StopPolicy max loops. |
| **Observability** | Лог Verify coverage_ok, missing; retrieval loop #k; метрики % retry, coverage score. |
| **Test Hooks/Injectables** | Functional test неповна відповідь; citation test; SKIP_CRITIC=true. |

### [U11a] CoverageCritic
| Поле | Значення |
|------|----------|
| **Purpose** | Перевірка покриття аспектів запиту (підстава, процедура, наслідки); verdict: complete / retry_with_more_evidence / need_web / failed. |
| **Inputs** | Draft Answer, EvidencePack, QueryProfile. |
| **Outputs** | verdict, missing aspects. |
| **Storage side-effects** | RunRecord coverage_ok, missing_aspects (аудит). |
| **Dependencies** | LLM gpt-4o-mini (OpenRouter ONLINE). |
| **Secrets & Config** | VERIFIER_MODEL_ID (gpt-4o-mini), MIN_COVERAGE_SCORE. |
| **Failure Modes** | LLM down → complete by default, degraded_verification. |
| **Retries/Timeouts** | Retry 1x; таймаут ~15 с. |
| **Observability** | Лог coverage_ok, verdict, missing; метрики % retry. |
| **Test Hooks/Injectables** | SKIP_CRITIC=true; mock verdict. |

### [U11b] CrossEncoderReranker
| Поле | Значення |
|------|----------|
| **Purpose** | Відфільтрувати нерелевантні extracts, перевірити цитати (чи відповідають EvidencePack). |
| **Inputs** | Draft Answer, EvidencePack (extracts). |
| **Outputs** | Відфільтрований список extracts; позначки «придумані» цитати. |
| **Storage side-effects** | RunRecord citations_filtered (аудит). |
| **Dependencies** | Cross-encoder ms-marco-MiniLM-L-6-v2 (локально або API). |
| **Secrets & Config** | RERANKER_MODEL_PATH або RERANKER_API_URL; MIN_RELEVANCE_SCORE. |
| **Failure Modes** | Reranker down → пропуск фільтрації, degraded_verification. |
| **Retries/Timeouts** | Retry 1x; таймаут ~5 с. |
| **Observability** | Лог citations_filtered, filtered_count; метрики rerank time. |
| **Test Hooks/Injectables** | SKIP_RERANKER=true; mock relevance scores. |

### [U11c] QueryRefiner
| Поле | Значення |
|------|----------|
| **Purpose** | Переформулювання запиту для retry retrieval; додає missing aspects, опц. WebHints (назви актів, keywords). |
| **Inputs** | user_query, EvidencePack, QueryProfile (missing aspects з U11a); опц. WebHints з U11e. |
| **Outputs** | refined_query для U4 repeat retrieval. |
| **Storage side-effects** | RunRecord refined_query (дебаг). |
| **Dependencies** | LLM gpt-4o-mini (OpenRouter ONLINE). |
| **Secrets & Config** | QUERY_REFINER_MODEL_ID (gpt-4o-mini). |
| **Failure Modes** | LLM down → повертає оригінальний запит + missing aspects. |
| **Retries/Timeouts** | Retry 1x; таймаут ~10 с. |
| **Observability** | Лог refined_query diff; метрики retry retrieval count. |
| **Test Hooks/Injectables** | Mock refined query; skip refinement. |

### [U11d] StopPolicy
| Поле | Значення |
|------|----------|
| **Purpose** | Обмеження по ітераціях/часу/бюджету; чи робити ще цикл retry retrieval. |
| **Inputs** | Поточна ітерація (loop #k), VERIFIER_MAX_LOOPS, budget_usd, elapsed_time_sec. |
| **Outputs** | stop / continue. |
| **Storage side-effects** | RunRecord retrieval_loops, stop_reason. |
| **Dependencies** | Rules; config. |
| **Secrets & Config** | VERIFIER_MAX_LOOPS (напр. 3), MAX_RETRIEVAL_BUDGET_USD, MAX_RUN_DURATION_SEC. |
| **Failure Modes** | loops exhausted → stop, verdict complete або failed; budget exceeded → stop. |
| **Retries/Timeouts** | Немає; перевірка на кожній ітерації Verify. |
| **Observability** | Лог stop_reason, loops; метрики % retry exhausted. |
| **Test Hooks/Injectables** | FORCE_RETRY=true; mock loops exhausted. |

### [U11e] WebNavigator
| Поле | Значення |
|------|----------|
| **Purpose** | Router-only: веб-пошук тільки для WebHints (назви актів, keywords); Writer не бачить веб-уривки. |
| **Inputs** | user_query, QueryProfile (коли coverage низький, web_assist_enabled). |
| **Outputs** | WebHints: candidate_act_titles[], keywords[], possible_document_types[], procedure_clues[]. |
| **Storage side-effects** | Кеш результатів на короткий час. |
| **Dependencies** | **Perplexity Sonar** (`perplexity/sonar`) via OpenRouter — модель з вбудованим веб-пошуком. |
| **Secrets & Config** | OPENROUTER_API_KEY_WEB, WEB_BUDGET_PER_RUN. |
| **Failure Modes** | Нічого корисного / провайдер down → порожні hints, продовжити без веб. |
| **Retries/Timeouts** | 1 повтор; таймаут ~10 с. |
| **Observability** | Лог WebNavigator found N candidates; метрики скільки запитів потребували веб. |
| **Test Hooks/Injectables** | Integration test без внутр. баз; no-web test. |

### [U12] Deliver
| Поле | Значення |
|------|----------|
| **Purpose** | SSE GET /v1/runs/{run_id}/events, фіналізація RunRecord, messages, outbox, billing. |
| **Inputs** | Verified Answer, run_id, verdict. |
| **Outputs** | Stream message/status, RunRecord completed/failed, messages DB, outbox events. |
| **Storage side-effects** | Supabase messages, RunRecord timestamp_end tokens cost; outbox; billing_ledger. |
| **Dependencies** | SSE channel, Time service, Background job processor. |
| **Secrets & Config** | ENABLE_SSE, MESSAGE_STREAM_CHUNK_SIZE, CANCEL_CHECK_INTERVAL, ARCHIVE_HISTORY_DAYS. |
| **Failure Modes** | SSE disconnect → cancelled_by_client; DB fail → retry 3x; outbox fail — лог, не блокує. |
| **Retries/Timeouts** | Retry для запису БД/outbox 3x; heartbeat ~5 с. |
| **Observability** | Audit run completed; лог Run id completed, tokens, cost; метрики success/failed, latency. |
| **Test Hooks/Injectables** | E2E stream test; cancellation test; persistence GET /runs/{id}. |

---

## Offline DocListDB Updater

### [T0] Schedule Cron
| Поле | Значення |
|------|----------|
| **Purpose** | Тригер по розкладу (cron / Azure Timer) для оновлення DocListDB. |
| **Inputs** | Розклад (cron expression). |
| **Outputs** | Tick → [O2]. |
| **Storage side-effects** | Ні; лог timestamp. |
| **Dependencies** | Unix cron / Azure TimerTrigger. |
| **Secrets & Config** | CRON_SCHEDULE. GitHub Actions: rada-doclistdb-updater.yml 02:17 UTC. |
| **Failure Modes** | Пропущений запуск — компенсує наступний; Cron зупинено — база застаріває. |
| **Retries/Timeouts** | Немає. |
| **Observability** | Лог DocListDB update triggered. |
| **Test Hooks/Injectables** | Manual trigger; dry-run mode. |

### [O1x] R2 Lock Acquire (DocListDB)
| Поле | Значення |
|------|----------|
| **Purpose** | Перевірка locks/daily.lock; якщо lock молодий за TTL → exit 0. |
| **Inputs** | R2 prefix, lock key. |
| **Outputs** | acquired / exit 0. |
| **Storage side-effects** | R2 `legislation/DocListDB rada gov updater log/locks/daily.lock`. |
| **Dependencies** | R2. |
| **Secrets & Config** | R2_PREFIX. TTL: Не описано в документації (конкретне значення годин/хв). |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Exit code 0 якщо skip. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [O1y] R2 Run Record
| Поле | Значення |
|------|----------|
| **Purpose** | Run report у R2 runs/<run_id>.json. |
| **Inputs** | run_id, stats, changed examples, truncated errors. |
| **Outputs** | JSON у R2. |
| **Storage side-effects** | R2 `.../runs/<run_id>.json`. |
| **Dependencies** | R2. |
| **Secrets & Config** | R2_PREFIX. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Structured logs, run report. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [O1z] R2 State Checkpoint
| Поле | Значення |
|------|----------|
| **Purpose** | Persistent state state.json (Last-Modified, last run timestamps). |
| **Inputs** | State object. |
| **Outputs** | state.json у R2. |
| **Storage side-effects** | R2 `.../state.json`, state.json.tmp.runId. |
| **Dependencies** | R2 (UpdaterDB state.ts). |
| **Secrets & Config** | R2_PREFIX. |
| **Failure Modes** | Не описано в документації. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Не описано в документації. |
| **Test Hooks/Injectables** | Не описано в документації. |

### [O2] Fetch Act List
| Поле | Значення |
|------|----------|
| **Purpose** | Список нових/змінених актів з Rada registry. |
| **Inputs** | Опц. дата останнього оновлення; Rada API. |
| **Outputs** | Список rada_nreg, метадані. |
| **Storage side-effects** | Ні. |
| **Dependencies** | Rada Registry API (r.txt, nn, backstop n). |
| **Secrets & Config** | RADA_API_URL. |
| **Failure Modes** | 502/timeout → завершення без оновлень. |
| **Retries/Timeouts** | 1 повтор; таймаут 10–15 с. |
| **Observability** | Лог Fetched X acts. |
| **Test Hooks/Injectables** | Mock JSON; offline simulation. |

### [O3] Download New Acts
| Поле | Значення |
|------|----------|
| **Purpose** | Завантаження сирих текстів карток /laws/card/<nreg>.json. |
| **Inputs** | Список з O2. |
| **Outputs** | Raw JSON карток. |
| **Storage side-effects** | Опц. tmp. |
| **Dependencies** | Rada API. |
| **Secrets & Config** | Не описано в документації. |
| **Failure Modes** | Окремий акт 404 → skip; жоден — порожній результат. |
| **Retries/Timeouts** | 1–2 повтори на акт; timeout ~10 с на документ. |
| **Observability** | Лог Downloaded act nreg. |
| **Test Hooks/Injectables** | Multi-format test; missing act 404. |

### [O4] Parse & Gen Embeddings
| Поле | Значення |
|------|----------|
| **Purpose** | Канонічний JSON + embedding 768d для каталогу. |
| **Inputs** | Raw texts з O3. |
| **Outputs** | Canonical JSON, DocVector 768. |
| **Storage side-effects** | Ні. |
| **Dependencies** | OpenRouter 768d, normalize + delta vs Qdrant payload; дедуп retrieve(id=dokid)+scroll. |
| **Secrets & Config** | OPENROUTER_*, QDRANT_*, DOC_EMBEDDING_MODEL, PARSER_CONFIG. |
| **Failure Modes** | Parse fail → skip акт; embedding fail → skip вектор. |
| **Retries/Timeouts** | Embedding retry 1x. |
| **Observability** | Лог Parsed act nreg; метрики. |
| **Test Hooks/Injectables** | Parser unit tests; embedding consistency. |

### [O1] Store Canonical JSON
| Поле | Значення |
|------|----------|
| **Purpose** | Збереження canonical JSON у R2 (DocListDB та LLDBI використовують). |
| **Inputs** | Canonical JSON з O4 або O7. |
| **Outputs** | R2 key legislation/... (canonical/{nreg}.json або category/nreg.json). |
| **Storage side-effects** | R2 bucket. |
| **Dependencies** | R2. |
| **Secrets & Config** | R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_KEY. |
| **Failure Modes** | R2 down → content_stored=false, продовжити. |
| **Retries/Timeouts** | 3 спроби 1с, 2с, 4с; timeout PUT ~5 с. |
| **Observability** | Лог Stored act nreg / Failed to store. |
| **Test Hooks/Injectables** | Integration test R2; idempotence test. |

### [O5] Upsert Metadata
| Поле | Значення |
|------|----------|
| **Purpose** | UPSERT у Supabase legislation_documents. |
| **Inputs** | rada_nreg, назва, статус, content_hash. |
| **Outputs** | Row inserted/updated. |
| **Storage side-effects** | Supabase legislation_documents. |
| **Dependencies** | Supabase. |
| **Secrets & Config** | SUPABASE_SERVICE_ROLE_KEY. |
| **Failure Modes** | DB down → partial fail, лог. |
| **Retries/Timeouts** | 1–2 повтори. |
| **Observability** | Лог Upserted act nreg. |
| **Test Hooks/Injectables** | Integration test; DB failure simulation. |

### [O6] Update Catalog Index
| Поле | Значення |
|------|----------|
| **Purpose** | Upsert вектор 768d у Qdrant legislation-catalog-index. |
| **Inputs** | DocVector 768, payload nreg, назва, категорія. |
| **Outputs** | Point у Qdrant. |
| **Storage side-effects** | Qdrant legislation-catalog-index. |
| **Dependencies** | Qdrant. |
| **Secrets & Config** | QDRANT_URL, QDRANT_API_KEY, CATALOG_INDEX_NAME, VECTOR_SIZE=768. |
| **Failure Modes** | Qdrant down → позначити не проіндексований. |
| **Retries/Timeouts** | 1 повтор 1 с. |
| **Observability** | Лог Qdrant catalog updated / unavailable. |
| **Test Hooks/Injectables** | Integration test Qdrant; Qdrant down test. |

---

## Offline LLDBI Ingestion

### [T6] Import Job Trigger
| Поле | Значення |
|------|----------|
| **Purpose** | Підхоплення завдання імпорту з import_jobs або U8a; старт O7–O12. |
| **Inputs** | Запис import_jobs або admin API. |
| **Outputs** | Запуск O7…O12. |
| **Storage side-effects** | import_jobs status in_progress → done/failed. |
| **Dependencies** | Job runner, Supabase import_jobs. |
| **Secrets & Config** | IMPORT_WORKER_CONCURRENCY, SUPABASE_SERVICE_ROLE_KEY. |
| **Failure Modes** | Воркер не працює — завдання не виконається. |
| **Retries/Timeouts** | Не описано в документації. |
| **Observability** | Лог Import job started; метрики довжина черги. |
| **Test Hooks/Injectables** | Job dispatch test; error path test. |

### [O7] Retrieve Act Content
| Поле | Значення |
|------|----------|
| **Purpose** | Повний текст акта з R2 або Rada; при потребі виклик O1. |
| **Inputs** | rada_nreg; R2 getObject; Rada якщо нема в R2. |
| **Outputs** | Canonical JSON для O8. |
| **Storage side-effects** | Якщо з веб — O1 запис у R2. |
| **Dependencies** | R2, Rada, parser. |
| **Secrets & Config** | R2_*, Rada URL. |
| **Failure Modes** | Ні R2, ні веб — failed, skip O8–O12. |
| **Retries/Timeouts** | R2 3 спроби; веб 1 повтор. |
| **Observability** | Лог Loaded from R2 / Downloaded. |
| **Test Hooks/Injectables** | Existing JSON test; new import test. |

### [O8] Split into Chunks
| Поле | Значення |
|------|----------|
| **Purpose** | Розбиття акта на чанки (~512 токенів / стаття). |
| **Inputs** | Canonical JSON з O7. |
| **Outputs** | Chunks list (текст, nreg, позиція). |
| **Storage side-effects** | Ні. |
| **Dependencies** | Локальний парсер. |
| **Secrets & Config** | CHUNK_SIZE_TOKENS, MAX_CHUNKS_PER_ACT. |
| **Failure Modes** | Нетипова структура — криві чанки; exception — рідко. |
| **Retries/Timeouts** | Немає. |
| **Observability** | Лог Split act nreg into M chunks. |
| **Test Hooks/Injectables** | Basic test 5 статей; large text test. |

### [O9] Embed Chunks
| Поле | Значення |
|------|----------|
| **Purpose** | Embedding 1536d для кожного chunk (OpenAI text-embedding-3-small / ada-002). |
| **Inputs** | Chunks з O8. |
| **Outputs** | Chunks з vectors 1536d, act-level vector. |
| **Storage side-effects** | Ні. |
| **Dependencies** | OpenRouter/OpenAI embed 1536d. |
| **Secrets & Config** | OPENROUTER_API_KEY / OPENAI_API_KEY, EMBED_BATCH_SIZE, LLDBI_EMBED_MODEL. |
| **Failure Modes** | API fail для батчу → retry; content filter → skip chunk. |
| **Retries/Timeouts** | До 3 спроб на батч; timeout ~10 с на батч. |
| **Observability** | Лог Embedded act nreg; метрики час, вартість. |
| **Test Hooks/Injectables** | API integration test; partial fail test. |

### [O10] Update Chunk Index
| Поле | Значення |
|------|----------|
| **Purpose** | Upsert chunk-векторів у Qdrant lexery_legislation_chunks. |
| **Inputs** | Chunks з embedding, payload r2_key, json_path, article_number. |
| **Outputs** | Points у Qdrant. |
| **Storage side-effects** | Qdrant lexery_legislation_chunks. |
| **Dependencies** | Qdrant. |
| **Secrets & Config** | QDRANT_*. |
| **Failure Modes** | Qdrant down → qdrant_status failed_chunks. |
| **Retries/Timeouts** | Пакетний upsert, 1 повтор. |
| **Observability** | Лог Inserted m chunk-vectors. |
| **Test Hooks/Injectables** | Searchability test; Qdrant error simulation. |

### [O11] Update Act Index
| Поле | Значення |
|------|----------|
| **Purpose** | Upsert act-вектора у Qdrant lexery_legislation_acts. |
| **Inputs** | DocVector 1536, payload nreg, title. |
| **Outputs** | Point у Qdrant. |
| **Storage side-effects** | Qdrant lexery_legislation_acts. |
| **Dependencies** | Qdrant. |
| **Secrets & Config** | QDRANT_*. |
| **Failure Modes** | O10 ок, O11 fail — act_vector_indexed=false. |
| **Retries/Timeouts** | 1 повтор. |
| **Observability** | Лог Inserted act-vector. |
| **Test Hooks/Injectables** | Vector consistency test; fail scenario test. |

### [O12] Mark Indexed
| Поле | Значення |
|------|----------|
| **Purpose** | Оновлення legislation_documents: qdrant_status=indexed, content_hash, indexed_at. |
| **Inputs** | rada_nreg, успішність O10/O11. |
| **Outputs** | UPDATE row. |
| **Storage side-effects** | Supabase legislation_documents, import_jobs done/failed. |
| **Dependencies** | Supabase. |
| **Secrets & Config** | SUPABASE_SERVICE_ROLE_KEY. |
| **Failure Modes** | DB down — невідповідність vectors vs indexed; дубльовані індексування. |
| **Retries/Timeouts** | 1–2 повтори, таймаут 10 с. |
| **Observability** | Лог Marked act nreg as indexed/failed_index. |
| **Test Hooks/Injectables** | Consistency test; failure recovery test. |

---

## Питання на уточнення (TBD)

1. **Lock TTL для DocListDB:** конкретне значення TTL (години/хвилини) для `locks/daily.lock` — не описано в документації.
2. **U2a–U2d, U3a, U6a, U8a, U11a–U11d:** окремі timeout/retry/secrets для підблоків не деталізовані в plan/answer.
3. **CanonicalSnippetLoader / R2SnippetLoader:** чи виносити як окремі блоки з власними картками — не визначено.
4. **Hypothesis Builder (plan §7):** не згаданий у answer.md матриці — потрібно визначити ID і контракт.
5. **Поле qdrant_status:** точні значення (not_indexed, indexing, indexed, failed_chunks) — частково згадані, потрібна єдина схема.
6. **R2 key naming LLDBI:** точний шаблон `legislation/{category}/{nreg}.json` — category визначення не описано в одному місці.
7. **IMPORT_FAST_MODE_COUNT:** типове значення (1 або 3) — згадано, але не в одному конфіг-документі.
8. **VERIFIER_MAX_LOOPS:** типове значення (напр. 1) — згадано, не зафіксовано.
9. **StreamEvent schema (A9.1):** повний набір полів state/progress/cost — потрібно звести в один schema.
10. **Outbox table name:** mm_outbox vs brain_outbox — згадано в plan A5, потрібно зафіксувати.
