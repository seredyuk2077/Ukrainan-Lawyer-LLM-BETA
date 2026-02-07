# ADR: U4 Query Shaping and Two-Stage Retrieval

## Context

Short or typo-heavy user queries (e.g. "умисне вбивство", "умисне вбиство") were returning 0 LLDBI hits because:
1. U4 filtered hits by `min_score` (0.5 from plan), and short queries often yield lower similarity scores.
2. No retrieval-time anchoring: embedding was over the raw query only, so "умисне вбивство" did not pull in KKU context.

We need CacheRAG to return relevant hits even for "human" queries (short, with typos, without explicit act references), without moving logic into U6 Expand (which is LLM-based and costly).

## Decision

### 1. No score-filter-to-zero

- U4 must **never** return 0 hits solely due to score threshold.
- Algorithm: collect top_k raw hits per step from Qdrant; apply `min_score` filter; if the result is empty but we have any raw hits, use all raw hits and set `meta.low_confidence = true`.
- Low confidence is a signal for U5 Gate (expand/doclist) and audit; it is not a reason to hide hits.

### 2. Query shaping (retrieval anchoring, not U6 Expand)

- Module: `retrieval/query-shaping.ts`.
- Steps: NFC normalize, whitespace collapse, typo fix (e.g. "вбиство" → "вбивство"), optional anchor tokens.
- **Anchors only from ActTaxonomyStore**: no hardcoded domain→act. U4 calls getTaxonomyCandidates(query, domainHint, entities); anchor_tokens from taxonomy (alias/title shorts from top candidates) are passed to shapeQueryForRetrieval. If taxonomy is empty or unavailable, no anchors are added.
- **Single embedding**: we embed the shaped query once; no extra embedding calls for anchors.
- This is deterministic, cheap, and does not use LLM (unlike U6 Expand). See ADR `u4-act-taxonomy-store.md`.

### 3. Two-stage retrieval (acts → filtered chunks)

- Constants: `MIN_HITS_FOR_TWO_STAGE = 3`, `GOOD_SCORE_THRESHOLD = 0.4`, `TWO_STAGE_ACTS_TOP = 3`, `TWO_STAGE_CHUNKS_TOP = 15`.
- After the first pass (chunks + acts), if `hits_count < MIN_HITS_FOR_TWO_STAGE` or `top_score < GOOD_SCORE_THRESHOLD`:
  - Search acts again with the **same** vector (no new embedding).
  - Take top 1–3 `rada_nreg` from acts.
  - Search chunks with filter `should: [ { key: "rada_nreg", match: { value: nreg } } ]` for each nreg (Qdrant OR).
  - Merge and dedupe by (r2_key, json_path); set `meta.used_filtered_chunks_search = true`.
- Same embedding is reused; at most 2 extra Qdrant calls (acts + filtered chunks).

### 4. RetrievalTrace.meta diagnostics

- Added: `steps_requested`, `steps_executed`, `query_used` (preview 200 chars), `hits_count`, `avg_score`, `low_confidence`, `query_variants_used`, `used_filtered_chunks_search`, `anchors_used`, `thesaurus_version`.
- No full query text or secrets; only what is needed to debug "why 0 hits" or "which variant/anchors were used".

### 5. Impact on Gate (U5)

- U5 already decides expand based on hits_count, top_score, direct_ref, etc.
- `low_confidence` in trace can be used in future Gate versions to bias toward expand; current Gate does not read it.
- Two-stage and query shaping increase hits for short queries, so Gate sees more hits and may choose no-expand where it previously expanded.

## Alternatives

- **LLM query expansion in U4**: Rejected; adds latency and cost; we keep expansion in U6.
- **Lowering min_score globally**: Rejected; would flood Gate with weak hits; we prefer "return top_k but mark low_confidence" when below threshold.
- **Only two-stage, no shaping**: Rejected; shaping (anchors + typo fix) improves first-pass scores and reduces reliance on two-stage.

## Consequences

- verify_lldbi_kku115 reaches 3/3 PASS for "умисне вбивство", "умисне вбиство", "ККУ ст. 115 умисне вбивство".
- Trace is auditable (steps, query_used, anchors_used, used_filtered_chunks_search).
- Observability: `u4_filtered_search_total`, `u4_low_confidence_total` incremented when applicable.
