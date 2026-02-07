# U4 CacheRAG — Pipeline

## Кроки

1. **U4 event** — після U3a (search_plan + steps у RunContext/RunRecord).
2. **Load run** — RunRepository.findByRunId; search_plan/steps з RunContext або RunRecord.search_plan.
3. **Effective query** — нормалізація: короткий query ≤12k; довгий — head+tail (6k+6k).
4. **Embed** — embedQuery(text) через OpenRouter (openai/text-embedding-3-small, 1536d). При помилці — degraded_sources.lldbi=true, 0 hits.
5. **Qdrant search** — за steps: lldbi_chunks (основне), lldbi_acts (опційно). Timeout + 1 retry.
6. **RawHits** — з payload: r2_key, json_path, score, rada_nreg, article_number, title, source (lldbi_chunks | lldbi_acts). Без витягування текстів з R2.
7. **RetrievalTrace** — version, hits, top_score, latency_ms, degraded_sources, meta (collections_used, steps_latency_ms).
8. **Persist** — RunRepository.updateRetrievalTrace(run_id, trace); RunContext: raw_hits + retrieval_trace.
9. **Enqueue U5** — Gate (зараз stub: log + enqueue U9).

## Схема

```
U3a → [U4] → runCacheRag → RawHits + RetrievalTrace → DB + RunContext → U5
         ↑
         embedQuery → Qdrant chunks/acts
```

## Деградація

- Embedding failure → degraded_sources.lldbi=true, hits=[], U5 все одно enqueue.
- Qdrant unreachable → degraded_sources.lldbi=true, hits=[], U5 enqueue.
- Див. `decisions/degraded-policy.md`.
