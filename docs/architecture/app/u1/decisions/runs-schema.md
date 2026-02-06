# ADR: runs Table Schema (LEX-79 Spike)

## Context

Поточна таблиця `runs` в Supabase LEXERY LEGAL AGENT DB має базові поля. Архітектура вимагає додаткові поля для RunRecord.

## Поточна схема (до міграції)

- id, run_id, tenant_id, user_id, conversation_id
- status, query, query_profile, search_plan
- created_at, updated_at, completed_at

## Необхідні поля (Block Cards, answer.md)

| Поле | Тип | Призначення |
|------|-----|-------------|
| snapshot | jsonb | input, config, flags, versions — знімок контексту |
| degraded_flags | jsonb | частина деградація (Qdrant down, no critic) |
| error_code | text | код помилки при fail (DB_DOWN, QUEUE_FAIL, etc.) |
| attachments_manifest | jsonb | [{name, size, sha256, storage, r2_key?}] |
| idempotency_key | text | унікальний ключ (tenant-scoped) для повторних запитів |

## Рішення

Додати міграцію `add_runs_u1_fields`:

- `snapshot` JSONB DEFAULT '{}'
- `degraded_flags` JSONB DEFAULT '{}'
- `error_code` TEXT
- `attachments_manifest` JSONB
- `idempotency_key` TEXT
- UNIQUE (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL

## Міграція

Застосовано через Supabase MCP: `add_runs_u1_fields`.
