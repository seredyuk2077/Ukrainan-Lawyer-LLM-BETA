# U4 CacheRAG — Pipeline

## Stages (A–E)

- **A. Query understanding** — NFC, whitespace, typo fix; anchors from taxonomy only. Intent/domain from query_profile.
- **B. Act candidate generation** — Taxonomy (alias/keyword/topic) + Qdrant acts search → top 5 acts → act_candidates_top in trace.
- **C. Within-act chunks** — First pass: unfiltered chunks + acts. When act candidates exist: **per-act retrieval** (top N chunks per act, e.g. 35 per act) so relevant article can appear within act. No hardcode act names.
- **D. Hybrid scoring + diversity** — w_vec*vector + alias + article_ref + category + title_overlap. Diversity cap: in top 25, max 16 from same act.
- **E. Selective LLM** — (Optional) rewrite/rerank only on triggers (low_confidence, diversity collapse); not used by default.

## Кроки

1. **U4 event** — після U3a (search_plan + steps у RunContext/RunRecord).
2. **Load run** — RunRepository.findByRunId; search_plan/steps з RunContext або RunRecord.search_plan; query_profile (domain, entities).
3. **ActTaxonomyStore** — getTaxonomyCandidates(query, domainHint, entities). Джерело: Supabase legislation_documents (aliases, keywords, topics, category). TTL refresh; tolerant normalizer (NFC, trim, lower, dedup) for aliases/keywords/topics. getActMeta, scoreActCandidate, findCandidatesByAliasTokens.
4. **Query shaping** — NFC, whitespace, typo fix; **anchors тільки з taxonomy**. Без hardcode домен→акт.
5. **Effective query** — нормалізація: короткий query ≤12k; довгий — head+tail (6k+6k).
6. **Embed** — embedQuery(effective) через OpenRouter (openai/text-embedding-3-small, 1536d). При помилці — degraded_sources.lldbi=true, 0 hits.
7. **Qdrant search** — за steps: lldbi_chunks (основне), lldbi_acts (опційно). Timeout + 1 retry.
8. **Within-act retrieval** — якщо є act candidates (taxonomy або acts search): для кожного з top 5 acts — окремий Qdrant search по chunks з filter rada_nreg = act, limit 35. Merge + dedupe. Це дає релевантну статтю в межах акту (act→article).
9. **Hybrid re-score** — ordering без LLM. hit.score у trace залишається векторний.
10. **Diversity cap** — у топ 25 не більше 16 hits з одного акту (generalizable).
11. **RawHits** — з payload: r2_key, json_path, score, rada_nreg, article_number, title, source.
12. **RetrievalTrace.meta** — act_candidates_top, stage_decisions (used_taxonomy, used_acts_search, used_filtered_chunks, used_llm_rewrite, used_llm_rerank), distribution (hits_by_act_top3, avg_score_by_act_top3), reason_codes, sample_hits, hits_count, low_confidence, query_variants_used, anchors_used.
13. **Persist** — RunRepository.updateRetrievalTrace; RunContext: raw_hits + retrieval_trace.
14. **Enqueue U5** — Gate.

## Схема

```
U3a → [U4] → getTaxonomyCandidates → shapeQuery(anchors)
         → embedQuery → Qdrant chunks/acts
         → within-act retrieval (per act, top N chunks) when candidates exist
         → hybrid re-score → diversity cap → RawHits + RetrievalTrace → U5
```

## Limits

- Qdrant: config.qdrantTimeoutSec, config.u4QdrantConcurrency (no change to DB).
- LLM rewrite/rerank: only on triggers; U4_LLM_* when implemented.

## Деградація

- Embedding failure → degraded_sources.lldbi=true, hits=[], U5 все одно enqueue.
- Qdrant unreachable → degraded_sources.lldbi=true, hits=[], U5 enqueue.
- Див. `decisions/degraded-policy.md`.
