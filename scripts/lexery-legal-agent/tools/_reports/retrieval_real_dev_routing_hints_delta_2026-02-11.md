# Routing-hints LLM: Baseline vs Treatment A — Delta

**Date:** 2026-02-11  
**Branch:** feature/lexery-legal-agent-architecture  
**Goal:** PROD evaluation of routing-hints impact (A/B); no keyword dictionaries.

---

## 1. Baseline (routing OFF)

- **Verify chain:** u3 PASS, u4 PASS, u5 PASS. retrieval-real-dev: gate PASS.
- **real-dev single run:**
  - hard_pass: **30** | hard_fail: **13**
  - % act_family_hit: 72 | act_list_hit: 72
  - p50 latency ms: **4047** | p95: **9516**
  - qdrant_calls median: 9 | max: 16
  - % llm_planner_used: 0 | % act_planner_used: 0
  - **% routing_hints_called:** 0 (feature off)
- **Report repeat=3 (consensus):**
  - hard_fail (consensus): **12** (of 43 DEV)
  - Buckets: **A=11**, B=0, C=0, **D=1**
- **Artifact:** `_reports/retrieval_real_dev_failures_policy_targets_v2_baseline.md`

---

## 2. Treatment A (routing ON, env only)

- **Env:** `U4_ROUTING_HINTS_ENABLED=true` (no code change). Model: default haiku. MAX_CALLS_PER_RUN=1.
- **real-dev single run (2026-02-11):**
  - hard_pass: **30** | hard_fail: **13**
  - p50 latency ms: **5998** | p95: **23632**
  - qdrant_calls median: 9 | max: 16
  - **% routing_hints_called:** **33** (14/43)
  - **% routing_hints_used:** **0** (0/43)
- **Report repeat=3 (treatment):** hard_fail consensus **12**, buckets A=11, B=0, C=0, D=1.
- **Artifact:** `_reports/retrieval_real_dev_failures_policy_targets_v2_routing_on.md`

---

## 3. Delta (single-run real-dev)

| Metric | Baseline (OFF) | Treatment A (ON) | Δ |
|--------|----------------|------------------|---|
| hard_pass | 30 | 30 | 0 |
| hard_fail | 13 | 13 | 0 |
| % act_family_hit | 72 | 72 | 0 |
| p50 latency ms | 4047 | 5998 | +1951 |
| p95 latency ms | 9516 | 23632 | +14116 |
| qdrant_calls median | 9 | 9 | 0 |
| % routing_hints_called | 0 | 33 | +33 |
| % routing_hints_used | 0 | 0 | 0 |

---

## 4. Repeat3 consensus (baseline vs treatment)

| Metric | Baseline repeat3 | Treatment repeat3 | Δ |
|--------|------------------|-------------------|---|
| hard_fail consensus | 12 | 12 | 0 |
| Bucket A (wrong family) | 11 | 11 | 0 |
| Bucket B | 0 | 0 | 0 |
| Bucket C | 0 | 0 | 0 |
| Bucket D | 1 | 1 | 0 |

---

## 5. PASS→FAIL / FAIL→PASS flips

- **Repeat3:** No flips. Same 12 stable hard_fail cases in both runs; same bucket distribution (A=11, D=1). Identical FAIL case list (e.g. #7 Податкова перевірка…, #10 Водіння в нетверезому…, #13 звільнення прогул, etc.).
- **FAIL→PASS (top):** none.
- **PASS→FAIL (top):** none.

---

## 6. Conclusion

- **Routing-hints ON does not improve hard_fail.** Repeat3 consensus stays 12 (baseline 12); bucket A stays 11. Single-run KPI unchanged (30/13).
- **Routing is called (33%) but never used (0%).** The pipeline calls the LLM when triggers fire, but `actCandidatesTop` does not contain PRIMARY_LAW from routing’s `families_ranked_top2` that could be added — so no act is ever appended from routing. The “use” gap is in act availability, not in trigger coverage.
- **Latency degrades with routing ON:** p50 +~2s, p95 +~14s (routing adds LLM call on 14/43 cases).
- **Next:** Phase 2 — enrich reporter with routing_hints (called/used/confidence/families_ranked_top2) and family_mismatch_flag per case; then Phase 3 — trigger v2 (confident family mismatch) and use v2 (one extra acts-search pass when routing called) so routing can actually add acts when the right family is missing.

---

## 9. Phase 2 diagnosis (why STABLE bucket A is not fixed)

- **routing_hints_called on STABLE A:** Of 11 bucket A cases, **9 have routing_hints called: false**. Only 2 STABLE failures had routing called: #13 (D) and #24 (A). So on most STABLE wrong-family cases the triggers do **not** fire (selected_acts_confidence or reason_codes don’t hit COVERAGE_GUARD_FAILED / NO_STRONG_ACT_EVIDENCE / family_weak_evidence / family_conflict).
- **When routing was called:** #13 had **call_failed_reason: INVALID_JSON** (routing LLM response parse failed). So the only D case that called routing didn’t get a usable result.
- **family_mismatch_flag:** **true** in 2 A cases (#15, #21): strong dominant_family_key (support ≥ 0.62), no conflict, but selected_acts (by title) don’t contain that family. So we have “confident evidence for family X, but selected acts are from other families” — the exact pattern for trigger v2 (confident family mismatch).
- **Root cause (signals, not words):** (1) Triggers are too narrow — many A cases have FAMILY_DOMINANT_OK or high confidence, so routing is never called. (2) When expected family ≠ dominant (e.g. expected criminal, dominant admin), we don’t have a “expected vs dominant mismatch” trigger. (3) When dominant is strong and selected_acts lack that family (family_mismatch_flag), we should call routing (trigger v2). (4) Even when routing is called, we don’t add acts because actCandidatesTop has no PRIMARY_LAW from routing’s top2 families — hence need use v2 (extra acts-search pass for routing’s families).

---

## 7. Commands used

```bash
# Baseline
pnpm brain:verify:u3 && pnpm brain:verify:u4 && pnpm brain:verify:u5
pnpm brain:verify:retrieval-real-dev
pnpm brain:report:retrieval-real-failures-policy-targets-v2:repeat3
cp _reports/retrieval_real_dev_failures_policy_targets_v2.md _reports/retrieval_real_dev_failures_policy_targets_v2_baseline.md

# Treatment A
U4_ROUTING_HINTS_ENABLED=true pnpm brain:verify:retrieval-real-dev
U4_ROUTING_HINTS_ENABLED=true pnpm brain:report:retrieval-real-failures-policy-targets-v2:repeat3
```

---

## 8. Artifacts

- Baseline report: `scripts/lexery-legal-agent/tools/_reports/retrieval_real_dev_failures_policy_targets_v2_baseline.md`
- Treatment report: `scripts/lexery-legal-agent/tools/_reports/retrieval_real_dev_failures_policy_targets_v2_routing_on.md`
- This delta: `scripts/lexery-legal-agent/tools/_reports/retrieval_real_dev_routing_hints_delta_2026-02-11.md`
