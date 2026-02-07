# U4 CacheRAG — Pipeline

## Кроки

1. **U4 event** — після U3a (search_plan + steps у RunContext/RunRecord).
2. **Load run** — RunRepository.findByRunId; search_plan/steps з RunContext або RunRecord.search_plan; query_profile (domain, entities).
3. **ActTaxonomyStore** — getTaxonomyCandidates(query, domainHint, entities). Джерело: Supabase legislation_documents (aliases, keywords, topics, category). TTL refresh; якщо Supabase недоступний — порожні кандидати, якорі не додаються (graceful).
4. **Query shaping** — NFC, whitespace, typo fix; **anchors тільки з taxonomy** (anchor_tokens з getTaxonomyCandidates). Без hardcode домен→акт.
5. **Effective query** — нормалізація: короткий query ≤12k; довгий — head+tail (6k+6k).
6. **Embed** — embedQuery(effective) через OpenRouter (openai/text-embedding-3-small, 1536d). При помилці — degraded_sources.lldbi=true, 0 hits.
7. **Qdrant search** — за steps: lldbi_chunks (основне), lldbi_acts (опційно). Timeout + 1 retry.
8. **Two-stage** — якщо hits < MIN або top_score низький: acts search → merge rada_nreg з taxonomy candidates → filtered chunks по merged nregs.
9. **Hybrid re-score** — ordering: w_vec*vector + w_alias*alias_match + w_article*article_ref + w_category*category_hint + w_title*title_overlap (без LLM). hit.score у trace залишається векторний.
10. **RawHits** — з payload: r2_key, json_path, score, rada_nreg, article_number, title, source. Без витягування текстів з R2.
11. **RetrievalTrace** — version, hits, top_score, latency_ms, degraded_sources, meta (collections_used, steps_latency_ms, low_confidence, why_low_confidence, used_filtered_chunks_search, anchors_used, taxonomy_snapshot_version, hybrid_rescore_used).
12. **Persist** — RunRepository.updateRetrievalTrace(run_id, trace); RunContext: raw_hits + retrieval_trace.
13. **Enqueue U5** — Gate (зараз stub: log + enqueue U9).

## Схема

```
U3a → [U4] → getTaxonomyCandidates → shapeQuery(anchors from taxonomy)
         → embedQuery(effective) → Qdrant chunks/acts
         → two-stage (merge taxonomy + acts) → hybrid re-score → RawHits + RetrievalTrace → U5
```

## Деградація

- Embedding failure → degraded_sources.lldbi=true, hits=[], U5 все одно enqueue.
- Qdrant unreachable → degraded_sources.lldbi=true, hits=[], U5 enqueue.
- Див. `decisions/degraded-policy.md`.
