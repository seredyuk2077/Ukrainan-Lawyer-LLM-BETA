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

## Multi-goal retrieval verify (62 cases)

**Команда:**

```bash
pnpm brain:verify:retrieval-multigoal
```

- 62 кейси: multi-goal/multi-act (корупція, бандитизм, тероризм, правочин, емансипація, договірний текст), cap transparency regression, noise guard regression (КСУ, порядок процедура, кодекс+окремі), універсальні запити.
- Очікування: goals_summary, fusion, act diversity, minGoals/minDistinctActsInTop, actTitleContains, requireSignalInTitle, expectCapTransparency, expectNoPlanner.
- Budget: median/p95 latency, % llm_planner_used ≤ порогу, qdrant_calls_total median/max, % hits_cap_applied (smell якщо >80%).

**Останній прогін:** 62/62 PASS.

- **Cases:** 62/62 PASS
- **Latency median ms:** ~3400
- **Latency p95 ms:** ~7100
- **% multi_goal_detected:** ~32
- **% llm_planner_used:** 0 (U4_PLANNER_ENABLED=false за замовчуванням)
- **qdrant_calls_total:** median 8, max 16
- **% hits_cap_applied:** ~24
- **Budget (median/p95/llm%/cap%):** PASS

## Останній повний прогін

- `pnpm brain:verify:u3` — smoke + U3/U3a plan test
- `pnpm brain:verify:u4` — Health + Smoke PASS
- `pnpm brain:verify:u5` — Scenario A/B/C PASS
- `pnpm brain:verify:retrieval-quality` — 25/25 PASS
- `pnpm brain:verify:retrieval-multigoal` — 62/62 PASS, Budget PASS

Ручних кроків не потрібно.
