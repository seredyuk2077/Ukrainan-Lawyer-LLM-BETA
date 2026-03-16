# [U10] Legal Agent — LLM writer (LEX-133)

U10 викликає сконфігуровану Legal Agent модель через OpenRouter (поточний baseline: `openai/gpt-5.2`) для генерації відповіді. Evidence-only: промпт зібраний у U9 (`system + user + context law/docs/memory/history`).

## Inputs

- **RunContext** (from RunContextStore): assembled_prompt, tenant_id, user_id, conversation_id, user_input, history, memory_*, gate_decision, **prompt_stack** (new, DEV RUN v8).
- **AssembledPrompt** (stored by U9): systemPrompt, userPrompt, contextParts, meta (budget, sources, loadErrorsCount, degraded).
- **prompt_stack** (from runs.snapshot.prompt_stack): PromptStack — global/project/chat/user system prompt levels.

## Output

- **LegalAgentResult**: answerText, model, latencyMs, finishReason?, usage? (prompt_tokens, completion_tokens), warnings? (e.g. `['evidence_insufficient']`), citations?, usedSources?.
- Result stored in **runs.llm_result** (durable, multi-instance) and RunContext.

## Prompt Stack (DEV RUN v8)

Multi-level system prompt hierarchy:

| Level | Source | Priority |
|-------|--------|----------|
| `global` | Default: `GLOBAL_SAFETY_PROMPT` (evidence-only, Ukrainian) | Highest — always first |
| `project` | From product backend (per folder/project) | 2nd |
| `chat` | Per conversation/session | 3rd |
| `user` | User-provided "additional instructions" | Lowest — never overrides safety |

**Assembly:** `buildPromptStack(stack?: PromptStack): string`  
Stored in `runs.snapshot.prompt_stack` and read by U10 consumer.  
Accepted via `POST /v1/runs body.client_context.prompt_stack`.  
`chat_sessions` table does not yet have system_prompt columns — snapshot is source of truth.

### Evidence Insufficient Policy

When law evidence is missing/degraded/gate says rag_missing:
- `isEvidenceInsufficient(assembled, runContext)` returns `true`
- U10 prepends `EVIDENCE_INSUFFICIENT_PREFIX` to system prompt
- LLM is instructed NOT to answer from general knowledge
- `LegalAgentResult.warnings = ['evidence_insufficient']`
- Prompt Composer is **skipped** (no point composing when evidence absent)

Triggers: `meta.sources.lawCount === 0` OR `(degraded && loadErrorsCount > 0)` OR `gate.expand === true`

### Context Structure

Evidence sections sent to LLM (structured, not flat):
```
=== LAW EVIDENCE ===
<law snippets, one per part>

=== USER DOCUMENTS ===
<retrieved user/project/global document snippets when docs mode is active>

=== MEMORY CONTEXT ===
<memory items + summaries>

=== CHAT HISTORY ===
<history messages>
```

### Context Budget Truncation Warning

When `assembled.meta.budget.truncated === true`:
- System prompt gets: `⚠️ NOTE: The legal context was truncated due to token budget limits.`

## Prompt Composer

- Skipped when `evidence_insufficient = true` (no wasted tokens)
- Returns `{ appendix, modelUsed, latencyMs }` — latencyMs now tracked
- Logged: `composer_used`, `composer_model`, `composer_latency_ms`
- Model selection: score ≥ 6 → complex composer model (default `openai/gpt-5.2`); score < 6 → lightweight composer model (default `openai/gpt-5-nano`); score ≤ 2 → skip

## Memory Readiness

- U10 logs memory_items_count, memory_summaries_count, memory_degraded (metadata only, no content)
- If `runContext.memory_trace.degraded=true` → `logger.warn('U10 memory degraded')`
- Memory channel is clearly separated from law (distinct section header)
- No special handling needed — memory is just another context channel

## Model & Config

- **Model:** configured Legal Agent model, default `openai/gpt-5.2` (OpenRouter)
- **Config:** `config.legalAgentModelId`, `config.legalAgentTimeoutSec` (55s), `config.legalAgentMaxTokens` (4096)

## Concurrency & Idempotency

- Handler stateless; no global mutable state
- `claimU10Run`: atomic DB update → U10_RUNNING where `llm_result IS NULL`
- DB `runs.llm_result` (durable) → multi-instance safe
- Dry-run / CI: `LEGAL_AGENT_DISABLE_LLM=true` → stub, no composer, no LLM

## Observability

Structured `U10 finished` log fields:
- `model`, `latency_ms`, `u10_latency_ms`, `tokens_in`, `tokens_out`
- `composer_used`, `composer_model`, `composer_latency_ms`
- `evidence_insufficient`, `has_prompt_stack`
- No prompt/answer content logged

## Code

- `write/legalAgent.ts` — `buildPromptStack`, `isEvidenceInsufficient`, `buildMessagesFromAssembled`, `runLegalAgent`
- `write/consumer.ts` — `handleU10Event`: dry_run/stub, claim, memory log, evidence check, composer, LLM, persist, enqueue U11
- `write/promptComposer.ts` — `computeComplexityScore`, `composeInstructions` (returns latencyMs)
- `lib/pipeline/contracts.ts` — `PromptStack`, `RunContext.prompt_stack`
- `gateway/handler.ts` — extracts `client_context.prompt_stack` → snapshot

## Historical notes

Point-in-time DEV RUN reports і stabilization notes живуть у `reports/`; канонічні contracts / verification docs лишаються в корені `u10/`.

## Verification

```bash
pnpm brain:test:u10-units
pnpm brain:verify:u5        # Server-level gate smoke with dry-run U10/U11/U12 path enabled
```

Pipeline: U9 → U10 (Legal Agent + optional Composer) → U11 → U12.
