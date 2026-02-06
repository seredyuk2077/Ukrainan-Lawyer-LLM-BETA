# U1 Gateway — Lexery Legal Agent Brain

## Опис

[U1] Gateway/Intake — вхідні двері Lexery Legal AI Agent. Приймає `POST /v1/runs`, перевіряє доступ і ліміти, створює RunRecord у Supabase, ставить подію в чергу для [U2] Classify.

## Запуск локально

```bash
# З root проєкту
pnpm brain:dev
```

Сервер слухає порт 3081 (або `BRAIN_PORT`).

## Env змінні

| Змінна | Опис |
|--------|------|
| BRAIN_PORT | Порт HTTP (default 3081) |
| DEV_API_KEY | Ключ для X-Dev-API-Key (dev auth) |
| DEV_ALLOW_ANONYMOUS | true = дозволити без ключа в dev (потрібні tenant_id, user_id) |
| SUPABASE_LEXERY_LEGAL_AGENT_DB_URL | Supabase URL |
| SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY | Service role key |
| RUNS_PER_MINUTE | Rate limit (default 30) |
| ATTACHMENT_INLINE_MAX_BYTES | Max attachment size inline (default 512KB) |
| R2_RUNS_BUCKET | R2 bucket для runs/attachments overflow (default: lexery-legal-agent) |
| R2_LEGISLATION_BUCKET | R2 bucket для legislation (default: legislation) |

## Curl приклади

### Dry-run

```bash
curl -X POST http://localhost:3081/v1/runs \
  -H "Content-Type: application/json" \
  -H "X-Dev-API-Key: your-dev-key" \
  -d '{
    "query": "Які підстави для звільнення?",
    "tenant_id": "00000000-0000-0000-0000-000000000001",
    "user_id": "00000000-0000-0000-0000-000000000002",
    "dry_run": true
  }'
```

### Real run

```bash
curl -X POST http://localhost:3081/v1/runs \
  -H "Content-Type: application/json" \
  -H "X-Dev-API-Key: your-dev-key" \
  -d '{
    "query": "Які підстави для звільнення за власним бажанням?",
    "tenant_id": "00000000-0000-0000-0000-000000000001",
    "user_id": "00000000-0000-0000-0000-000000000002"
  }'
```

### 401 (без ключа)

```bash
curl -X POST http://localhost:3081/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}'
```

### Idempotency

```bash
curl -X POST http://localhost:3081/v1/runs \
  -H "Content-Type: application/json" \
  -H "X-Dev-API-Key: your-dev-key" \
  -d '{
    "query": "Test",
    "tenant_id": "00000000-0000-0000-0000-000000000001",
    "user_id": "00000000-0000-0000-0000-000000000002",
    "idempotency_key": "my-unique-key-123"
  }'
```

### Health

```bash
curl http://localhost:3081/health
```

## Error codes

| Code | HTTP | Опис |
|------|------|------|
| UNAUTHORIZED | 401 | Невірний або відсутній X-Dev-API-Key |
| VALIDATION_ERROR | 400 | Невірний body |
| ERR_BUDGET_EXHAUSTED | 429 | Rate limit або concurrent runs |
| DB_DOWN | 503 | Supabase недоступний |
| QUEUE_FAIL | 503 | Черга недоступна |
| INTERNAL_ERROR | 500 | Внутрішня помилка |

## Self-test

```bash
# Запустити Brain в іншому терміналі
pnpm brain:dev

# Запустити self-test
DEV_API_KEY=your-dev-key pnpm brain:selftest
```
