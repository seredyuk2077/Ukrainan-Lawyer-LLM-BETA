# ADR: U4 Hybrid Re-Score and Optional Rerank

## Context

U4 must return the most relevant chunks for any query (short, long, multi-domain) without extra LLM cost in the hot path. Vector score alone can rank poorly when taxonomy/entity signals are strong (e.g. alias match, article_ref match). A reranker (LLM or cross-encoder) could improve order but adds latency and cost; it must be optional and budget-safe.

## Decision

### 1. Hybrid re-score (no extra LLM)

- **Formula**: `final_score = w_vec * vector_score + w_alias * alias_match + w_article * article_ref_match + w_category * category_hint + w_title * title_overlap`.
- **Weights**: w_vec=0.6, w_alias=0.15, w_article=0.15, w_category=0.05, w_title=0.05. Vector remains primary.
- **Sources**: alias_match/category_hint from ActTaxonomyStore (rada_nreg_candidates, alias_hits, category_hints); article_ref_match from U2 entities vs hit.article_number; title_overlap = token overlap between query and hit.title (normalized).
- **Usage**: Ordering only. `hit.score` in trace remains the original vector score for audit; we sort hits by hybrid score before building sample_hits and response.
- **When**: Applied only when taxonomy is available (`taxonomyResult.debug.source === 'supabase'`). Otherwise order by vector score only.

### 2. Optional reranker (LLM or other)

- **Flag**: `U4_RERANK_ENABLED=true`. Default false.
- **When**: Only when `low_confidence=true` or when we need to pick top-5 from top-50; not on every request.
- **Input**: Short data only: effective_query (max 1–2k chars), list of hits (refs: title, article_ref, optional short snippet from payload — no R2 full fetch).
- **Output**: Reordered list + reason codes. Strict timeout (e.g. 2–3s via `U4_RERANK_TIMEOUT_SEC`); fallback to hybrid re-score on timeout or error.
- **Budget**: Rerank is off by default; when on, used only in low-confidence or selective paths. ADR documents that this keeps cost under control.

### 3. No R2 full fetch in U4 for rerank

- U4 operates on refs + payload + metadata only. Full text assembly is U9/Assemble. For verify we may fetch one fragment (top-1) as evidence; not in production pipeline.

## Consequences

- Better ranking for multi-domain and entity-heavy queries without LLM in the default path.
- Trace includes `meta.hybrid_rescore_used` when taxonomy was used for ordering.
- Optional rerank can be enabled later without changing the default behaviour.
