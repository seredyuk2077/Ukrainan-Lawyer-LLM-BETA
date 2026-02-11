# U4 Routing-hints iteration v2 (trigger + use)

## Context

- Baseline (routing OFF): hard_pass 30, hard_fail 13; repeat3 consensus 12, bucket A=11.
- Treatment A (routing ON, single run): hard_pass 30, hard_fail 13; routing_hints_called 33%, **routing_hints_used 0%** — routing is called but no act is ever added because actCandidatesTop lacks PRIMARY_LAW from routing’s top2 families.
- Phase 2 diagnosis: On most STABLE bucket A cases routing is **not** called (triggers too narrow); when called, one case had INVALID_JSON; family_mismatch_flag true in 2 A cases (dominant family strong but selected_acts don’t contain it).

## Decisions

### Trigger v2: “confident family mismatch”

- **New trigger:** `confident_family_mismatch` = dominant_family_key with support ≥ 0.62, no family_conflict, and selected_acts do not contain any act whose category (from taxonomy) equals dominant_family_key.
- **Rationale:** Evidence-based only (taxonomy category + chunks evidence); no word→family mapping. Targets the “strong evidence for family X but we picked acts from other families” pattern.

### Use v2: one extra acts-search when routing called

- When routing is called, returns families_ranked, and overall_confidence ≥ 0.55: after trying to add PRIMARY_LAW from actCandidatesTop for top2 families, if a family still has no PRIMARY_LAW in selected_acts, run **one** extra Qdrant search on the acts collection (query_variants[0] if present, else same query vector), limit 20, then filter client-side by category ∈ top2 and PRIMARY_LAW; add up to one act with reason_tag ROUTING_HINTS_FAMILY_BOOST.
- **Rationale:** Closes the “routing said family X but we had no candidate in actCandidatesTop” gap without adding chunks searches.

### Quality-first

- If routing overall_confidence < 0.55: do not apply family-prioritized allocation or extra acts-search; only set low_confidence + ROUTING_HINTS_LOW_CONF when needed.
- Cap: routing_hints_called ≤ 25% of runs when enabled.

## Status

- Implemented: trigger v2 (confident_family_mismatch), use v2 (one extra acts-search when stillMissingFamily).
- Verify: u3/u4/u5 PASS, retrieval-quality PASS, retrieval-real-dev (routing ON) gate PASS; single-run KPI unchanged (30/13, routing_used 0). Repeat3 with routing ON after v2 not yet run for final KPI.
- Evidence: `tools/_reports/retrieval_real_dev_routing_hints_delta_2026-02-11.md`, baseline vs treatment repeat3 reports.
