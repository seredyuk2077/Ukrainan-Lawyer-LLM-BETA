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

## Останній прогін

- Health: PASS
- Smoke: PASS (retrieval_trace присутній; при наявному Qdrant — hits, при відсутності — degraded)
- Exit: 0
