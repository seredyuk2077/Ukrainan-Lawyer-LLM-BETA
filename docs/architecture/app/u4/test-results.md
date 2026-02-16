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

## Ручний audit workflow (manual_query_run + manual_run_inspect)

Рекомендований інженерний цикл для швидкої перевірки retrieval без повного verify:

1. **Запустити сервер** (в одному терміналі): `pnpm brain:dev`.
2. **Один запит** (в іншому терміналі): `pnpm brain:manual:query "Ваш запит"` — повертає `run_id`, status, latency_ms; друкує команду для inspect.
3. **Inspect run (read-only Supabase):** `pnpm brain:inspect:run <run_id>` — компактний консольний звіт: query, query_profile (domain/domainHint/domain_confidence/domain_candidates_top2), retrieval_trace.meta (selected_acts, chunks_evidence_top_acts, act_candidates_top, reference_expansion, low_confidence, reason_codes, qdrant_calls_count_total, latency_ms).

Опційно: `BRAIN_BASE_URL=http://127.0.0.1:3081 pnpm brain:manual:query "Запит"` якщо сервер вже на іншому порту. Supabase runs — тільки read; для inspect потрібні `SUPABASE_LEXERY_LEGAL_AGENT_DB_URL` та `SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY`.

**Known issues (MCP audit 2026-02-16):** P1 — act_family_miss на окремих запитах (напр. «податкова санкція») у real-dev fast; P2 — окремі runs з selected_acts=0 та low_confidence (ORDER_DOMINANCE_BLOCKED, NO_STRONG_ACT_EVIDENCE). Фікси — тільки політики/інваріанти (domain → taxonomy, coverage guard), без словників.

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
- **Quality gate:** `RETRIEVAL_REAL_DEV_MIN_HARD_PASS` (default 30), `RETRIEVAL_REAL_DEV_MAX_HARD_FAIL` (default 13). Exit 0 when hard_pass ≥ MIN and hard_fail ≤ MAX; exit 1 below threshold. **FAST/limited run** (--only=FAST): пропорційний gate — MIN = 60% від N, MAX fail = 30% від N (N = кількість кейсів у прогоні). Summary prints thresholds and gate PASS/FAIL.
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

## Act-type audit (snapshot + cases from Supabase)

**Команди:**

```bash
pnpm brain:dataset:act-type-audit      # snapshot 20 acts (read-only legislation)
pnpm brain:generate:act-type-audit-cases
pnpm brain:verify:act-type-audit:smoke # 8 cases
pnpm brain:verify:act-type-audit:fast  # 20 cases, gate: explicit ≥70%, implicit ≥50%, pass ≥60%
pnpm brain:verify:act-type-audit      # FULL + special_multiact + out_of_domain + reference_expansion
```

- Snapshot: 20 актів (≥5 PRIMARY_LAW, ≥5 SECONDARY_ORDER, presidential/international/KSU). Кейси: A) explicit act, B) implicit domain, C) within-act.
- **FAST gate:** exit 0 when pass ≥ 60% and explicit_act_hit ≥ 70% and implicit_category_hit ≥ 50%.

**Останній прогін (real snapshot):** explicit 86%, implicit 71%, within 67%; total pass 15/20; FAST gate PASS.

## Audit runs retrieval quality (Phase 5)

**Команда:**

```bash
pnpm brain:audit:runs-retrieval-quality
```

- Read-only Supabase `runs`: останні N=200 з retrieval_trace.
- Інваріанти: low_confidence → reason_codes (дозволені коди: NO_STRONG_ACT_EVIDENCE, COVERAGE_GUARD_FAILED, ORDER_DOMINANCE_BLOCKED, …); domainHint → evidence; reference_expansion.
- Вивід: `tools/_reports/audit_runs_retrieval_quality.md` (патерни багів, топ 10 runs для ручної перевірки).

**Останній прогін:** 0 runs with issues (reason_codes extended to policy codes).

## U2 domain audit (Phase 6)

**Команди:**

```bash
pnpm brain:verify:u2-domain:smoke  # 7 cases, SMOKE gate pass >= 4
pnpm brain:verify:u2-domain:fast   # 15 cases
```

- Кейси: clean (civil/tax/labor/criminal/admin), mixed (criminal+sanctions, tax+appeal), out-of-domain (unknown/low conf).
- Assertions: output schema valid; out-of-domain → domain_primary=unknown or confidence < 0.55; mixed → primary not unknown. No act names.
- **U2 AI domain classifier:** OFF by default (U2_AI_DOMAIN_ENABLED=true to enable); max 1 call/run; taxonomy family keys only; trace meta.u2_domain, meta.u2_ai_domain; metrics u2_ai_domain_called_total, u2_ai_domain_used_total.

**Останній прогін (U2 AI domain OFF):** 6/7 pass, SMOKE gate PASS.

## Останній повний прогін

- `pnpm brain:verify:u3` — smoke + U3/U3a plan test
- `pnpm brain:verify:u4` — Health + Smoke PASS
- `pnpm brain:verify:u5` — Scenario A/B/C PASS
- `pnpm brain:verify:retrieval-quality` — 25/25 PASS
- `pnpm brain:verify:retrieval-multigoal` — 25/25 PASS
- `pnpm brain:verify:retrieval-real-dev` — 30/43 PASS, quality gate PASS

Ручних кроків не потрібно.
