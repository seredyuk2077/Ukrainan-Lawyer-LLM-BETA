# [U1] Gateway/Intake — Implementation

Вхідні двері Lexery Legal AI Agent. Приймає `POST /v1/runs`, перевіряє доступ і ліміти, створює RunRecord у Supabase, ставить подію в чергу для [U2] Classify.

## Документація

| Документ | Опис |
|----------|------|
| [gateway.md](./gateway.md) | API, env, curl приклади |
| [decisions/attachments.md](./decisions/attachments.md) | ADR: формат вкладень, R2 bucket |
| [decisions/entrypoint.md](./decisions/entrypoint.md) | ADR: Brain як окремий сервіс |
| [decisions/queue-boundary.md](./decisions/queue-boundary.md) | ADR: U1→U2 queue |
| [decisions/runs-schema.md](./decisions/runs-schema.md) | ADR: runs table schema |
| [test-results.md](./test-results.md) | Результати тестування |
| [../../../api/v1-runs.yaml](../../../api/v1-runs.yaml) | OpenAPI spec |

## Код

- `scripts/lexery-legal-agent/server.ts` — HTTP server
- `scripts/lexery-legal-agent/gateway/` — handler, auth, limits, storage, attachments
- `scripts/lexery-legal-agent/tools/migrate_r2_runs.ts` — міграція runs/ з legislation → lexery-legal-agent
