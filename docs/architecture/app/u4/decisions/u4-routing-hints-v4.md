# U4 Routing-hints v4 — Triggers v3 + Usefulness v3 (taxonomy-first)

## Status

Accepted (Phase 4).

## Context

- Phase 3: EXPAND_COVERAGE, family-aware extra acts-search; routing_called ≈30%, routing_used ≈2%.
- Problem: routing expensive, little effect; single-run gate flaky (29/14 vs repeat3 30/13).
- Goal: routing_called ≤25%, routing_used ≥3–8/43, gate PASS (≥30 hard_pass, ≤13 hard_fail); no extra qdrant_calls from “use” path where possible.

## Decisions

### 4.1 Usefulness v3: taxonomy-first primary-law injection

- **Attempt 1 (no Qdrant):** When routing called and mayApplyRouting, pick family_key_target = first from families_ranked_top2 not covered by PRIMARY_LAW in selected_acts (by taxonomy category). From actCandidatesTop filter by category === family_key_target and classifyActKind === PRIMARY_LAW; take best by score; add 1 act. source = `routing_hints_taxonomy`; used_reason_codes += ADDED_PRIMARY_LAW_FROM_TAXONOMY.
- **Attempt 2 (fallback):** If taxonomy-first yields no candidate: not_used += NO_TAXONOMY_PRIMARY_ACT; run **one** extra acts-search (query_variants[0] or vector, limit 20); post-filter family_key_target + PRIMARY_LAW. If added: used_reason_codes += ADDED_PRIMARY_LAW_FROM_ACTS_SEARCH. Else not_used += NO_PRIMARY_ACT_FOUND.
- **routing_path:** meta.routing_hints.routing_path = TAXONOMY_FIRST | ACTS_SEARCH | NONE (for reporter and anti-flaky analysis).
- MAX added_count = 1; guards ONLY_ORDERS_FOUND, CAP_BLOCKED unchanged.

### 4.2 Triggers v3: budget ≤25%

- **TRIGGER_STRONG (call always):** confident_family_mismatch === true; OR family_conflict === true AND selected_acts_confidence < 0.6.
- **TRIGGER_MEDIUM:** family_weak_evidence === true AND goals_count === 1 AND selected_acts_confidence < 0.55.
- **TRIGGER_COVERAGE:** reason_codes_include_coverage_guard_failed === true AND goals_count === 1.
- All other previous triggers (e.g. selected_acts_confidence_below_055 alone) removed to keep routing_called ≤25%.

### 4.3 Reporter

- routing_path per FAIL case; summary line: routing_path (last run): TAXONOMY_FIRST=X ACTS_SEARCH=Y NONE=Z.

## KPI (Phase 4)

- routing_called ≤ 25%.
- routing_used ≥ 3/43 (target 5–8).
- single-run real-dev gate: ≥30 hard_pass, ≤13 hard_fail.
- repeat3 consensus hard_fail not worse than baseline.
- latency p95 not > +15% vs baseline routing OFF.

## Observed (after Phase 4)

- routing_called: 23% (10/43) with TRIGGER_STRONG + MEDIUM + coverage_guard_failed.
- routing_used: 0–2% on single run (taxonomy-first adds in few cases; when called via coverage_guard_failed path, often ALREADY_COVERED or NO_TAXONOMY_PRIMARY_ACT).
- repeat3: 30/13 on all three runs (consensus passes gate); single-run can be 29/14 (flaky).
- routing_path distribution in report enables tuning toward TAXONOMY_FIRST and away from ACTS_SEARCH for stability.
