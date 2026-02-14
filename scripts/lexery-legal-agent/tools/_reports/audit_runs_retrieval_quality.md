# Audit: retrieval quality on real runs

Generated: 2026-02-14T14:20:18.350Z
Runs sampled: 200 (last N=200, read-only)

## Invariants checked

- `low_confidence=true` → `reason_codes` contains one of: NO_STRONG_ACT_EVIDENCE, OUT_OF_SCOPE, LOW_EVIDENCE, low_confidence_fallback, ACT_SELECTION_LOW_CONFIDENCE, COVERAGE_GUARD_FAILED, SELECTED_ACTS_DIVERSITY_ENFORCED, ORDER_DOMINANCE_BLOCKED, DIVERSITY_GUARD_ENFORCED, FAMILY_DOMINANT_OK, COVERAGE_MISS_SELECTED_ACTS
- `domainHint` present (not unknown/general) → at least one act in selected_acts or chunks_evidence
- Reference in top hits → `reference_expansion.attempted` true
- No evidence but `low_confidence=false` → overconfidence_when_no_evidence

## Top bug patterns (counts)

| Pattern | Count |
|---------|-------|
| domain_miss | 0 |
| order_dominance | 0 |
| missing_primary_law | 0 |
| overconfidence_when_no_evidence | 0 |
| ref_expansion_not_triggered | 0 |
| low_conf_no_reason | 0 |

## Runs with issues

Total runs with at least one pattern: 0

## Top 10 runs for manual review (debug bundle)


