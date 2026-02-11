# Real-dev goal-split opportunities (Phase 3.0)

Diagnostic: **16 current HARD_FAIL** cases checked for goal-split opportunity (substance vs procedure / tax+appeal / labor+procedure).  
Source: regression report + policy targets; goals_summary = 1 goal (current heuristic) unless multi_topic produced 2.

---

## FAIL cases with split candidacy

### #7 — Податкова перевірка та оскарження її результатів
- **query:** Податкова перевірка та оскарження її результатів
- **expected_act_families:** tax
- **must_multi_goal:** (from labels: tax+procedure often true)
- **goals_summary (факт):** 1 goal (single subquery)
- **reason_codes:** multi_topic
- **chunks_evidence_top_acts:** (empty — no retrieval path)
- **category histogram top30:** N/A (no hits)
- **Split candidate:** YES — query implies tax (перевірка) + procedure (оскарження). Two strong clusters expected: tax_customs + judiciary_justice/procedure. Current: multi_topic detected but single goal → empty act pool.

### #8 — звільнення з роботи
- **expected_act_families:** labor
- **goals_summary:** 1 goal
- **chunks_evidence_top_acts:** 2341-14 c=6 | 322-08 c=4 | 4651-17 c=3
- **category (inferred):** criminal (2341), labor (322-08), other (4651, 1697)
- **Split candidate:** WEAK — labor dominant; second cluster (ККУ/4651) is noise. Order dominance is main issue (policy v2).

### #10 — Водіння в нетверезому стані сп'янін
- **expected_act_families:** criminal
- **chunks_evidence_top_acts:** 80731-10 c=21 | 80732-10 c=9 (КУпАП)
- **Split candidate:** NO — single topic; wrong family (label expects criminal, retrieval returns admin).

### #12 — КЗпП повернення товару
- **expected_act_families:** labor_social, labor
- **chunks_evidence_top_acts:** 955-2010-п c=6 | z1257-07 c=6 | v0310874-18 c=5
- **category (inferred):** постанова/споживач — not labor code in top
- **Split candidate:** WEAK — retrieval missed КЗпП; not clearly substance+procedure.

### #13 — звільнення прогул
- **expected_act_families:** labor
- **chunks_evidence_top_acts:** 1697-18 c=6 | 4651-17 c=6 | 80732-10 c=3
- **Split candidate:** WEAK — mixed acts; order dominance; 322-08 missing from chunks.

### #14 — Бандитизм: визначення і яка це юрисдикція підслідність
- **expected_act_families:** general
- **goals_summary:** 1 goal
- **reason_codes:** multi_question, multi_topic
- **chunks_evidence_top_acts:** (empty)
- **Split candidate:** YES — definition + procedure (підслідність). Two clusters: criminal + criminal_procedure/judiciary.

### #15 — Що таке шахрайство? і чия по підслідності це стаття
- **expected_act_families:** corporate (label)
- **reason_codes:** multi_question, multi_topic
- **chunks_evidence_top_acts:** (empty)
- **Split candidate:** YES — but banned golden topic; invariants only.

### #16 — трудовий договір строковий
- **expected_act_families:** labor
- **chunks_evidence_top_acts:** 322-08 c=12 | v0015700-98 c=5 | 435-15 c=3
- **Split candidate:** NO — single cluster labor/civil; order in selected_acts is policy issue.

### #20 — оскарження податкової
- **expected_act_families:** tax
- **chunks_evidence_top_acts:** 2755-17 c=21 | v001p710-18 c=4 | z0426-11 c=2
- **Split candidate:** YES — tax + appeal (оскарження) → tax_customs + judiciary/procedure. Evidence shows strong tax; procedure may need second goal to surface.

### #24 — ККУ ст. 190 крадіжка та підслідність
- **expected_act_families:** criminal
- **reason_codes:** multi_topic
- **chunks_evidence_top_acts:** (empty)
- **Split candidate:** YES — criminal (крадіжка) + procedure (підслідність). Two clusters expected.

### #26 — оскаржити податкову перевірку
- **expected_act_families:** tax
- **chunks_evidence_top_acts:** 2755-17 c=20 | 21-2026-р c=5 | z0426-11 c=3
- **Split candidate:** YES — tax + procedure (оскаржити). Strong tax; order 21-2026-р is procedure-like.

### #27 — податки ФОП спрощена система
- **expected_act_families:** tax
- **chunks_evidence_top_acts:** 2755-17 c=21 | v001p710-18 c=8 | z0426-11 c=1
- **Split candidate:** NO — single topic tax; already 2 acts.

### #28 — банкрутство підприємства
- **expected_act_families:** corporate
- **chunks_evidence_top_acts:** z0841-01 c=21 | v0001500-20 c=8 | 893-2010-п c=1
- **Split candidate:** WEAK — corporate + order; one procedure-like (Порядок).

### #30 — Податкова перевірка і оскарження рішення
- **expected_act_families:** tax
- **reason_codes:** multi_topic
- **chunks_evidence_top_acts:** (empty)
- **Split candidate:** YES — same pattern as #7: tax + procedure, no path.

### #32 — Порядок звільнення та компенсації при скороченні
- **expected_act_families:** labor
- **chunks_evidence_top_acts:** (empty)
- **reason_codes:** (none)
- **Split candidate:** YES — labor (звільнення, компенсації) + procedure (порядок). Need labor + procedure goals to get acts.

### #35 — податкова санкція
- **expected_act_families:** tax
- **chunks_evidence_top_acts:** 2755-17 c=14 | 80731-10 c=13 | 2341-14 c=3
- **Split candidate:** NO — tax dominant; КУпАП/ККУ as secondary.

### #37 — нетверезий водій штраф
- **expected_act_families:** criminal
- **chunks_evidence_top_acts:** 80731-10 c=21 | 80732-10 c=9
- **Split candidate:** NO — wrong family (admin vs criminal).

### #43 — податкове право порушення
- **expected_act_families:** tax
- **chunks_evidence_top_acts:** 80731-10 c=21 | 2755-17 c=5 | 80732-10 c=4
- **Split candidate:** NO — tax present but outranked by КУпАП; ordering/primary-law priority.

---

## Category histogram (aggregate from evidence)

When chunks_evidence_top_acts is non-empty, inferred categories from act titles (no DB):

| Case | Top acts (nreg)        | Inferred categories (substance / procedure) |
|------|------------------------|---------------------------------------------|
| #7   | —                      | — (no hits)                                 |
| #8   | 2341, 322-08, 4651     | criminal, labor, other                      |
| #20  | 2755-17, v001p710, z0426 | tax_customs, tax                            |
| #26  | 2755-17, 21-2026-р, z0426 | tax_customs, order/procedure                |
| #30  | —                      | — (no hits)                                 |
| #32  | —                      | — (no hits)                                 |

---

## Top 3 split-opportunity patterns

1. **Tax + appeal/procedure**  
   Queries: «податкова перевірка та оскарження», «оскаржити податкову перевірку», «оскарження податкової», «Податкова перевірка і оскарження рішення».  
   Evidence/taxonomy often show tax_customs strong; procedure/judiciary second. **Split:** goal_substance = tax, goal_procedure = judiciary_justice/procedure.  
   Cases: **#7, #20, #26, #30**.

2. **Labor + procedure/order**  
   Queries: «Порядок звільнення та компенсації при скороченні».  
   Labor (КЗпП) + procedure (порядок, компенсації). **Split:** goal_substance = labor_social, goal_procedure = procedure.  
   Cases: **#32**.

3. **Criminal / general + procedure (підслідність, юрисдикція)**  
   Queries: «Бандитизм: визначення і яка це юрисдикція підслідність», «ККУ ст. 190 крадіжка та підслідність».  
   **Split:** goal_substance = criminal, goal_procedure = criminal_procedure/judiciary.  
   Cases: **#14, #24**.

---

*Generated for Phase 3 — taxonomy-induced goal split v2. Use category_support from taxonomy + chunks evidence (when available) to drive split; no word-list triggers.*
