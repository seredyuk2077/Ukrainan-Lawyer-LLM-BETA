# [U4] CacheRAG — RawHit + RetrievalTrace (Evidence Search)

Retrieval з LLDBI (Qdrant chunks/acts 1536d) + опційно Memory. Результати — pointers (r2_key, json_path), не повні тексти.

## Контракти (LEX-106)

| Тип | Файл | Опис |
|-----|------|------|
| **RawHit** | `scripts/lexery-legal-agent/retrieval/types.ts` | r2_key, json_path, score, source?, rada_nreg?, article_number?, title?, metadata? |
| **RetrievalTrace** | там само | version, hits[], top_score?, latency_ms?, degraded_sources?, meta? |
| **RunRecord audit** | `runs.retrieval_trace` (JSONB) | Міграція: add_runs_retrieval_trace |

## Код (Wave 3)

- `retrieval/types.ts` — типи + Zod
- `retrieval/qdrant-client.ts` — Qdrant search, timeout + 1 retry
- `retrieval/embedding.ts` — embedQuery (OpenRouter, 1536d)
- `retrieval/cache-rag.ts` — runCacheRag (plan/steps → RawHits + RetrievalTrace)
- `retrieval/consumer.ts` — handleU4Event: load run, runCacheRag, persist trace, enqueue U5
- `gate/consumer.ts` — U5 connectivity stub (log + enqueue U9)

## ENV

| Env | Default | Опис |
|-----|---------|------|
| QDRANT_URL / qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB | — | Qdrant URL |
| QDRANT_API_KEY / qdrant_clusterAPI_LEXERY_LEGISLATION_DB | — | Qdrant API key (optional self-host) |
| QDRANT_TIMEOUT_SEC | 5 | Timeout для search |
| QDRANT_RETRY_ONCE | true | 1 retry при 502/timeout |
| LLDBI_COLLECTION_CHUNKS | lexery_legislation_chunks | Колекція chunks |
| LLDBI_COLLECTION_ACTS | lexery_legislation_acts | Колекція acts |
| LLDBI_TOP_K | 50 | top_k chunks |
| MIN_SCORE_THRESHOLD | 0.1 | Мінімальний score для hit |
| U4_QDRANT_CONCURRENCY | 20 | Готовність до concurrent |
| OPEN_ROUTER_API_RAG / OPENROUTER_API_KEY_ONLINE | — | Embeddings API key |
| LLDBI_EMBED_MODEL_ID | openai/text-embedding-3-small | Модель 1536d (узгоджено з LLDBI індексом) |
| LLDBI_EMBED_TIMEOUT_SEC | 5 | Timeout embedding |

## One-command verification

```bash
pnpm brain:verify:u4
```

Піднімає сервер на випадковому порту, POST /v1/runs, polling GET до появи `retrieval_trace`. PASS якщо trace присутній (hits або degraded_sources.lldbi=true при недоступному Qdrant). Без ручних кроків.

## Pipeline

Див. `pipeline.md`. ADR: `decisions/qdrant-search-contract.md`, `embedding-model-compat.md`, `degraded-policy.md`.
