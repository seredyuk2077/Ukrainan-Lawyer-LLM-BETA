# U5 Gate — Результати перевірки

## One-command verification

```bash
pnpm brain:verify:u5
```

- Вибирає вільний порт, стартує server (BRAIN_PORT, DEV_API_KEY).
- Чекає /health (poll 250ms, timeout 20s).
- **Scenario A**: POST "ККУ ст. 115" → polling GET /v1/runs/:id до появи gate_decision. Типово expand=true (FEW_HITS/DIRECT_REF_MISSING при 1 hit) або expand=false при достатніх hits.
- **Scenario B**: POST "мобілізація" → polling до gate_decision. Verifier фіксує поточне runtime-рішення; на актуальному baseline це зазвичай `expand=false` після ambiguity suppression.
- **Scenario C**: Другий сервер з QDRANT_URL= і qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB= (degraded U4) → POST → gate_decision з expand=true, DEGRADED_LLDBI.
- Shutdown обох серверів. Summary + exit 0/1.

Ручних кроків не потрібно.

## Останній прогін

- Health: PASS
- Scenario A: PASS (gate_decision присутній)
- Scenario B: PASS (expand=false на поточному baseline)
- Scenario C: PASS (degraded U4 → expand=true, DEGRADED_LLDBI)
- Exit: 0
