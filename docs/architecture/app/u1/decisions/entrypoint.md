# ADR: Brain Service Entry Point (LEX-78 Spike)

## Context

Архітектура передбачає Brain як окремий мікросервіс. Поточний `backend/` — Product Backend (chat). Потрібно визначити: де живе U1 Gateway — окремий процес чи route в backend.

## Варіанти

| Варіант | Опис | Trade-offs |
|---------|------|------------|
| **A** | Окремий сервіс `scripts/lexery-legal-agent/` з власним HTTP server | Чітке розділення, незалежний деплой, окремий порт |
| **B** | Route `/v1/runs` в backend (проксі) | Менше процесів, але змішування продуктового і Brain коду |
| **C** | Monorepo з shared gateway module | Складніше, overkill для MVP |

## Рішення: **Варіант A**

Brain живе в `scripts/lexery-legal-agent/` як **окремий HTTP сервер** на власному порту (default 3081).

### Обґрунтування

1. **Мінімальна інвазивність** — backend залишається без змін, Brain розвивається окремо
2. **Чітке розділення** — Product Backend (chat/sessions) vs Brain (runs, U1–U12)
3. **Архітектурна узгодженість** — docs/architecture передбачає Brain як окремий компонент
4. **Майбутній деплой** — на Azure Brain може бути окремим Container App / Function

### Реалізація

- `scripts/lexery-legal-agent/server.ts` — Express HTTP server
- Порт: `BRAIN_PORT` env (default 3081)
- Маршрути: `POST /v1/runs`, `GET /health`
- Залежності: використовує root package.json (zod, @supabase/supabase-js, @aws-sdk/client-s3)
- Запуск: `pnpm tsx scripts/lexery-legal-agent/server.ts` або `pnpm brain:dev`

### Межа з Product Backend

- Product Backend (port 3001) в майбутньому може проксувати `/v1/*` до Brain (reverse proxy)
- Зараз Brain доступний напряму для dev
