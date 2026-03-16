# [U5] Gate — expand decision (LEX-118, LEX-131)

U5 приймає retrieval_trace + query_profile + search_plan і вирішує: **expand** (U6 DocList/Expand) чи **no expand** (U9 Assemble).

## Контракт GateDecision

- **expand**: boolean
- **reason_codes**: FEW_HITS | LOW_SCORE | DIRECT_REF_MISSING | AMBIGUOUS_QUERY | NEED_DEEP_RETRIEVAL | DEGRADED_LLDBI | DOCLIST_DISABLED | FORCE_EXPAND | OK
- **thresholds**: min_hits, min_avg_score
- **signals**: hits_count, top_score, avg_score, has_direct_citation, ambiguous, degraded_lldbi, need_deep_retrieval
- **meta**: decision_version, evaluated_at_ms, duration_ms

## Код

- `gate/types.ts` — GateDecision Zod
- `gate/gate.ts` — evaluateGate(input)
- `gate/consumer.ts` — handleU5Event: load run, evaluateGate, persist gate_decision, enqueue U6 або U9
- `expand/consumer.ts` — U6 connectivity stub (log + enqueue U9)
- `lib/pipeline/contracts.ts` — RunContext, U4Result, GateInput, GateDecision re-exports, gateStatus()

## ENV (canonical + safe defaults)

| Env | Default | Опис |
|-----|---------|------|
| GATE_MIN_HITS_THRESHOLD | 3 | Мінімум hits для no-expand |
| GATE_MIN_AVG_SCORE | 0.18 | Мінімум avg score |
| DOCLIST_ENABLED | true | Чи дозволений DocList/Expand |
| FORCE_EXPAND | false | Для тестування: завжди expand |
| GATE_DECISION_VERSION | 1 | Версія контракту |

## Persistence

- **runs.gate_decision** (jsonb) — міграція add_runs_gate_decision. GET /v1/runs/:id повертає gate_decision.
- RunContext: gate_decision для наступних кроків (U6/U9).

## One-command verification

```bash
pnpm brain:verify:u5
pnpm brain:test:gate-units
```

Три сценарії: A) "ККУ ст. 115" (gate_decision присутній, baseline `expand=false`), B) "мобілізація" (soft-ambiguity scenario; verifier фіксує поточне gate-рішення, яке зараз зазвичай лишається `expand=false` після ambiguity suppression), C) `QDRANT_URL=` (degraded U4 → `expand=true`, `DEGRADED_LLDBI`). Без ручних кроків.
