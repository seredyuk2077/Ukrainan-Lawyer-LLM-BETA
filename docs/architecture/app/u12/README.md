# [U12] Deliver — persistence & outbox (LEX-133 follow-up)

U12 завершує run: оновлює статус, опційно записує assistant message у `messages`, створює події `mm_outbox` для memory. GET /v1/runs/:id показує llm_result (durable з runs або RunContext).

## Inputs

- **run_id** (from event). Run and llm_result from DB (RunRepository.findByRunId).

## Actions

1. **completeRun(runId):** оновити runs: completed_at, updated_at; status = 'completed' або 'DONE' (fallback якщо runs_status_check дозволяє), інакше лише completed_at.
2. **messages:** якщо є conversation_id і answerText — insert assistant message (conversation_id, run_id, role='assistant', content). Не падати, якщо таблиці/схеми немає.
3. **mm_outbox:** insert event_type='index_memory', payload run_id, conversation_id, tenant_id, answer_summary; session_key=conversation_id; status='pending'. Не падати, якщо таблиці немає.

## Output

- Structured log: persistedToRuns, messageInserted, outboxEnqueued.

## Code

- `write/deliverConsumer.ts` — handleU12Event.
- `gateway/storage.ts` — completeRun(runId) з fallback по status constraint.

## Idempotency & Concurrency (Azure)

Для multi-instance (Azure) U12 працює так:

- **Claim U12:** перед deliver викликається `claimU12Run(runId)`: atomic `UPDATE runs SET status='U12_RUNNING'` WHERE `run_id=?` AND `completed_at IS NULL` AND status IN ('U11_DONE','Deliver'). Якщо claim повертає false — інстанс перечитує run; якщо `completed_at` вже є — вихід (ідемпотентно).
- **Message dedupe:** `insertAssistantMessageIfNotExists(runId, conversationId, content)` — select по conversation_id + role='assistant', перевірка `metadata.run_id === runId`; якщо вже є запис для цього run — skip.
- **Outbox dedupe:** `insertMmOutboxIfNotExists(runId, conversationId, tenantId, eventType, payload)` — select по event_type + payload.run_id; якщо вже є — skip.
- **Safe status:** `completeRun` використовує `safeUpdateRunStatus(runId, ['completed','U11_DONE','Deliver'], { completed_at })` — по черзі пробує дозволені статуси, щоб не падати на DB constraint.

## Pipeline

U11 → U12. U12 останній крок конвеєра; далі — зовнішні воркери (memory index, SSE тощо).

## DB schema notes

- `messages`: ідемпотентність через `metadata.run_id` (select-before-insert по conversation_id + role).
- `mm_outbox`: ідемпотентність через `payload.run_id` + `event_type` (select-before-insert). Потрібен `conversation_id` (FK).
- Міграції: `20260222100000_lexery_runs_llm_result.sql`, `20260225180000_lexery_runs_verify_result_and_status.sql` (runs.verify_result, статуси U10_RUNNING/DONE, U11_*, U12_RUNNING).
