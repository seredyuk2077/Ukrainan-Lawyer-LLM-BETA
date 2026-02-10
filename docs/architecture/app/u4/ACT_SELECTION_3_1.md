# Act selection 3.1 — ACTS-1 pool, diversity, caps

Short tech note: how act selection 3.1 works in U4 CacheRAG (single-goal path).

## Goals

- Reduce **class A** (planner chose wrong family) by not over-committing to planner’s act_candidates; use planner as hints (soft boost), not as hard reorder.
- Reduce **class C** (multi-act needed but only 1 selected) by ensuring at least 2 distinct acts when we have 2+ candidates.
- Keep selected_acts within harness invariants (size ≤ 9, reason_codes when low_confidence).

## ACTS-1 pool (broad candidates)

- **Pool size:** `ACTS_1_POOL_SIZE = 12` (was effectively 5 from taxonomy + act search).
- **Sources:** `taxonomyResult.rada_nreg_candidates` + `actNregsFromSearch` (from lldbi_acts), deduped, slice(0, 12).
- **Scoring:** Every nreg in the pool is scored via `scoreActCandidate(nreg, queryTokens, domainHint)`.
- **Planner as hints:** Planner’s `act_candidates[].rada_nreg` get a small score boost (+0.05) so they are preferred only when scores are close, not forced to top.

## Diversity by category

- After scoring, candidates are grouped by **category** (from `getActMeta(nreg).category`).
- Per category we keep at most **2** acts (best by score), then re-sort all by score.
- This avoids a single category (e.g. administrative) filling all slots when the query needs another family (e.g. criminal).

## selected_acts policy (caps)

- **High confidence (single-goal):** cap = `SELECTED_ACTS_CAP_HIGH` = 3.
- **Low confidence:** cap = `SELECTED_ACTS_CAP_LOW` = 7.
- **Minimum:** If we have ≥2 candidates, we take at least 2 acts (for multi-act expectations).
- **Ceiling:** `SELECTED_ACTS_MAX` = 9 (harness invariant).

So: `selectedActsSize = min(cap, actCandidatesTop.length)`, then if `actCandidatesTop.length >= 2` and `selectedActsSize < 2` set `selectedActsSize = 2`, then `selectedActsSize = min(9, selectedActsSize)`.

## Family prior (Phase 1)

- **Soft prior:** When planner's `act_families` or query-derived hints (criminal/administrative/tax) are present, candidates whose act title matches that family get a score boost (`FAMILY_PRIOR_BOOST` or weaker when ambiguous).
- **Ambiguous guard:** If family hints count > 2 or max confidence < 0.6, use weaker boost.
- **Anti-signals:** Small penalty for administrative acts when query signals criminal; for criminal when query signals administrative (soft only).
- **Trace:** `meta.family_hints`, `meta.prior_applied`, `act_candidates_top[].why_tag`, `selected_acts[].reason_tag`.

## ACTS-2 refinement (Phase 2)

- **Trigger:** ACTS-2 runs only when at least one of: `low_confidence`, top-1 score < 0.55, or hinted family missing from top 6 of ACTS-1.
- **Budget:** Skipped if qdrant_calls ≥ 18. One extra embed + one qdrant search on lldbi_acts (limit 8).
- **Query:** Planner `query_variants[0]` or rule-based lexical anchor per family (e.g. criminal → "Кримінальний кодекс України").
- **Merge:** ACTS-1 + ACTS-2 deduped; unified scoring + diversity + caps. `act_candidates_top[].source_tier`: ACTS_1 | ACTS_2.
- **Trace:** `meta.acts2_used`, `meta.acts2_trigger`, `meta.acts2_queries`, `meta.acts2_qdrant_calls`.

## Trace

- `act_candidates_top`: up to 9 acts (after diversity ordering), with `why_tag` and `source_tier` (ACTS_1/ACTS_2).
- `selected_acts`: up to 3 or 7 (by policy above), with `why_selected` from planner when available, `reason_tag`.
- Within-act retrieval still uses **TWO_STAGE_ACTS_TOP = 5** (unchanged) for qdrant budget.

## Failure classes mapping

- **A** (act_family_miss): Expected family not in pool — family prior + ACTS-2; if still missing, consider "known core acts" injection (ККУ/КУпАП/ЦКУ).
- **B:** Correct act in pool but verifier title/signal mismatch.
- **C** (multi_act_miss): Need ≥2 acts; per-goal allocation (Phase 3).
- **D:** Low confidence / unknown.

## Next steps (tuning)

- If ACTS-2 still doesn't surface ККУ for "нетверезе", check act collection payload (rada_nreg) or add fallback "known core acts" list.
- Multi-goal path: per-goal act allocation (2–3 per goal, union cap 7–9).
