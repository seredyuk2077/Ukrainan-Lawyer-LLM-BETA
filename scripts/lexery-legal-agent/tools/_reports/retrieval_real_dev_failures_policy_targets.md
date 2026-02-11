# Real-dev failures — policy targets (Phase 2.2)

Grouping of **current HARD_FAIL** cases (after verifier labor/admin fix: 27/43 PASS → 16 FAIL) by policy bucket for selected_acts v2.

**Buckets:**
- **A)** selected_acts missing chunks-evidence-dominant act (expected primary law not in selected or outranked by noise)
- **B)** selected_acts dominated by order-like acts (постанова/наказ/розпорядження/звільнення/Порядок)
- **C)** need multi-act but only 0–1 act (empty or single-act selection)
- **D)** wrong family (tax vs procedure vs admin vs criminal vs corporate / judiciary)

---

## A) Missing chunks-evidence-dominant act

Selected acts do not include the act that dominates in chunks evidence (or the act that matches expected family when it appears in candidates but not in top chunks).

### Examples

**#12** — КЗпП повернення товару  
- **expected_act_families:** labor_social, labor  
- **selected_acts (top5):** 955-2010-п | z1257-07 | v0310874-18 | 435-15 | 984_011-07  
- **chunks_evidence_top3:** 955-2010-п c=6 s=0.46 | z1257-07 c=6 s=0.45 | v0310874-18 c=5 s=0.48  
- **act_candidates_top5:** 322-08 Кодекс законів про працю України  
- **Gap:** КЗпП (322-08) is only in act_candidates; chunks top are постанова/інші. Selected_acts picked from chunks and never included 322-08 → missing labor-dominant act.

**#43** — податкове право порушення  
- **expected_act_families:** tax  
- **selected_acts (top5):** 80731-10 КУпАП | 2755-17 ПКУ | 80732-10  
- **chunks_evidence_top3:** 80731-10 c=21 s=0.61 | 2755-17 c=5 s=0.58 | 80732-10 c=4 s=0.58  
- **act_candidates_top5:** 80731-10 КУпАП | 435-15 | 2947-14 | 2341-14 | 322-08  
- **Gap:** Chunks dominant is КУпАП; ПКУ is second. For tax expectation, ПКУ should be primary; selected order puts КУпАП first → tax-dominant act present but outranked.

**#35** — податкова санкція  
- **expected_act_families:** tax  
- **selected_acts (top5):** 2755-17 ПКУ | 80731-10 КУпАП | 2341-14 ККУ  
- **chunks_evidence_top3:** 2755-17 c=14 s=0.52 | 80731-10 c=13 s=0.54 | 2341-14 c=3 s=0.53  
- **act_candidates_top5:** 80731-10 | 435-15 | 2947-14 | 2341-14 | 322-08  
- **Gap:** ПКУ is in selected and chunks-dominant by count; tax family present. If still FAIL, may be verifier title match; otherwise D.

---

## B) Order-like acts dominance

Selected_acts include personnel/order-type acts (постанова, наказ, розпорядження, про звільнення, Порядок) that dominate or crowd out primary law.

### Examples

**#8** — звільнення з роботи  
- **expected_act_families:** labor  
- **selected_acts (top5):** 2341-14 | 322-08 | 4651-17 | 1697-18 | **33-2026-р Про звільнення Малашкіна М.А.**  
- **act_candidates_top5:** 33-2026-р Про звільнення… | 49-2026-р Про звільнення… | 34-2026-р… | 17-2026-р… | 1-2026-р…  
- **chunks_evidence_top3:** 2341-14 c=6 | 322-08 c=4 | 4651-17 c=3  
- **Gap:** act_candidates are almost all “Про звільнення”; one order (33-2026-р) made it into selected_acts. Chunks evidence is 2341, 322-08, 4651 — no order. Policy: allow at most 1 SECONDARY_ORDER and only if it has chunks support.

**#13** — звільнення прогул  
- **expected_act_families:** labor  
- **selected_acts (top5):** 1697-18 | 4651-17 | 80732-10 | 2341-14 | **33-2026-р Про звільнення Малашкіна М.А.**  
- **act_candidates_top5:** 33-2026-р | 49-2026-р | 34-2026-р | 17-2026-р | 1-2026-р  
- **chunks_evidence_top3:** 1697-18 c=6 | 4651-17 c=6 | 80732-10 c=3  
- **Gap:** 322-08 (КЗпП) not in chunks top; selected has one order from taxonomy. Anti-order: do not include order when chunks dominate primary laws.

**#16** — трудовий договір строковий  
- **expected_act_families:** labor  
- **selected_acts (top5):** 322-08 | v0015700-98 | 435-15 | **33-2026-п Про внесення змін до Порядку…**  
- **act_candidates_top5:** 33-2026-п Про внесення змін до Порядку…  
- **chunks_evidence_top3:** 322-08 c=12 s=0.59 | v0015700-98 c=5 | 435-15 c=3  
- **Gap:** Chunks dominant 322-08 (КЗпП); one “Порядок” act in selected from taxonomy. Policy: drop order when PRIMARY_LAW dominates in chunks.

**#26** — оскаржити податкову перевірку  
- **expected_act_families:** tax  
- **selected_acts (top5):** 2755-17 ПКУ | **21-2026-р** | z0426-11  
- **chunks_evidence_top3:** 2755-17 c=20 | 21-2026-р c=5 | z0426-11 c=3  
- **Gap:** 21-2026-р is order-like; ПКУ dominant. Allow at most 1 order only if evidence-backed.

**#28** — банкрутство підприємства  
- **expected_act_families:** corporate  
- **selected_acts (top5):** z0841-01 | v0001500-20 | **893-2010-п Про затвердження Порядку використання коштів…**  
- **chunks_evidence_top3:** z0841-01 c=21 | v0001500-20 c=8 | 893-2010-п c=1 s=0.61  
- **Gap:** Two primary laws dominate chunks; one “Порядок” in selected. Policy: cap one SECONDARY_ORDER, only with support.

---

## C) Need multi-act but only 0–1 act

Empty or single-act selection where query expects multiple acts or at least one strong act.

### Examples

**#7** — Податкова перевірка та оскарження її результатів  
- **expected_act_families:** tax  
- **selected_acts (top5):** (empty)  
- **act_candidates_top5:** (empty)  
- **chunks_evidence_top3:** (empty)  
- **reason_codes:** multi_topic  
- **Gap:** No retrieval path; multi_topic → empty. Need multi-goal/taxonomy split to surface tax + procedure.

**#14** — Бандитизм: визначення і яка це юрисдикція підслідність  
- **expected_act_families:** general  
- **selected_acts (top5):** (empty)  
- **reason_codes:** multi_question, multi_topic  
- **Gap:** multi_question/multi_topic → no acts. Substance + procedure split could help.

**#15** — Що таке шахрайство? і чия по підслідності це стаття  
- **expected_act_families:** corporate  
- **selected_acts (top5):** (empty)  
- **reason_codes:** multi_question, multi_topic  
- **Gap:** Banned golden topic; empty by design. Policy: invariants only (no golden on this).

**#30** — Податкова перевірка і оскарження рішення  
- **expected_act_families:** tax  
- **selected_acts (top5):** (empty)  
- **reason_codes:** multi_topic  
- **Gap:** Same as #7 — tax + procedure, no path.

**#32** — Порядок звільнення та компенсації при скороченні  
- **expected_act_families:** labor  
- **selected_acts (top5):** (empty)  
- **reason_codes:** (none)  
- **Gap:** No hits/candidates; retrieval or goal split needed.

---

## D) Wrong family (tax / procedure / admin / criminal / corporate)

Expected act family does not match what selected_acts or chunks emphasize (e.g. criminal expected but КУпАП; tax expected but КУпАП first).

### Examples

**#10** — Водіння в нетверезому стані сп'янін  
- **expected_act_families:** criminal  
- **selected_acts (top5):** 80731-10 КУпАП | 80732-10  
- **chunks_evidence_top3:** 80731-10 c=21 s=0.72 | 80732-10 c=9 s=0.70  
- **Gap:** Label expects “criminal”; chunks and selected are КУпАП (admin). Semantic/retrieval returns admin code; family mismatch.

**#37** — нетверезий водій штраф  
- **expected_act_families:** criminal  
- **selected_acts (top5):** 80731-10 КУпАП | 80732-10  
- **chunks_evidence_top3:** 80731-10 c=21 s=0.73 | 80732-10 c=9 s=0.70  
- **Gap:** Same as #10 — criminal expected, admin returned.

**#24** — ККУ ст. 190 крадіжка та підслідність  
- **expected_act_families:** criminal  
- **selected_acts (top5):** (empty)  
- **reason_codes:** multi_topic  
- **Gap:** Expected criminal (ККУ); empty selection. D + C.

**#2** — права працівника при звільненні  
- **expected_act_families:** labor  
- **selected_acts (top5):** 322-08 КЗпП | 30-2026-п | 2341-14 ККУ  
- **chunks_evidence_top3:** 322-08 c=21 | 30-2026-п c=5 | 2341-14 c=2  
- **Note:** After verifier fix (labor signal), may PASS. If still FAIL: order 30-2026-п in list → B; or family hit labor → no D.

**#20, #26, #27** — tax expected; ПКУ in selected. Likely PASS after verifier; if FAIL, check tax_customs signal or ordering (D/A).

**#28** — corporate expected; z0841-01, v0001500-20 in selected. Verifier may not have “corporate” family signal → D.

---

## Summary table (pre–Phase 2.2)

| Bucket | Case indices | Count |
|--------|--------------|-------|
| A      | 12, 43, 35   | 3     |
| B      | 2, 8, 13, 16, 26, 28 | 6 |
| C      | 7, 14, 15, 30, 32    | 5 |
| D      | 10, 37, 24, 2?, 20?, 26?, 27?, 28?, 43? | 5+ |

Cases can appear in more than one bucket (e.g. #2 B+D, #24 C+D). After verifier fix, 16 HARD_FAIL remain; policy v2 targets A (ensure primary law in selected), B (anti-order cap), C (multi-goal/retrieval), D (family/cluster diversity).

---

*Generated for Phase 2.2 selected_acts policy v2 (act_kind + diversity guard + anti-order dominance).*
