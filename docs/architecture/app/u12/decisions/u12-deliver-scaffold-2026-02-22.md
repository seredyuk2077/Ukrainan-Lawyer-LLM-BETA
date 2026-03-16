# ADR: U12 Deliver minimal (2026-02-22)

## Context

U12 must finalize the run and prepare for memory/SSE without blocking. Tables messages/mm_outbox may not exist in all environments.

## Decision

- **completeRun:** Update runs.completed_at and updated_at; try status 'completed' then 'DONE'; on check constraint error, update only completed_at/updated_at.
- **messages:** Try insert assistant row when conversation_id and answerText present; catch and log on failure (schema/table optional).
- **mm_outbox:** Try insert index_memory event with session_key=conversation_id for future Azure Service Bus sessions; catch on failure.
- All persistence best-effort so U12 does not fail the pipeline if DB schema differs.

## Status

Accepted. Implemented in `write/deliverConsumer.ts`.
