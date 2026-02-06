# Pipeline U1 → U2 (single source of truth)

Короткий покроковий опис: що зберігається де, як передається керування.

## Кроки

1. **U1 Gateway/Intake**
   - Вхід: `POST /v1/runs` (query, tenant_id, user_id, attachments, …).
   - Перевірки: auth, rate limit, concurrent runs, request size.
   - Збереження: **RunRecord** у Postgres (runs): run_id (UUID), tenant_id, user_id, status=Intake, **query** (текст), snapshot (request/auth/flags), attachments_manifest.
   - Якщо є вкладення > порога — overflow у **R2** (bucket lexery-legal-agent), у DB лише manifest з r2_key.
   - Вихід: 202 + run_id. Подія **RunEvent** { run_id, step: "U2", created_at, trace_id } ставиться в **TaskQueue**.

2. **TaskQueue**
   - Dev: in-memory (handlers викликаються синхронно при enqueue).
   - Prod (опційно): Redis-backed черга; ключування/namespace щоб не змішувати тенантів (run_id унікальний глобально).

3. **U2(0) Consumer**
   - Вхід: подія з черги (run_id, step "U2").
   - Завантаження: RunRecord по run_id з Postgres (query, snapshot). Query може бути в DB або (якщо є query_ref) — посилання на R2.
   - Внутрішні кроки: **InputNormalizer** (довгий/шум) → **U2c** extractEntities(query) → **U2a** intent, **U2b** domain, **U2d** ambiguity (rules). За налаштуванням: **LLM** (OpenRouter) або тільки rules; entities merge(pre, llm).
   - Збереження: **RunContext** (get/set по run_id) — query_profile + routing_flags, TTL 1 год. **RunRecord** оновлюється: query_profile (повний JSON з meta), status=Profiling.
   - Вихід: лог "would enqueue U3". Контракт для U3: RunRecord.query_profile з pipeline_step "U2d_done", RunContext або DB.

## Де що зберігається

| Що | Де |
|----|-----|
| RunRecord (run_id, tenant_id, user_id, query, status, query_profile, snapshot) | Postgres `runs` |
| Великі вкладення | R2 bucket lexery-legal-agent, ключі runs/{tenant_id}/{run_id}/… |
| Query (якщо дуже великий і включено overflow) | R2 runs/{tenant_id}/{run_id}/input/query.txt; у DB query_ref або preview |
| QueryProfile + routing_flags (на час життя run) | RunContext (in-memory Map або Redis lexery:runctx:{run_id}) |
| Черга подій U2 | In-memory або Redis (lexery:q:u2) |

## Ізоляція

- run_id — UUID, унікальний глобально; змішування юзерів/тенантів неможливе по run_id.
- У DB кожен запис має tenant_id, user_id; RLS (якщо увімкнено) фільтрує по tenant.
- Redis: префікси lexery:runctx:, lexery:q: — один інстанс/ключі не перетинаються з іншими додатками.
