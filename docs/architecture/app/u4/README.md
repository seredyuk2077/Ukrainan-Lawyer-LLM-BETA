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
- `scripts/lexery-legal-agent/retrieval/single-goal-selected-acts.ts` — single-goal act-scope honesty/recovery: when a query grounds to one exact or title-grounded act, final `selected_acts` must stay inside that act scope or fall back to low-confidence instead of leaking unrelated writer context
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
- `audit_lldbi_act_coverage.ts` — broad LLDBI act-surface audit: бере багато indexed актів із `legislation_documents`, будує cheap act-centric probes і перевіряє, чи U4 взагалі стабільно піднімає target act поза curated golden cases; `--probe-mode=generalized` додатково ганяє `nreg + alias + anchored_title + title_fragment`, щоб міряти не один alias-case, а різні query families на той самий акт

## Поточний refactor напрямок

- `cache-rag.ts` лишається orchestration layer, а не місцем для всіх scoring/policy деталей.
- Single-goal first-pass уже винесений окремо: `cache-rag.ts` не повинен сам збирати initial chunks/acts plan, policy skip для eager `lldbi_acts`, або перший Qdrant fanout inline.
- Single-goal hit postprocess теж окремий: ordering/noise/diversity, reference expansion, article backfill і final cap більше не мають жити inline у `cache-rag.ts`.
- Ranking/pipeline post-processing виноситься в окремі retrieval-модулі, щоб безпечніше тюнити quality/latency без ризику змішати orchestration, data access і ranking policy в одному файлі.
- Within-act act-pool assembly винесений в окремий retrieval-модуль, щоб single-goal і multi-goal paths збирали один і той самий ranked pool актів без дублювання `lldbi_acts` search у середині `cache-rag.ts`.
- Act ranking тепер окремо поєднує LLDBI metadata signals і retrieval evidence з фінальних hits: сильні ранні article hits можуть підняти правильний акт навіть коли U2 domain hint помиляється.
- Будь-який новий ranking signal має проходити через окремий модуль і regression verify (`rag-units`, `rag-golden`, `retrieval-real-dev`), а не додаватися inline в orchestration flow.
- Для простих двоклаузних legal queries (`X та Y`) U4 тепер покладається на дешевий structural multi-goal split із shared-tail carry-over, а не на обов'язковий LLM planner override; це зменшує latency/cost і прибирає planner-induced шум у procedural queries.
- Для procedural follow-up queries U4 тепер робить дешеве semantic shaping без нових LLM calls: переносить shared subject у follow-up clause (`цю статтю` → предмет першого питання) і додає must-have procedural concept signals на кшталт `підслідність` або `початок досудового розслідування`, коли вони випливають зі змісту питання.
- Для same-act norm bundles (`де шукати норму про X і норму про Y`, `з яких норм це збирається`) heuristic splitter тепер може згорнути bare `і/та` split назад у single-goal через `same_act_bundle_compaction`, щоб bundles одного кодексу не заходили в дорогий multi-goal path без реальної потреби.
- Retrieval trace тепер має нормалізований `coverage_gap = none | weak_evidence | likely_missing_act | out_of_scope`. Це окремий LLDBI-first honesty contract для U5/U10: weak evidence і likely-missing-act більше не повинні виглядати як нормальний успішний retrieval.
- Для explicit-act legal queries, де потрібний акт ще не проіндексований у LLDBI, U4 має віддавати truthy path, а не псевдо-grounded success: `low_confidence=true`, `coverage_gap=likely_missing_act`, reason codes на кшталт `EXPLICIT_ACT_SCOPE_NO_CONVERGENCE` / `NO_STRONG_ACT_EVIDENCE`.
- Це вже перевірено на `2811-20` (`Про авторське право і суміжні права`): до ingest direct copyright-law query переходив у `likely_missing_act`, після LLDBI CLI ingest того самого акту retrieval стабільно заякорився на `2811-20` без artificial expand path.
- `goal-splitter` тепер краще працює з українським процедурним follow-up формулюванням і словами з апострофом: same-source queries типу `як зареєструвати ... і які документи подаються` не повинні розвалюватися на fake multi-goal лише через `і` або через пошкоджений subject focus (`комп'ютерну` тощо).
- Для already-grounded citation queries (`КПК ст. 214`, `п. 21 Правил...`, `пп. 14.1.175 ПКУ`) grounded-query builder більше не додає broad procedural widening на кшталт `строк`, `порядок`, `подання`; лишаються тільки вузькі signals, які реально допомагають article competition.
- Для explicit structural citation queries (`ч./п./пп./абз./примітка` + act/title cue) U4 тепер не пускає LLM query rewrite в default path: такі запити вже достатньо заякорені, а rewrite тільки роздував latency/cost і міг породити fake multi-goal retrieval.
- Для single-goal runs із уже сильним LLDBI/taxonomy signal (`taxonomy_act_count`, `alias_hits`, category/doc-type hints) U4 теж не викликає query rewrite: якщо correct act family already grounded by metadata, дешевший deterministic path кращий за ще один LLM hop.
- Query rewrite variants тепер не можуть тихо потрапити в multi-query retrieval, якщо rewrite офіційно `used=false`; runtime і trace мають збігатися, інакше verifier втрачає чесний cost/behavior audit.
- Structural citation parsing у runtime тепер Cyrillic-safe: `пунктом 12`, `підпункт 6`, `примітка до статті`, `частина 1` мають витягуватись так само стабільно, як `ст. 115`, без ASCII-only boundary bugs.
- `goal-splitter` більше не розриває anchored citation queries лише через сполучник `і/та`, якщо в запиті вже є явні structural selectors; це прибирає false multi-goal fanout для point/title queries по підзаконних актах.
- Contrastive liability queries більше не розщеплюються на зайвий broad prefix-goal поверх `адміністративна vs кримінальна`; heuristic split тепер віддає компактні aspect-goals, щоб не множити Qdrant work і coverage noise.
- `ActTaxonomyStore` тепер використовує не лише alias/token matching, а й phrase-level LLDBI metadata (`title`, `summary`, `keywords`, `topics`, `aliases`, `validity_status`) для дешевшого й точнішого act candidate generation без hardcoded act lists.
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
- `document_type_slug` тепер впливає не лише на `act_kind`, а й на hint-based selection policy: slug-only treaties, draft laws та інші structurally typed акти не повинні випадати з `selected_acts` лише тому, що людський `document_type` у metadata порожній.
- У ранньому head retrieval діє article-level diversity cap: top portion видачі не повинна забиватися кількома chunks з одного й того ж `rada_nreg + article_number`, щоб same-act multi-article retrieval був ширшим і кориснішим для writer.
- Single-goal within-act retrieval більше не виконується за замовчуванням на кожному strong run. U4 тепер вмикає per-act fanout для weak first-pass або explicit structural / act-anchored queries, що помітно зменшує latency та Qdrant call budget на generic high-signal питаннях.
- Within-act fanout policy тепер окремо тримає structural/procedural hard cases: навіть на strong first pass такі query можуть отримати ширший per-act pool, якщо same-act article competition інакше надто вузький.
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
- Grounded single-act alias/title queries тепер не повинні запускати taxonomy-cluster multi-goal split лише через шум у category alias-hits. Якщо taxonomy already converges to one exact/grounded act, U4 лишається в single-goal path і тримає цей act scope до фінального `selected_acts`.
- У multi-goal queries з міксом substantive + procedure один процесуальний кодекс більше не може автоматично вважатися “повним покриттям” лише через сильний chunk head. Якщо single-act coverage тримається тільки на ungrounded procedural primary law, runtime переводить run у honest low-confidence / corpus-gap semantics замість удаваного success.
- `article-backfill` тепер має two-step recovery path: спершу пробує exact structural Qdrant filter, а коли cluster не має індексу на кшталт `point_number`, падає назад до вузького within-act search + local structural post-filter. Це робить runtime стійкішим до LLDBI/Qdrant index drift без окремого hotfix per act.
- Для великих підзаконних актів одного `point_number` недостатньо для “Harvey-like” точності: в одному наказі може існувати кілька різних `п. 12`. Якщо LLDBI не зберігає ієрархію (`citation_path`, chapter/section labels, act_part_label), U4 зможе знайти правильний номер пункту, але не завжди однозначно відрізнить потрібний контекст усередині акту.
- Для explicit single-act identifier queries (`1150-98-п`, `1-2026-р`, `v0003359-26`) selected-acts policy тепер має окремий exact-act scope path: якщо retrieval стабільно зійшовся до одного конкретного акту, U4 не повинен домішувати noise-tail або занижувати confidence лише тому, що акт є `SECONDARY_ORDER`, а не `PRIMARY_LAW`.
- Це ж правило поширюється на compact grounded single-act queries по exact alias/title: якщо short query уже сходиться до одного конкретного підзаконного акту (`Постанова 1178`), writer не має отримувати фальшивий `weak_evidence` лише через `SECONDARY_ORDER`.
- Якщо explicit subordinate-act query дає сильний same-act head (`best_rank<=2`, repeated top-30 chunk evidence, high selected-acts confidence), single-goal finalizer тепер обрізає слабкий non-primary tail до одного lead акту і нормалізує run назад у `coverage_gap=none` замість false `weak_evidence`.
- Якщо explicit subordinate-act query заданий у формі `документ + №номер` без повного `rada_nreg` (`постанова №1178`, `наказ Мінфіну №1257`), taxonomy тепер трактує це як grounding signal лише тоді, коли cue типу акта + достатньо специфічний numeric stem однозначно мапляться на один indexed акт. Короткі або двозначні bare-number references не повинні маскуватися під grounded success.
- Якщо grounded single-act query усе ж приносить шумний top-hit head з іншого акту, single-goal finalizer тепер має спершу спробувати відновити grounded act через власний chunk evidence у top-30, а вже потім позначати `low_confidence`. Це generic guard від false-confident explicit subordinate-act drift.
- Якщо grounded single-act query не змогла відновити жодного `selected_act` після scope trim, trace більше не може лишитися у `coverage_gap=none`: runtime ставить `GROUNDED_ACT_SCOPE_NO_CONVERGENCE` / `EXACT_ACT_SCOPE_NO_CONVERGENCE` і переходить у honest low-confidence path.
- Якщо юридично конкретний single-goal query зводиться лише до процесуального `PRIMARY_LAW` без act grounding (`exact/grounded act hits = 0`, metadata grounding теж немає), runtime більше не повинен трактувати це як достатнє покриття. Такий path переходить у `low_confidence=true` з `NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY` і далі мапиться в `coverage_gap=likely_missing_act`.
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
