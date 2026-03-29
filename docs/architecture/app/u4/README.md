# [U4] CacheRAG — Evidence Search (LLDBI + Memory)

Retrieval-вузол Lexery Legal AI Agent. За вхідним `RunRecord` (query + query_profile з U2) витягує **всі релевантні фрагменти законодавства** з LLDBI (Qdrant chunks/acts 1536d) і **пам'ять користувача** (Supabase mm_memory_items). Результати — pointers (`r2_key`, `json_path`), не повні тексти. Писати у Supabase/R2/Qdrant заборонено; тільки read + append `retrieval_trace` до `runs`.

## Документація

| Документ | Опис |
|----------|------|
| [pipeline.md](./pipeline.md) | Детальний опис усіх стадій U4 pipeline |
| [test-results.md](./test-results.md) | Результати тестування, verify suites |
| [decisions/qdrant-search-contract.md](./decisions/qdrant-search-contract.md) | ADR: Qdrant search API, колекції, формат результатів |
| [decisions/embedding-model-compat.md](./decisions/embedding-model-compat.md) | ADR: модель ембедінгу, сумісність з LLDBI індексом |
| [decisions/degraded-policy.md](./decisions/degraded-policy.md) | ADR: non-fatal degraded policy (Qdrant/Supabase down) |
| [decisions/u4-act-taxonomy-store.md](./decisions/u4-act-taxonomy-store.md) | ADR: LLDBI vocabulary cache, TTL, fallback snapshot |
| [decisions/u4-lldbi-vocabulary-fields.md](./decisions/u4-lldbi-vocabulary-fields.md) | ADR: поля vocabulary (category/document_type) |
| [decisions/u4-routing-hints-v4.md](./decisions/u4-routing-hints-v4.md) | ADR: LLDBI soft prior — boost за U2 hints (поточна версія) |
| [decisions/u4-routing-hints-v3.md](./decisions/u4-routing-hints-v3.md) | ADR: попередня версія routing hints |
| [decisions/u4-routing-hints-iteration-v2.md](./decisions/u4-routing-hints-iteration-v2.md) | ADR: ітерація routing hints v2 |
| [decisions/u4-routing-hints-llm-policy.md](./decisions/u4-routing-hints-llm-policy.md) | ADR: LLM planner для routing hints |
| [decisions/u4-selective-llm-rewrite.md](./decisions/u4-selective-llm-rewrite.md) | ADR: query rewrite + multi-query RRF |
| [decisions/u4-evidence-goals-and-fusion.md](./decisions/u4-evidence-goals-and-fusion.md) | ADR: goal splitting v2, family evidence, RRF fusion |
| [decisions/u4-goal-splitting-v2.md](./decisions/u4-goal-splitting-v2.md) | ADR: taxonomy-cluster-based goal decomposition v2 |
| [decisions/u4-llm-retrieval-planner-policy.md](./decisions/u4-llm-retrieval-planner-policy.md) | ADR: LLM retrieval planner tier policy |
| [decisions/u4-hybrid-rescore-and-optional-rerank.md](./decisions/u4-hybrid-rescore-and-optional-rerank.md) | ADR: hybrid rescoring, optional gated reranker |
| [decisions/u4-act-to-article-retrieval.md](./decisions/u4-act-to-article-retrieval.md) | ADR: within-act article retrieval |
| [decisions/u4-query-shaping-and-two-stage-retrieval.md](./decisions/u4-query-shaping-and-two-stage-retrieval.md) | ADR: query shaping, 2-stage retrieval |
| [decisions/u4-act-selection-policy.md](./decisions/u4-act-selection-policy.md) | ADR: act selection policy 3.1 (diversity, caps) |
| [decisions/u4-root-cause-act-article-miss.md](./decisions/u4-root-cause-act-article-miss.md) | ADR: root cause analysis — missing acts/articles |
| [decisions/u4-prod-hardening-v2.md](./decisions/u4-prod-hardening-v2.md) | ADR: prod hardening v2 (OOD guard, noise penalty, selected_acts policy) |
| [decisions/u4-prod-hardening-risks.md](./decisions/u4-prod-hardening-risks.md) | ADR: prod hardening — ризики |
| [decisions/u4-memory-retrieval.md](./decisions/u4-memory-retrieval.md) | ADR: memory retrieval (Supabase mm_memory_items, Phase 1) |

## Код

**Runtime (src):**
- `scripts/lexery-legal-agent/retrieval/types.ts` — TypeScript типи + Zod схеми (RawHit, RetrievalTrace, MemoryRef)
- `scripts/lexery-legal-agent/retrieval/cache-rag.ts` — runCacheRag: головний pipeline (embed → search → score → select → memory)
- `scripts/lexery-legal-agent/retrieval/act-candidate-ranking.ts` — act candidate scoring/ranking (metadata + hits evidence + ACTS-2 fallback)
- Act-candidate ranking now treats a specific U2 domain hint as a compatible family envelope, not only as an exact category string. For soft procedural queries this lets `criminal -> criminal_procedure`, `civil -> civil_procedure/family`, `administrative -> administrative_offenses/civil_procedure_administrative` compete before generic off-family process codes.
- `scripts/lexery-legal-agent/retrieval/hit-ranking.ts` — hybrid ordering, coverage fusion, anti-noise, diversity cap
- `scripts/lexery-legal-agent/retrieval/chunk-rerank.ts` — structural chunk scoring (`ordering_score`, title/article relevance)
- `scripts/lexery-legal-agent/retrieval/structural-citation.ts` — normalized Ukrainian structural citation parsing (`ст./ч./п./пп./абз./примітка`) for query/hit matching; dotted `п.п.` / `ч.ч.` forms are normalized too, and bare note mentions without a note number no longer behave like full explicit selectors
- `scripts/lexery-legal-agent/retrieval/grounded-query-builder.ts` — selector-aware retrieval query shaping that keeps narrow legal signals but strips broad generic widening on already-grounded citation queries
- `scripts/lexery-legal-agent/retrieval/consumer.ts` — handleU4Event: load run, runCacheRag, persist trace, emit metrics, enqueue U5
- `scripts/lexery-legal-agent/retrieval/qdrant-client.ts` — Qdrant search, timeout + 1 retry
- `scripts/lexery-legal-agent/retrieval/embedding.ts` — embedQuery (OpenRouter OPENROUTER_API_KEY_ONLINE, 1536d)
- `scripts/lexery-legal-agent/retrieval/selected-acts.ts` — act selection policy (evidence, family guard, anti-order dominance)
- `scripts/lexery-legal-agent/retrieval/act-taxonomy-store.ts` — LLDBI vocabulary cache (TTL + fallback snapshot), including exact structured act identifiers (`2811-20`, `115/2015`, `100-95-п`, `v0003359-26`) as first-class taxonomy signals
  and grounded exact alias/title matches (`ЦПК`, `КУзПБ`, `Закон 1023-12`, `Постанова 1178`) as a separate signal class from fuzzy alias-hit volume
  including logical-family convergence for split indexed acts, so one compact alias like `КУпАП` can still ground to one legal act family even when LLDBI stores it as several `rada_nreg` slices
  and stable quoted-title extraction for explicit law-title queries, including short official titles like `Про медіацію`, so repeated runtime calls do not randomly lose strict act-title grounding
  and broad non-primary decision-envelope compatibility (`урядове рішення`, `акт Кабміну`, `рішення уряду`) when cue + title/number identity still converge to one indexed subordinate act
  and a unique in-force successor preference inside one logical same-title act family when a soft current-law title query does not pin a historical document number/date
- `scripts/lexery-legal-agent/retrieval/single-goal-selected-acts.ts` — single-goal act-scope honesty/recovery: when a query grounds to one exact or title-grounded act, final `selected_acts` must stay inside that act scope or fall back to low-confidence instead of leaking unrelated writer context
- `scripts/lexery-legal-agent/retrieval/single-goal-act-scope.ts` — isolated explicit/grounded single-act scope enforcement and recovery (`EXACT/GROUNDED/METADATA_ACT_SCOPE_*`), extracted from single-goal selected-acts policy so generalized scope drift can be tested without re-reading the whole single-goal state machine
- `scripts/lexery-legal-agent/retrieval/single-goal-final-honesty.ts` — late low-confidence normalization for single-goal runs: fragmented or out-of-scope weak-evidence selections are narrowed to one plausible primary law at most, otherwise cleared before `coverage_gap` is derived
- The same late honesty layer now preserves one dominant domain-aligned procedural code when chunk evidence clearly converges there, instead of clearing `selected_acts` to empty only because weaker same-query tails still exist. This is important for soft `ЄРДР` / complaint / jurisdiction queries where one code is clearly leading but the surface wording still attracts neighboring procedure codes.
- Late single-goal honesty now also has a bounded `SOFT_PROCEDURAL_SINGLE_ACT_CONFIRMED` path: if one procedural `PRIMARY_LAW` remains after narrowing, dominates top-30 evidence, stays domain-aligned, and the query is not explicit act-scope, runtime may normalize that run back to `coverage_gap=none` instead of leaving a false `weak_evidence` tail caused only by neighboring process-code noise.
- `scripts/lexery-legal-agent/retrieval/goal-splitter.ts` — taxonomy-cluster goal splitting v2
- `scripts/lexery-legal-agent/retrieval/act-planner.ts` — LLM retrieval planner (tier 0/1/2)
- `scripts/lexery-legal-agent/retrieval/query-rewriter-llm.ts` — LLM query rewrite + multi-aspect variants
- `scripts/lexery-legal-agent/retrieval/query-rewrite-policy.ts` — cheap guardrail for when rewrite must be skipped on already-anchored structural legal queries
- `scripts/lexery-legal-agent/retrieval/single-goal-first-pass.ts` — single-goal initial step planning + first-pass chunks/acts search with shared strong-taxonomy policy
- `scripts/lexery-legal-agent/retrieval/single-goal-hit-postprocess.ts` — single-goal postprocess pipeline (ordering, noise/diversity, reference expansion, article backfill, final cap)
- `scripts/lexery-legal-agent/retrieval/rrf-merge.ts` — RRF merge для multi-query
- `scripts/lexery-legal-agent/retrieval/reference-expander.ts` — reference expansion (згадані акти/статті → додаткові hits)
- `scripts/lexery-legal-agent/retrieval/within-act-expansion-policy.ts` — policy module for when strong/structural/procedural single-goal queries still deserve wider per-act fanout
- `scripts/lexery-legal-agent/retrieval/lldbi-vocabulary.ts` — vocabulary helper (categories/document_types)
- `scripts/lexery-legal-agent/retrieval/memory-store.ts` — fetchRecentMemory (Supabase mm_memory_items, Phase 1)
- `scripts/lexery-legal-agent/retrieval/r2-fragment.ts` — R2 fragment fetcher (for within-act retrieval)
- `scripts/lexery-legal-agent/retrieval/llm-planner.ts` — LLM planner util
- `scripts/lexery-legal-agent/retrieval/routing-hints-llm.ts` — LLM routing hints (U2→U4 bridge)

**Tools (не входять в runtime):** → `scripts/lexery-legal-agent/tools/u4/`
- `query_retrieval_debug.ts` — ad hoc retrieval debugger для довільного юридичного запиту (`selected_acts`, top hits, reason_codes, qdrant_calls) у retrieval-focused harness
- `audit_lldbi_act_coverage.ts` — broad LLDBI act-surface audit: бере багато indexed актів із `legislation_documents`, будує cheap act-centric probes і перевіряє, чи U4 взагалі стабільно піднімає target act поза curated golden cases; `--probe-mode=generalized` додатково ганяє `nreg + alias + anchored_title + title_fragment`, а за наявності cue-патернів ще й `document+№number`. Скрипт тепер підтримує shard-friendly `--report-path`, atomic checkpoint writes, strict `--resume` validation і пише `failure_mode_summary` (`retrieval_miss`, `selection_drift`, `honesty_fail`, `trace_anomaly`) для broad surface clustering
- `verify_lldbi_absent_present.ts` — absent→present live harness: перевіряє honest `likely_missing_act/weak_evidence` pre-state, викликає LLDBI admin CLI (`add` → `verify --write-health` → `audit-qdrant-payload`), а потім підтверджує grounded post-state на тих самих query families. Presence detection тут retrieval-surface-first: `rada_nreg` variants normalізуються, а stale cases з legacy case-variant Qdrant payload не маскуються під справжній missing-act benchmark. Для soft current-law queries verifier також підтримує successor-aware expectations через `acceptable_post_selected_acts`, коли post-state має grounded-ити current in-force successor, а не historical predecessor. Post-check тепер також вимагає, щоб lead `selected_act` входив у очікуваний набір.
- `run_final_manual_audit.ts` — batch manual audit для soft production-style юридичних питань. Для warm/lawyer-style smoke runs без прямого `за законом X` використовуйте `_datasets/soft_legal_prod_queries_2026_03_29.json`; цей pack добре висвітлює `law+bylaw`, `code+procedure`, `law+KSU`, `bylaw+bylaw` і honest `likely_missing_act` surface. Для ширшого lawyer-style prod audit є ще `_datasets/soft_legal_prod_queries_subagent_2026_03_29.json` з природними питаннями по `ККУ+КПК`, `ПКУ+КАСУ`, `СКУ+ЦКУ`, `КЗпП+підзаконка`, `КУпАП` та змішаних public-law bundles.
- Для soft absent→present live runs окремо тримайте wording-diverse packs без прямого `за законом X`: наприклад date-scoped NBU acts, CMU amendment/bylaw locators, soft current-law locators. Це потрібний rehearsal для майбутнього DocListDB orchestration, де користувач спершу ставить природне питання, а не знає `rada_nreg`.
- Окремо корисний mixed-issuer live pack (`lldbi_absent_present_diverse_live_2026_03_28_cases.json`): він перевіряє той самий truthful corpus-gap → ingest → grounded-retrieval path на `НБУ`, `КМУ`, внутрішніх актах Голови ВРУ та президентських personnel acts, щоб missing-act сценарій не лишався протестованим лише на одному типі документа.

## Поточний refactor напрямок

- `cache-rag.ts` лишається orchestration layer, а не місцем для всіх scoring/policy деталей.
- Single-goal first-pass уже винесений окремо: `cache-rag.ts` не повинен сам збирати initial chunks/acts plan, policy skip для eager `lldbi_acts`, або перший Qdrant fanout inline.
- Single-goal hit postprocess теж окремий: ordering/noise/diversity, reference expansion, article backfill і final cap більше не мають жити inline у `cache-rag.ts`.
- Multi-goal per-goal retrieval тепер теж користується тим самим `within-act` policy layer, а не сліпим `top-5 acts per goal` fanout. Це зменшує Qdrant cost на змішаних substantive+procedure queries без hardcode по конкретних кодексах.
- Ranking/pipeline post-processing виноситься в окремі retrieval-модулі, щоб безпечніше тюнити quality/latency без ризику змішати orchestration, data access і ranking policy в одному файлі.
- Within-act act-pool assembly винесений в окремий retrieval-модуль, щоб single-goal і multi-goal paths збирали один і той самий ranked pool актів без дублювання `lldbi_acts` search у середині `cache-rag.ts`.
- Act ranking тепер окремо поєднує LLDBI metadata signals і retrieval evidence з фінальних hits: сильні ранні article hits можуть підняти правильний акт навіть коли U2 domain hint помиляється.
- Будь-який новий ranking signal має проходити через окремий модуль і regression verify (`rag-units`, `rag-golden`, `retrieval-real-dev`), а не додаватися inline в orchestration flow.
- Для простих двоклаузних legal queries (`X та Y`) U4 тепер покладається на дешевий structural multi-goal split із shared-tail carry-over, а не на обов'язковий LLM planner override; це зменшує latency/cost і прибирає planner-induced шум у procedural queries.
- Для procedural follow-up queries U4 тепер робить дешеве semantic shaping без нових LLM calls: переносить shared subject у follow-up clause (`цю статтю` → предмет першого питання) і додає must-have procedural concept signals на кшталт `підслідність` або `початок досудового розслідування`, коли вони випливають зі змісту питання.
- Для same-act norm bundles (`де шукати норму про X і норму про Y`, `з яких норм це збирається`) heuristic splitter тепер може згорнути bare `і/та` split назад у single-goal через `same_act_bundle_compaction`, щоб bundles одного кодексу не заходили в дорогий multi-goal path без реальної потреби.
- Для multi-goal retrieval старий fanout `2 first-pass searches + up to 5 per-act filtered searches на кожну підціль` більше не є дефолтом. Per-goal within-act pool стискається через generic policy (`procedure`, `must_have_signals`, structural selectors, grounded act scope), тому змішані legal bundles типу `матеріальна норма + підслідність/процедура` можуть зберігати coverage при значно меншому `qdrant_calls`.
- Але така compaction тепер дозволена лише коли query справді має один сильний act-scope cue. Mixed bundles на кшталт `закон + постанова №...` більше не згортаються назад в один procedural goal лише тому, що в тексті є `і/та`.
- Retrieval trace тепер має нормалізований `coverage_gap = none | weak_evidence | likely_missing_act | out_of_scope`. Це окремий LLDBI-first honesty contract для U5/U10: weak evidence і likely-missing-act більше не повинні виглядати як нормальний успішний retrieval.
- Для explicit-act legal queries, де потрібний акт ще не проіндексований у LLDBI, U4 має віддавати truthy path, а не псевдо-grounded success: `low_confidence=true`, `coverage_gap=likely_missing_act`, reason codes на кшталт `EXPLICIT_ACT_SCOPE_NO_CONVERGENCE` / `NO_STRONG_ACT_EVIDENCE`.
- Short explicit act-number references (`ПКМ №100`, `постанова КМУ №1178`, `наказ МОЗ №385`) тепер входять у structural cue path і не повинні самі по собі запускати `ambiguity_hard` / doclist fanout на LLDBI-first runs.
- Broad LLDBI coverage audits запускаються з `DOCLIST_ENABLED=false`, а best-mode PASS більше не допускає selected-act success з `low_confidence=true` чи `coverage_gap!=none`; такі кейси тепер падають як `honesty_fail`.
- Навіть ранній degraded-path до Qdrant search тепер зобов'язаний бути чесним: якщо single-goal retrieval зупинився ще на embedding/no-vector stage, trace не може лишитися з `hits=[]`, `low_confidence=false`, `coverage_gap=none`. Для таких run-ів runtime нормалізує `low_confidence=true`, `coverage_gap=weak_evidence`, `reason_codes+=DEGRADED_LLDBI`.
- У broad `best`-mode harness більше не довіряє слабким boilerplate alias-ам для repeal/amendment/service acts. Якщо alias не несе надійної identity самого indexed акту або відсилає до чужого numeric stem, audit падає назад до власного `nreg`, щоб корпусний sweep міряв реальну act recovery, а не випадковий alias шум.
- Missing-act / coverage-gap reason codes тепер sticky для single-goal finalization: routing hints або family-level recovery більше не мають права знімати `low_confidence`, якщо retrieval так і не отримав реального act-level grounding.
- Це вже перевірено на `2811-20` (`Про авторське право і суміжні права`): до ingest direct copyright-law query переходив у `likely_missing_act`, після LLDBI CLI ingest того самого акту retrieval стабільно заякорився на `2811-20` без artificial expand path.
- `goal-splitter` тепер краще працює з українським процедурним follow-up формулюванням і словами з апострофом: same-source queries типу `як зареєструвати ... і які документи подаються` не повинні розвалюватися на fake multi-goal лише через `і` або через пошкоджений subject focus (`комп'ютерну` тощо).
- U2 compact grounding тепер може заякорювати короткий LLDBI-first query не лише exact alias-ом, а й через унікальний `title fragment`, якщо taxonomy однозначно сходиться до одного indexed акту. Це потрібно для descriptive subordinate-act titles без зайвого LLM/doclist fanout.
- Якщо query не має явного structural cue, але LLDBI hints already показують правову surface (`categories_ranked_top3` / `document_types_ranked_top3`), U2 більше не залишає такий run у випадковому `context_mode=memory`. Soft legal questions з LLDBI hints стабілізуються назад у `law` або `mixed`, щоб retrieval не втрачав LLDBI entirely через routing drift.
- Для explicit descriptive act-scope queries без exact grounding (`яким розпорядженням...`, `яким наказом...`) within-act act pool тепер лишається taxonomy-led навіть на strong first pass. Це не дає ранньому chunk noise витіснити taxonomy top candidate ще до filtered same-act search.
- Для already-grounded citation queries (`КПК ст. 214`, `п. 21 Правил...`, `пп. 14.1.175 ПКУ`) grounded-query builder більше не додає broad procedural widening на кшталт `строк`, `порядок`, `подання`; лишаються тільки вузькі signals, які реально допомагають article competition.
- Для explicit structural citation queries (`ч./п./пп./абз./примітка` + act/title cue) U4 тепер не пускає LLM query rewrite в default path: такі запити вже достатньо заякорені, а rewrite тільки роздував latency/cost і міг породити fake multi-goal retrieval.
- Для grounded citation bundles на кшталт `ККУ ст. 190 ... та підслідність` heuristic splitter тепер залишає mixed substantive+procedure split лише за наявності справді сильного procedural cue (`підслідність`, `оскарження`, `ЄРДР`, `документи подаються`), а не через будь-які слова на кшталт `строк` чи `порядок`. Це прибирає false multi-goal fanout на selector-heavy same-act queries.
- `act_metadata_bundle_compaction` тепер теж вузький: він дозволений лише коли одна clause реально шукає сам акт (`яким наказом/розпорядженням/...`), а інші clauses є чистими metadata follow-up (`хто прийняв`, `коли набрало чинності`), а не окремими procedural remedies на кшталт `як оскаржити`.
- Для single-goal runs із уже сильним LLDBI/taxonomy signal (`taxonomy_act_count`, `alias_hits`, category/doc-type hints) U4 теж не викликає query rewrite: якщо correct act family already grounded by metadata, дешевший deterministic path кращий за ще один LLM hop.
- Query rewrite variants тепер не можуть тихо потрапити в multi-query retrieval, якщо rewrite офіційно `used=false`; runtime і trace мають збігатися, інакше verifier втрачає чесний cost/behavior audit.
- Structural citation parsing у runtime тепер Cyrillic-safe: `пунктом 12`, `підпункт 6`, `примітка до статті`, `частина 1` мають витягуватись так само стабільно, як `ст. 115`, без ASCII-only boundary bugs.
- `goal-splitter` більше не розриває anchored citation queries лише через сполучник `і/та`, якщо в запиті вже є явні structural selectors; це прибирає false multi-goal fanout для point/title queries по підзаконних актах.
- Contrastive liability queries більше не розщеплюються на зайвий broad prefix-goal поверх `адміністративна vs кримінальна`; heuristic split тепер віддає компактні aspect-goals, щоб не множити Qdrant work і coverage noise.
- `ActTaxonomyStore` тепер використовує не лише alias/token matching, а й phrase-level LLDBI metadata (`title`, `summary`, `keywords`, `topics`, `aliases`, `validity_status`) для дешевшого й точнішого act candidate generation без hardcoded act lists.
- Evidence-only act recovery більше не додає акти як беззмістовний `chunks_evidence_meta` tail із нульовим score: backfill path пропускає такі акти через той самий metadata scorer (`title/summary/keywords/topics/validity`), тому final act-scope policy бачить реальний semantic signal, а не просто факт появи в top hits.
- Для document-type hints runtime тепер падає назад з `document_type` на `document_type_slug`, якщо human-readable type не збігається з U2 hint normalization.
- `selected_acts` тепер жорсткіше відсікає weak cross-family acts: окремо для support candidates і для chunks-evidence tail, щоб multi-act retrieval не засмічував writer випадковими актами лише через vector overlap.
- Generic document-type hints більше не можуть самі по собі проштовхнути support act у звичайний `selected_acts` tail; hint-only fallback лишається лише для мінімального recovery path.
- `selected_acts` оцінює не лише `count_in_top30`, а й ранню силу evidence (`best_rank_in_top30`, `rank_mass_top30`, `max_ordering_score`), тому сильна релевантна норма з невеликою кількістю hits не губиться за шумним хвостом.
- Для single-goal first pass `lldbi_acts` більше не є обов'язковим default call: якщо taxonomy already дає сильний grounded signal (`taxonomy_act_count`, `alias_hits`, category/doc-type hints), runtime може пропустити eager acts-search і покластися на taxonomy + chunk evidence.
- Якщо step-plan явно просить `lldbi_acts` без `lldbi_chunks`, такий acts-only path вважається авторитетним і не може бути тихо прибраний strong-taxonomy gate-ом.
- Strong taxonomy support тепер нормалізований спільним helper-правилом і використовується консистентно в різних policy точках U4, а не дублюється локальними умовами в rewrite/search flow.
- Для procedural-dominant traces secondary-order support потребує не лише repeated chunk evidence, а й family/hint alignment; це прибирає чужі постанови/накази з кримінально-процесуальних trace без втрати корисних support-order cases.
- Family coverage guard тепер evidence-driven: він не має права додати PRIMARY_LAW акт лише за family/category fit, якщо у final retrieval head немає material chunk evidence. У таких випадках trace має показати `FAMILY_GUARD_NO_EVIDENCE`, а не вдавати complete legal coverage.
- Для multi-goal policy `selected_acts` більше не згортає все до одного акта, якщо другий ранній `PRIMARY_LAW` із іншої legal family уже має матеріальний chunk evidence; це важливо для substantive+procedure кейсів на кшталт `ККУ + КПК`.
- Goal-based multi-goal coverage у `selected_acts` тепер використовується як сильний signal, але не як абсолютна істина: якщо `goal_support_by_act` частковий і не покриває всі selected primary acts, policy не повинна штучно занижувати confidence або ставити `COVERAGE_MISS_SELECTED_ACTS` лише через неповний support map.
- Коли multi-goal query уже покритий двома сильними `PRIMARY_LAW` актами, weak `KSU_DECISION` / `CASELAW_OPINION` / `BILL_DRAFT` хвіст більше не повинен повертатися в `selected_acts` через diversity guard; writer має бачити юридично корисні primary acts, а не випадковий caselaw noise.
- Для weak multi-goal traces один сильний `PRIMARY_LAW` тепер може ще жорсткіше відсікати слабкий non-primary tail (`INTERNATIONAL_TREATY`, `SECONDARY_ORDER`, `KSU_DECISION`, `CASELAW_OPINION`) коли той не має explicit source-class hint і не несе власного material evidence. Це generalized anti-noise policy, а не per-act whitelist.
- `document_type_slug` тепер впливає не лише на `act_kind`, а й на hint-based selection policy: slug-only treaties, draft laws та інші structurally typed акти не повинні випадати з `selected_acts` лише тому, що людський `document_type` у metadata порожній.
- У ранньому head retrieval діє article-level diversity cap: top portion видачі не повинна забиватися кількома chunks з одного й того ж `rada_nreg + article_number`, щоб same-act multi-article retrieval був ширшим і кориснішим для writer.
- Single-goal within-act retrieval більше не виконується за замовчуванням на кожному strong run. U4 тепер вмикає per-act fanout для weak first-pass або explicit structural / act-anchored queries, що помітно зменшує latency та Qdrant call budget на generic high-signal питаннях.
- Within-act fanout policy тепер окремо тримає structural/procedural hard cases: навіть на strong first pass такі query можуть отримати ширший per-act pool, якщо same-act article competition інакше надто вузький.
- Але якщо first-pass already має strong same-act consensus (`grounded/explicit act scope` + repeated chunk evidence по тому самому head акту), within-act policy тепер стискає fanout до одного акту і зменшує `chunks-per-act` budget замість сліпого `top-2/top-3`. Це generic cost guard, а не rule під конкретні кодекси.
- У single-goal procedural path taxonomy act pool тепер теж пріоритизує procedure-family акти, щоб КПК/ЦПК/ПКУ статті не губилися за substantive-code noise лише через загальні слова в запиті.
- Після routing hints існує окремий final selected-acts gate: late-added acts без retrieval evidence можуть бути видалені ще до writer handoff, а confidence піднімається тільки коли recovery реально підтверджений trace.
- У golden evaluation dataset тепер більше кейсів з same-act multi-article, substantive+procedure та large-code procedural competition, щоб regression ловив не лише прості `ККУ/КУпАП` запити, а й цивільно-процесуальні, податкові, сімейні та банкрутні сценарії.
- У single-goal режимі `selected_acts` тепер може зберегти один сильний secondary supporting act, якщо він має повторний chunk-evidence у top-30; це прибирає false negative для practical-order cases на кшталт повернення товару.
- У multi-clause запитах, де один кодекс явно покриває обидві частини питання, `selected_acts` більше не зобов'язаний добирати другий акт лише через `goals_count >= 2`; це прибирає procedural noise у same-act cases на кшталт банкрутства.
- Для single-goal runs honesty guard тепер має ловити ще й fragmented `PRIMARY_LAW` selection: коли видача розвалюється на кілька різних family без metadata grounding, або head family суперечить конкретному `domainHint`, trace має переходити в low-confidence замість удавано впевненого `none`.
- Corpus hygiene теж є частиною retrieval quality: якщо в LLDBI/Qdrant payload відсутні `chunk_title`, `unit_type`, `article_number` або висять старі `content_hash` версії, structural rerank у U4 втрачає точність навіть коли правильний акт уже є в корпусі.
- Для structural legal retrieval runtime тепер очікує не лише `article_number`, а й глибші payload selectors (`article_part_number`, `point_number`, `subpoint_number`, `paragraph_number`, `citation_path`, `unstructured_fallback`); без цього українські `п./пп./ч.` запити неминуче деградують у noisy semantic search.
- Exact act identifiers тепер є окремим retrieval signal class, а не побічним ефектом tokenization: короткі `nreg`/`v...`/`...-п`/`...-р` queries мають зберігати identifier у taxonomy/query-shaping path, конвергувати в один grounded act і не породжувати зайві rewrite/fanout кроки лише через “поганий embedding” короткого рядка.
- Short exact act aliases/titles тепер теж не прирівнюються до fuzzy alias-volume. Якщо query або extracted `law_title`/`act_abbrev` точно зводиться до одного акту (`ЦПК`, `Постанова 1178`, `закон 1023-12`), U4 має трактувати це як grounded act support, а не як слабкий bag-of-aliases сигнал.
- Це саме правило тепер поширюється і на split logical acts: якщо compact alias однозначно вказує на один юридичний акт, але LLDBI/Qdrant зберігають його кількома indexed частинами, taxonomy still може дати один grounded family signal замість фальшивого `weak_evidence`.
- Для repeal/revocation style titles runtime також виводить compact derived aliases із самої назви акта (`розпорядження про втрату чинності № 1478`, `постанова про втрату чинності № ...`), якщо title явно каже `визнання таким/такими, що втратило(и) чинність`. Це не ручний список актів, а generic legal-title normalization для підзаконки.
- Grounded single-act alias/title queries тепер не повинні запускати taxonomy-cluster multi-goal split лише через шум у category alias-hits. Якщо taxonomy already converges to one exact/grounded act, U4 лишається в single-goal path і тримає цей act scope до фінального `selected_acts`.
- Якщо explicit subordinate-act query уже grounded до одного акту, але chunk head усе ще шумний, single-goal finalizer може відновити сам act у `selected_acts` із taxonomy grounding. Це прибирає фальшиве `likely_missing_act` у випадках, де акт реально є в LLDBI, але semantic chunk head ще не встиг піднятись вище за подібні repeal/amendment titles.
- У multi-goal queries з міксом substantive + procedure один процесуальний кодекс більше не може автоматично вважатися “повним покриттям” лише через сильний chunk head. Якщо single-act coverage тримається тільки на ungrounded procedural primary law, runtime переводить run у honest low-confidence / corpus-gap semantics замість удаваного success.
- `article-backfill` тепер має two-step recovery path: спершу пробує exact structural Qdrant filter, а коли cluster не має індексу на кшталт `point_number`, падає назад до вузького within-act search + local structural post-filter. Це робить runtime стійкішим до LLDBI/Qdrant index drift без окремого hotfix per act.
- Для великих підзаконних актів одного `point_number` недостатньо для “Harvey-like” точності: в одному наказі може існувати кілька різних `п. 12`. Якщо LLDBI не зберігає ієрархію (`citation_path`, chapter/section labels, act_part_label), U4 зможе знайти правильний номер пункту, але не завжди однозначно відрізнить потрібний контекст усередині акту.
- Для explicit single-act identifier queries (`1150-98-п`, `1-2026-р`, `v0003359-26`) selected-acts policy тепер має окремий exact-act scope path: якщо retrieval стабільно зійшовся до одного конкретного акту, U4 не повинен домішувати noise-tail або занижувати confidence лише тому, що акт є `SECONDARY_ORDER`, а не `PRIMARY_LAW`.
- Це ж правило поширюється на compact grounded single-act queries по exact alias/title: якщо short query уже сходиться до одного конкретного підзаконного акту (`Постанова 1178`), writer не має отримувати фальшивий `weak_evidence` лише через `SECONDARY_ORDER`.
- Якщо explicit subordinate-act query дає сильний same-act head (`best_rank<=2`, repeated top-30 chunk evidence, high selected-acts confidence), single-goal finalizer тепер обрізає слабкий non-primary tail до одного lead акту і нормалізує run назад у `coverage_gap=none` замість false `weak_evidence`.
- Якщо explicit subordinate-act query заданий у формі `документ + №номер` без повного `rada_nreg` (`постанова №1178`, `наказ Мінфіну №1257`), taxonomy тепер трактує це як grounding signal лише тоді, коли cue типу акта + достатньо специфічний numeric stem однозначно мапляться на один indexed акт. Короткі або двозначні bare-number references не повинні маскуватися під grounded success.
- Якщо grounded single-act query усе ж приносить шумний top-hit head з іншого акту, single-goal finalizer тепер має спершу спробувати відновити grounded act через власний chunk evidence у top-30, а вже потім позначати `low_confidence`. Це generic guard від false-confident explicit subordinate-act drift.
- Те саме recovery правило тепер покриває і metadata-grounded descriptive subordinate acts: якщо query already grounded через `exact_alias_match` або `exact_title_match`, а same-act evidence лишилося нижче шумного `PRIMARY_LAW` head, finalizer може відновити цей акт за generic rank/order thresholds замість фальшивого `likely_missing_act`.
- Якщо grounded single-act query містить змішаний substantive+procedure bundle, `single-goal-act-scope` може зберегти один supporting procedural `PRIMARY_LAW`, але лише за сильних procedural bundle cues і власного retrieval evidence. Generic deadline/process wording (`строк`, `термін`, `порядок`) саме по собі більше не дає права домішувати чужий кодекс у `selected_acts`.
- Якщо structural query already grounded до одного акту (`КПК ст. 214`, `Постанова №1178 п. 44`), within-act policy більше не зобов'язаний розширюватися до широкого `top-4/top-5` act pool лише через сам факт explicit selector. Grounded structural single-act runs переходять у cheap fanout path і не платять зайві Qdrant calls за чужі акти.
- Metadata act-scope recovery більше не залежить лише від exact alias/title equality. Якщо query містить сильний act-reference signal, а taxonomy candidate має `title_match` і достатній token overlap між act-reference fragment та `document_type + title`, single-goal policy може підтвердити grounded subordinate act без per-act hardcode.
- Але цей metadata-grounding path тепер спеціально відсікає boilerplate repeal/locator wording (`визнано таким, що втратив чинність...`) без distinct subject tokens. Інакше система надто легко купує false single-act convergence на класі схожих наказів/розпоряджень.
- Те саме taxonomy grounding тепер покриває і довгі official-title locators для підзаконки: якщо query майже повторює повний `document_type + title`, але випускає службові слова або скорочує стандартний legal tail, phrase-window overlap все одно може звести його до одного indexed акту без broad semantic fallback.
- Single-goal honesty path тепер окремо блокує `metadata companion` substitute bundles: якщо без exact/grounded act convergence один broad `PRIMARY_LAW` підтягнув лише metadata/taxonomy companion, runtime не має трактувати таку пару як нормальний grounded success і переводить run у low-confidence / coverage-gap semantics.
- Після такого long-title grounding within-act policy трактує query як descriptive act-title scope. Тобто U4 більше не втрачає правильно grounded subordinate act лише тому, що в wording немає `№...` або короткого alias; same-act fanout лишається cheap і bounded, доки chunk evidence не спростує grounding.
- Для цього самого класу query runtime тепер не завжди скіпає `lldbi_acts` лише через `STRONG_TAXONOMY_SIGNAL`. Long descriptive title-locator може отримати один cheap acts-search pass, щоб у final hits з’явився сам grounded act, а не тільки семантично схожі статті з інших актів.
- Hybrid rerank після цього окремо підсилює grounded `lldbi_acts` hit того ж акту. Це generalized правило для act-locator retrieval context: якщо taxonomy already зійшлася на одному indexed акті, writer повинен побачити цей act-level candidate раніше за тематичний noise з кодексів.
- Shared descriptive-title classifier тепер використовується не лише в U4 split/grounding, а й у cheap U2 act enrichment: title-fragment lookup більше не запускається для довільного довгого natural-language query, а тільки для реальних title-locator / interrogative act-locator форм. Це зменшує випадкове metadata-grounding drift ще до retrieval stage.
- Якщо grounded single-act query не змогла відновити жодного `selected_act` після scope trim, trace більше не може лишитися у `coverage_gap=none`: runtime ставить `GROUNDED_ACT_SCOPE_NO_CONVERGENCE` / `EXACT_ACT_SCOPE_NO_CONVERGENCE` і переходить у honest low-confidence path. Але це вже не автоматичний `likely_missing_act`: коли taxonomy реально grounded-ила indexed акт, normalized `coverage_gap` має лишатися `weak_evidence`, щоб оркестратор не трактував внутрішній selection drift як доказ відсутності акту в LLDBI.
- Якщо юридично конкретний single-goal query зводиться лише до процесуального `PRIMARY_LAW` без act grounding (`exact/grounded act hits = 0`, metadata grounding теж немає), runtime більше не повинен трактувати це як достатнє покриття. Такий path переходить у `low_confidence=true` з `NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY` і далі мапиться в `coverage_gap=likely_missing_act`.
- Але soft interrogative primary-law locator queries (`який спеціальний закон...`, `який профільний закон...`) не прирівнюються до strict missing-act proof лише через сам факт `закон`-cue. Якщо retrieval уже дав один домінантний `PRIMARY_LAW` із сильним same-act evidence і без real scope-conflict, late honesty layer може підтвердити його назад через `INTERROGATIVE_PRIMARY_LAW_LOCATOR_CONFIRMED` замість штучного `likely_missing_act`.
- Для calendar-scoped recurring acts (`на 26 березня 2026 року встановлено...`) honesty path тепер симетричний: якщо query містить явну дату, а retrieval бачить кілька сусідніх однотипних daily acts без унікальної convergence, U4 не має права підміняти їх broad standing regulation/положенням. Такий run переходить у low-confidence / `likely_missing_act`, щоб оркестратор міг чесно перейти до DocListDB import path.
- Але якщо calendar-scoped recurring query має одну унікальну LLDBI identity-convergence (`rada_datred_match`, `rada_month_match` або `document_number_match`) і той самий candidate підтриманий раннім chunk evidence, U4 тепер може підтвердити цей daily/non-primary act як grounded success. Це дозволяє щоденним серіям НБУ та подібним recurring актам проходити cheap single-goal path без broad framework fallback.
- Те саме правило тепер покриває і широкий legally-specific noise path без grounded акту: якщо фінал тримається лише на слабких `SECONDARY_ORDER`/інших non-primary tails, `selected_acts_confidence` низька, а `NO_PRIMARY_LAW_EVIDENCE + NON_PRIMARY_ONLY_WEAK_CONFIDENCE` спрацювали без `exact/grounded/metadata` convergence, normalized `coverage_gap` має переходити в `likely_missing_act`, навіть коли hits count формально великий.
- Для truly weak/out-of-scope single-goal runs U4 більше не повинен зберігати випадковий multi-family writer tail лише “аби щось було”. Late honesty layer або звужує `selected_acts` до одного domain-aligned `PRIMARY_LAW`, або очищає список повністю, щоб downstream orchestration бачила чесний weak-evidence / missing-coverage сигнал.
- `verify_rag_golden` і strict mode у `verify_retrieval_real_dev --article-rank` тепер ловлять не лише family coverage, а й article/rank misses, selected_acts leaks і latency/qdrant budget breaches.
- У trace single-goal path тепер є окремий `acts_search_policy`, щоб було видно, чи `lldbi_acts` справді виконувався, чи був пропущений через сильний taxonomy-grounded signal.
- Для масового cheap-repair такого drift використовується `refresh-qdrant-payload-batch` у LLDBI admin CLI; full `update --force` потрібен лише коли current-hash points реально відсутні або неповні.
- Для контрольованого full reindex усього корпуса використовується `reload-corpus-batch`; він працює батчами, має resumable report і підходить для parser/payload/embedding кампаній на тисячах актів. Для повторного прогону transient fail-ів у тому самому report додається `--retry-failed`.

## ENV

| Env | Default | Опис |
|-----|---------|------|
| `QDRANT_URL` | — | Qdrant cluster endpoint |
| `QDRANT_API_KEY` | — | Qdrant API key |
| `QDRANT_TIMEOUT_SEC` | 5 | Search timeout |
| `QDRANT_RETRY_ONCE` | true | 1 retry при 502/timeout |
| `LLDBI_COLLECTION_CHUNKS` | lexery_legislation_chunks | Колекція chunks |
| `LLDBI_COLLECTION_ACTS` | lexery_legislation_acts | Колекція acts |
| `LLDBI_TOP_K` | 50 | top_k chunks per query |
| `MIN_SCORE_THRESHOLD` | 0.1 | Мінімальний score |
| `OPENROUTER_API_KEY_ONLINE` | — | **Єдиний** LLM/embedding ключ для U4 |
| `LLDBI_EMBED_MODEL_ID` | openai/text-embedding-3-small | Модель ембедінгу (1536d) |
| `LLDBI_EMBED_TIMEOUT_SEC` | 5 | Embedding timeout |
| `QUERY_REWRITE_ENABLED` | true | Query rewrite + multi-query RRF |
| `QUERY_REWRITE_ALWAYS_ON` | false | Force rewrite для всіх запитів |
| `U4_OOD_GUARD_ENABLED` | true | OOD confidence guard |
| `MEMORY_RECENT_ENABLED` | true | Fetch mm_memory_items з Supabase |
| `MEMORY_RECENT_LIMIT` | 5 | Макс items на run |
| `MEMORY_RECENT_TIMEOUT_MS` | 1500 | Memory fetch timeout |
| `MEMORY_SEMANTIC_ENABLED` | false | Semantic memory via Qdrant (Phase 2, не реалізовано) |

## One-command verification

```bash
# U4 smoke (server + POST + poll retrieval_trace)
pnpm brain:verify:u4

# Retrieval quality suite (20–30 cases)
pnpm brain:verify:retrieval-quality:smoke

# Multi-goal retrieval suite
pnpm brain:verify:retrieval-multigoal:smoke

# Real-dev fast suite (labeled dataset, 40 cases)
pnpm brain:verify:retrieval-real-dev:fast --flaky-check

# Act-type audit fast
pnpm brain:verify:act-type-audit:fast
```

`verify_rag_golden`, `verify:retrieval-real-dev:fast/smoke`, `verify_rag_secondary_acts`, `verify_rag_assessment`, and `verify:act-type-audit` now run in a retrieval-focused harness:
`U10` is dry-run, `U9` meta-triage is disabled, memory fetch is disabled, verifier runs stop after `U5`, and each verifier gets its own Redis queue namespace.
This keeps RAG iteration fast, cheaper, and isolated from unrelated queued runs while leaving production runtime behavior unchanged.

`verify_retrieval_real_dev --only=FAST` also writes per-case telemetry into `scripts/lexery-legal-agent/tools/_reports/retrieval_real_dev_fast_results.json`: `latency_ms`, `qdrant_calls_count_total`, `coverage_gap`, `low_confidence`, `selected_act_count`, plus article-overlay fields when strict article mode is enabled. Це спрощує forensic triage після великих regression run-ів.

`coverage_gap` normalization now explicitly protects grounded weak runs from being mislabeled as `likely_missing_act`. If retrieval already has indexed-act grounding (exact / grounded taxonomy hit), weak sparse non-primary tails stay `weak_evidence`; only legally specific runs without indexed grounding are promoted into `likely_missing_act`. The same grounding signal is now passed through the multi-goal path, not only single-goal finalization.

For multi-goal runs this honesty contract is now derived from the final post-trim `selected_acts` bundle, not the raw pre-trim list. `selected_acts_confidence`, metadata grounding counts, and `coverage_gap` are recomputed after weak tails are removed, so trimmed noise no longer keeps stale low-confidence or fake-missing-act semantics alive in the final trace.

`selected_acts` multi-goal policy тепер окремо ріже не лише weak non-primary tails, а й weak off-family `PRIMARY_LAW` tails, якщо dominant primary-law evidence already strong, tail не покриває жодної цілі, не grounded metadata-ою, і не є легітимним procedural companion для mixed substantive+procedure bundle. Це generalized anti-drift guard проти ситуацій типу `ККУ + слабкий КУпАП tail`.
Водночас сильний mixed substantive+procedure bundle більше не падає автоматично в `low_confidence` тільки через family conflict: якщо дві різні `PRIMARY_LAW` family мають material chunk evidence і разом покривають усі цілі, conflict нормалізується як очікуваний multi-goal pattern, а не як cross-family drift.
Окремо `UNGROUNDED_MULTI_GOAL_FALLBACK` тепер має явну нормалізацію: legally-specific bundle без indexed grounding переходить у `likely_missing_act`, а suppressor для цього path більше не спрацьовує лише тому, що taxonomy підтягнула broad framework acts. Для `weak_evidence` тут потрібен реальний indexed grounding (`exact` / `grounded` act hit), а не просто taxonomy presence.
Chunk-only multi-goal bundle тепер не вважається truly grounded лише тому, що формально покрив усі goals: якщо surviving acts не дають distinct goal contribution, runtime теж переводить такий path у `UNGROUNDED_MULTI_GOAL_FALLBACK`. Це прибирає redundant same-family/off-family дублювання, яке раніше могло маскувати слабку evidence surface під “нормальний” multi-act success.
Ранній low-confidence tail trim у multi-goal path тепер теж використовує goal-aware policy, а не чистий `rank_mass` sort. Якщо один act має нижчий evidence rank, але є єдиним носієм окремої цілі, він не повинен випадати ще до фінальної honesty-normalization.
У single-goal low-confidence path finalizer тепер також може повернути один compatible `PRIMARY_LAW` companion із `act_candidates_top`, навіть якщо pre-final `selected_acts_sources_breakdown` уже втратив цей акт після narrowing. Умова generic: candidate має сильний semantic signal, бути compatible з surviving lead family, і materially outrank weak generic-code fallback. Це допомагає зберігати legal bundles типу `спеціальний закон + кодекс` без ручних per-act винятків.
Multi-goal rewrite variants тепер також мають safe cost-gate: їх можна пропускати лише коли кожна ціль already has material coverage, для кожної цілі є explicit `required_categories`, і goal-support покривається category-aligned `PRIMARY_LAW`, а не treaty / off-family tails. Без цього variant search лишається увімкненим, щоб не втрачати procedural companion acts.
