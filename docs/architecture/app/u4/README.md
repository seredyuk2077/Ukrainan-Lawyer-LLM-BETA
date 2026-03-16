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
- `scripts/lexery-legal-agent/retrieval/hit-ranking.ts` — hybrid ordering, coverage fusion, anti-noise, diversity cap
- `scripts/lexery-legal-agent/retrieval/chunk-rerank.ts` — structural chunk scoring (`ordering_score`, title/article relevance)
- `scripts/lexery-legal-agent/retrieval/consumer.ts` — handleU4Event: load run, runCacheRag, persist trace, emit metrics, enqueue U5
- `scripts/lexery-legal-agent/retrieval/qdrant-client.ts` — Qdrant search, timeout + 1 retry
- `scripts/lexery-legal-agent/retrieval/embedding.ts` — embedQuery (OpenRouter OPENROUTER_API_KEY_ONLINE, 1536d)
- `scripts/lexery-legal-agent/retrieval/selected-acts.ts` — act selection policy (evidence, family guard, anti-order dominance)
- `scripts/lexery-legal-agent/retrieval/act-taxonomy-store.ts` — LLDBI vocabulary cache (TTL + fallback snapshot)
- `scripts/lexery-legal-agent/retrieval/goal-splitter.ts` — taxonomy-cluster goal splitting v2
- `scripts/lexery-legal-agent/retrieval/act-planner.ts` — LLM retrieval planner (tier 0/1/2)
- `scripts/lexery-legal-agent/retrieval/query-rewriter-llm.ts` — LLM query rewrite + multi-aspect variants
- `scripts/lexery-legal-agent/retrieval/rrf-merge.ts` — RRF merge для multi-query
- `scripts/lexery-legal-agent/retrieval/reference-expander.ts` — reference expansion (згадані акти/статті → додаткові hits)
- `scripts/lexery-legal-agent/retrieval/lldbi-vocabulary.ts` — vocabulary helper (categories/document_types)
- `scripts/lexery-legal-agent/retrieval/memory-store.ts` — fetchRecentMemory (Supabase mm_memory_items, Phase 1)
- `scripts/lexery-legal-agent/retrieval/r2-fragment.ts` — R2 fragment fetcher (for within-act retrieval)
- `scripts/lexery-legal-agent/retrieval/llm-planner.ts` — LLM planner util
- `scripts/lexery-legal-agent/retrieval/routing-hints-llm.ts` — LLM routing hints (U2→U4 bridge)

**Tools (не входять в runtime):** → `scripts/lexery-legal-agent/tools/u4/`

## Поточний refactor напрямок

- `cache-rag.ts` лишається orchestration layer, а не місцем для всіх scoring/policy деталей.
- Ranking/pipeline post-processing виноситься в окремі retrieval-модулі, щоб безпечніше тюнити quality/latency без ризику змішати orchestration, data access і ranking policy в одному файлі.
- Будь-який новий ranking signal має проходити через окремий модуль і regression verify (`rag-units`, `rag-golden`, `retrieval-real-dev`), а не додаватися inline в orchestration flow.
- Corpus hygiene теж є частиною retrieval quality: якщо в LLDBI/Qdrant payload відсутні `chunk_title`, `unit_type`, `article_number` або висять старі `content_hash` версії, structural rerank у U4 втрачає точність навіть коли правильний акт уже є в корпусі.
- Для масового cheap-repair такого drift використовується `refresh-qdrant-payload-batch` у LLDBI admin CLI; full `update --force` потрібен лише коли current-hash points реально відсутні або неповні.

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

`verify_rag_golden` and `verify:retrieval-real-dev:fast/smoke` now run in a retrieval-focused harness:
`U10` is dry-run, `U9` meta-triage is disabled, memory fetch is disabled, verifier runs stop after `U5`, and each verifier gets its own Redis queue namespace.
This keeps RAG iteration fast, cheaper, and isolated from unrelated queued runs while leaving production runtime behavior unchanged.
