# ADR: U10 Multi-level Prompt Stack (DEV RUN v8)

**Date:** 2026-02-28
**Status:** Accepted
**Task:** LEX-133

## Context

Product frontend буде підтримувати: Global / Project / Chat / User system prompts. Наразі `chat_sessions` не має відповідних колонок. U10 потребує коректного стекапу без дублювання токенів.

## Decision

### 1. PromptStack interface (lib/pipeline/contracts.ts)
```typescript
interface PromptStack { global?, project?, chat?, user? }
```
Зберігається в `runs.snapshot.prompt_stack` (jsonb, без нової міграції).
Отримується через `POST /v1/runs body.client_context.prompt_stack`.

### 2. Assembly rule (`buildPromptStack`)
Order: `global → project → chat → user`.
- `global` defaultsto `GLOBAL_SAFETY_PROMPT` (evidence-only Ukrainian legal agent policy).
- `user` appended як "Additional user instructions (no safety override)" — ніколи не override global.

### 3. Where stored
`runs.snapshot.prompt_stack` (JSONB merge в handler.ts) — поточне рішення.  
Майбутнє: додати колонки до `chat_sessions` коли продукт backend інтегрується.

### 4. RunContext.prompt_stack
U10 consumer читає `prompt_stack` з `runs.snapshot` (primary) або з RunContext (fallback).

## Non-goals
- Не додаємо колонки до chat_sessions/messages (немає потреби в цьому рані)
- User prompt НЕ має більший пріоритет ніж global safety
