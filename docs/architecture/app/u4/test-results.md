# U4 CacheRAG — Результати перевірки

## One-command verification

```bash
pnpm brain:verify:u4
```

- Вибирає вільний порт, стартує server з BRAIN_PORT і DEV_API_KEY.
- Чекає /health (poll 250ms, timeout 20s).
- POST /v1/runs з query "ККУ ст. 115 умисне вбивство".
- Polling GET /v1/runs/:id до появи `retrieval_trace` (timeout 60s).
- PASS якщо retrieval_trace != null (з hits або з degraded_sources.lldbi=true при недоступному Qdrant).
- SIGTERM серверу → 5s → SIGKILL.
- Summary: Port, Health, Smoke, Exit 0/1.

Ручних кроків не потрібно.

## Retrieval quality (25 cases)

**Команда:**

```bash
pnpm brain:verify:retrieval-quality
```

- 25 кейсів: універсальні запити (умисне вбивство, звільнення, ККУ, поліція, спадщина, трудовий, податкове, адмін, конституційні, земля, банкрутство, договір, захист споживача, ЦПК, оскарження податкової, тощо) + golden article/act для окремих кейсів.
- Очікування: non-empty hits або low_confidence; optional goldenArticleRef / goldenActTitleContains.
- Summary: Cases 25/25, Latency median/p95, low_confidence %, used_filtered_chunks %, % multi_goal_detected, % llm_planner_used.

**Останній прогін:** 25/25 PASS.

## Multi-goal retrieval verify (25 cases)

**Команда:**

```bash
pnpm brain:verify:retrieval-multigoal
```

- 25 кейсів: multi-goal/multi-act (корупція, бандитизм, тероризм, правочин, емансипація, договірний текст, міграція, адмін-провадження, санкції) + topic pack (Phase 4) — invariants only, no banned golden.
- Очікування: selected_acts in policy, multi-act when expectMultiAct, multi-goal when expectMultiGoal, low_confidence → reason_codes, coverage per goal.
- Budget: median/p95 latency, % act_planner_used, % low_confidence.

**Останній прогін:** 25/25 PASS.

- **Cases:** 25/25 PASS
- **Latency median ms:** ~5058
- **Latency p95 ms:** ~8812
- **qdrant_calls median:** 9
- **% act_planner_used:** 0
- **% low_confidence:** ~20

## Real-dev retrieval verify (43 cases, quality gate)

**Команда:**

```bash
pnpm brain:verify:retrieval-real-dev
```

- 43 кейси (DEV split з retrieval_real_labeled.json): очікування act families, multi-goal, multi-act; без article-level assertions.
- **Quality gate:** `RETRIEVAL_REAL_DEV_MIN_HARD_PASS` (default 30), `RETRIEVAL_REAL_DEV_MAX_HARD_FAIL` (default 13). Exit 0 when hard_pass ≥ MIN and hard_fail ≤ MAX; exit 1 below threshold. Summary prints thresholds and gate PASS/FAIL.
- HOLDOUT verifier залишається строгим (100%); запускати фінально окремо.

**Останній прогін (2026-02-11, baseline routing OFF):**

- **hard_pass:** 30/43
- **hard_fail:** 13
- **% act_family_hit:** 72
- **% act_list_hit:** 72
- **% multi_goal_correct:** 100
- **% multi_act_correct:** 98
- **p50 latency ms:** 4047
- **p95 latency ms:** 9516
- **qdrant_calls median:** 9, **max:** 16
- **planner tier:** 0=43 (no LLM planner used)
- **% routing_hints_called:** 0 (feature off)
- **Quality gate:** PASS (hard_pass=30 ≥ 30 && hard_fail=13 ≤ 13)

**Repeat3 report (baseline):** hard_fail consensus 12; buckets A=11, B=0, C=0, D=1. Artifact: `tools/_reports/retrieval_real_dev_failures_policy_targets_v2_baseline.md`.

**Treatment A (routing ON, repeat3):** hard_fail consensus 12 (no change); buckets A=11, B=0, C=0, D=1. Single run: routing_hints_called 33%, routing_hints_used 0%; p50 ~5.5s, p95 ~10–23s. Artifact: `tools/_reports/retrieval_real_dev_failures_policy_targets_v2_routing_on.md`.

**Delta (baseline vs routing ON):** See `tools/_reports/retrieval_real_dev_routing_hints_delta_2026-02-11.md`. Conclusion: routing ON does not improve hard_fail; routing called but never used (actCandidatesTop lacks PRIMARY_LAW from routing top2). Phase 2 diagnosis + trigger v2 / use v2 in place (ADR: `u4-routing-hints-iteration-v2.md`).

## Останній повний прогін

- `pnpm brain:verify:u3` — smoke + U3/U3a plan test
- `pnpm brain:verify:u4` — Health + Smoke PASS
- `pnpm brain:verify:u5` — Scenario A/B/C PASS
- `pnpm brain:verify:retrieval-quality` — 25/25 PASS
- `pnpm brain:verify:retrieval-multigoal` — 25/25 PASS
- `pnpm brain:verify:retrieval-real-dev` — 30/43 PASS, quality gate PASS

Ручних кроків не потрібно.
