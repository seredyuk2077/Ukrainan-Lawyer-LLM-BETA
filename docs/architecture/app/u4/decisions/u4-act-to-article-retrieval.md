# ADR: U4 Act→Article Retrieval (Within-Act)

## Context

Retrieval often found the right act (e.g. КУПАП) but did not surface the right article (e.g. ст.130 for "водіння в нетверезому стані") because:
- Unfiltered vector search returns top-K chunks globally; relevant article chunks can rank below other articles of the same act.
- Single filtered search (rada_nreg IN [top acts]) with one limit returns top chunks across all acts; within one act, the relevant article can still be out of top-K.

## Decision

1. **Always run within-act retrieval when act candidates exist** (taxonomy or acts search), not only when needTwoStage (low hits / low score).
2. **Per-act retrieval**: for each of top 5 acts (rada_nreg), run a separate Qdrant search on chunks with filter `rada_nreg = act`, limit = TWO_STAGE_CHUNKS_PER_ACT (e.g. 35). Merge and dedupe with first-pass hits.
3. **No act name hardcode**: act candidates come from ActTaxonomyStore (Supabase) and Qdrant acts search only.
4. **RetrievalTrace.meta**: act_candidates_top (top 5 with rada_nreg, title, score, reasons), stage_decisions (used_taxonomy, used_acts_search, used_filtered_chunks), distribution (hits_by_act_top3, avg_score_by_act_top3).

## Consequences

- Relevant article (e.g. ст.130 КУПАП) can appear in hits when it ranks within top N within its act, even if it ranks low globally.
- More Qdrant calls when act candidates exist (5 per-act searches); latency bounded by config timeouts.
- Data unchanged: no DB writes; taxonomy and chunks read-only.
