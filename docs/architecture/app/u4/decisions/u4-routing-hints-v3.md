# U4 Routing-hints v3 — EXPAND_COVERAGE + invariants

## Status

Accepted (Phase 3).

## Context

- Phase 1: used/not_used reasons + metrics + reporter (transparency).
- Phase 2: parse+extract+retry stability (strict JSON, best-effort extract, 1 retry).
- Phase 2.5 facts (routing ON): routing_called ≈30%, routing_used ≈2% (1/43); top failure act_family_miss.
- Goal: routing_used > 0 on real-dev without aggressive over-coverage; no domain→act mappings, no word→family dictionaries.

## Decisions

### Two modes of applying routing-hints

1. **STEER** (overall_confidence ≥ 0.55): re-rank families_ranked, use query_variants, add acts from actCandidatesTop and extra acts-search as before.
2. **EXPAND_COVERAGE** (overall_confidence < 0.55): allow adding **at most 1** PRIMARY_LAW act only if a risk signal is present:
   - `confident_family_mismatch`, or
   - `family_weak_evidence` / no PRIMARY_LAW for dominant family, or
   - `selected_acts_reason_codes` contains COVERAGE_GUARD_FAILED or NO_STRONG_ACT_EVIDENCE.
   - Trace: `used_reason_codes += ["EXPAND_LOW_CONF"]` when adding at conf < 0.55; `not_used_reason_codes += ["EXPAND_NOT_ALLOWED"]` when conf < 0.55 and no risk signal.

### Family-aware extra acts-search (1 per request, limit 20)

- When routing called and has families_ranked_top2: determine first family in top2 not covered by PRIMARY_LAW in selected_acts (by taxonomy category).
- One Qdrant search on `lexery_legislation_acts`: query = query_variants[0] or goal.subquery or original query; limit 20.
- Post-filter: taxonomy category matches family_key_target; classifyActKind = PRIMARY_LAW.
- If found: add 1 act; source ROUTING_HINTS_FAMILY_BOOST or ROUTING_HINTS_EXPAND_LOW_CONF; used_reason_codes += ADDED_PRIMARY_LAW (and EXPAND_LOW_CONF if expand-only).

### Guards

- **Order/opinion:** Never add SECONDARY_ORDER or CASELAW_OPINION via routing; not_used += ONLY_ORDERS_FOUND / ONLY_OPINIONS_FOUND; added_count stays 0.
- **Cap:** If selected_acts already at SELECTED_ACTS_MAX_OUT → not_used += CAP_BLOCKED; do not set low_confidence solely due to cap.
- **Used definition:** used = true only when added_count > 0; u4_routing_hints_used_total incremented only when added_count > 0.

### Trace / metrics

- meta.routing_hints.used_effect.added_count, used_reason_codes, not_used_reason_codes.
- u4_routing_hints_not_used_by_reason reflects CONF_TOO_LOW, NO_PRIMARY_ACT_FOUND, EXPAND_NOT_ALLOWED, ALREADY_COVERED, CAP_BLOCKED, INVALID_JSON, etc.

## Invariants

- No domain→act or word→family mappings; taxonomy + PRIMARY_LAW filter only.
- Supabase/Qdrant/R2 read-only; no data changes.
- used = (added_count > 0); routing_used metric = count of runs where added_count > 0.

## Stage order (apply block)

1. Resolve conf, expandAllowed, steerMode, expandOnlyMode, mayApplyRouting.
2. If !mayApplyRouting: set not_used (e.g. CONF_TOO_LOW, EXPAND_NOT_ALLOWED) and skip apply.
3. For top2 families: try actCandidatesTop (break when expandOnlyMode && added_count ≥ 1).
4. If still missing family: extra acts-search (query_variants then vector), same added_count cap for expand-only.
5. If used_effect.added_count > 0: used_reason_codes += ADDED_PRIMARY_LAW; increment u4_routing_hints_used; else increment u4_routing_hints_not_used by reason.

## DoD Phase 3

- routing_used > 0 on real-dev (target 3–8 of 43).
- invalid_json ≈ 0 (parse+retry from Phase 2).
- Latency: p95 not > +15–20% vs baseline.
- hard_fail_consensus reduced by ≥1 or hard_pass increased; otherwise consider Phase 4 (triggers v3).

## KPI (baseline vs after Phase 3)

- hard_pass / hard_fail; consensus (repeat3).
- routing_called %; routing_used %.
- Top not_used_reason_codes (NOT_CALLED, CONF_TOO_LOW, ALREADY_COVERED, NO_PRIMARY_ACT_FOUND, CAP_BLOCKED, INVALID_JSON, EXPAND_NOT_ALLOWED).
- Latency p50 / p95.

## Phase 4 (only if needed)

- If top not_used = NOT_CALLED or routing_used still ≈0: triggers v3 (evidence-based: chunks_evidence_top_acts dominant family + selected_acts missing PRIMARY_LAW for that family; or family_weak_evidence / conflict / confident_family_mismatch); budget guard routing_called ≤ 25%.
