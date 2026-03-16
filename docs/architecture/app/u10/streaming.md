# U10 Streaming Contract — SSE Events (DEV RUN v10)

**Status:** Spec only (no live SSE in dev); buffer-in-snapshot approach for frontend polling.  
**Date:** 2026-02-28  
**Scope:** U10 Write → frontend SSE channel

---

## Principle: No Chain-of-Thought Leakage

The internal chain-of-thought (thinking tokens from a thinking-enabled model) is **never streamed** to the frontend.  
We stream only:
- Structured progress events (metadata)
- Selected source identifiers (after triage)
- Draft answer tokens (final answer only, not reasoning)
- Completion/verdict events

---

## SSE Event Types

All events follow the SSE `data:` format:

```
data: {"type": "event_type", ...payload}\n\n
```

### 1. `run.started`
Emitted when run enters pipeline (U1/U2).
```json
{
  "type": "run.started",
  "run_id": "uuid",
  "trace_id": "uuid",
  "ts": "ISO8601"
}
```

### 2. `u9.completed`
Emitted after U9 Assemble completes. Counts only — no content.
```json
{
  "type": "u9.completed",
  "run_id": "uuid",
  "law_count": 20,
  "memory_count": 3,
  "history_count": 2,
  "token_estimate": 5380,
  "truncated": false,
  "ts": "ISO8601"
}
```

### 3. `u10.triage.completed`
Emitted after evidence triage (when triage_enabled and law_count > threshold).
```json
{
  "type": "u10.triage.completed",
  "run_id": "uuid",
  "total_law": 20,
  "selected_count": 7,
  "dropped_count": 13,
  "ts": "ISO8601"
}
```

### 4. `u10.generation.started`
Emitted immediately before LLM call begins.
```json
{
  "type": "u10.generation.started",
  "run_id": "uuid",
  "model": "anthropic/claude-sonnet-3-7",
  "evidence_insufficient": false,
  "ts": "ISO8601"
}
```

### 5. `u10.delta`
Emitted for each token chunk from the LLM stream. **Answer tokens only, no thinking.**
```json
{
  "type": "u10.delta",
  "run_id": "uuid",
  "delta": "token text here",
  "ts": "ISO8601"
}
```

### 6. `u10.completed`
Emitted when LLM generation is done.
```json
{
  "type": "u10.completed",
  "run_id": "uuid",
  "model": "anthropic/claude-sonnet-3-7",
  "usage": { "prompt_tokens": 4200, "completion_tokens": 800 },
  "warnings": [],
  "latency_ms": 12500,
  "ts": "ISO8601"
}
```

### 7. `u11.verdict`
Emitted after U11 verification.
```json
{
  "type": "u11.verdict",
  "run_id": "uuid",
  "verdict": "complete",
  "critic_passed": true,
  "ts": "ISO8601"
}
```

### 8. `u12.completed`
Emitted when pipeline finishes.
```json
{
  "type": "u12.completed",
  "run_id": "uuid",
  "conversation_id": "uuid",
  "outbox_enqueued": true,
  "ts": "ISO8601"
}
```

---

## Implementation Options

### Option A: Real-time SSE (future)
- Client connects to `GET /v1/runs/:id/stream`
- Server uses SSE (Content-Type: `text/event-stream`)
- OpenRouter streaming adapter forwards answer tokens as `u10.delta` events
- U10 thinking tokens filtered server-side before forwarding
- **Status:** Not yet implemented

### Option B: Buffer-in-snapshot (current dev approach)
- Events are accumulated in `runs.snapshot.stream_events` (JSON array)
- Frontend polls `GET /v1/runs/:id` → reads `snapshot.stream_events`
- No real-time but allows frontend to show progress retroactively
- Low complexity for dev phase
- **Status:** Partially implemented (u10_preview in snapshot)

### Option C: Hybrid (recommended for production)
- Real-time SSE during active run
- Snapshot fallback for late joiners / reconnect
- Events deduplicated by `ts + type + run_id`

---

## Thinking Token Policy

| Source | Streamed? | Stored? |
|--------|-----------|---------|
| `<thinking>` block from a thinking-enabled model | ❌ Never | ❌ Never |
| Composer instructions | ❌ Never | ❌ Never |
| Triage reasoning | ❌ Never | ❌ Never |
| Final answer tokens | ✅ via `u10.delta` | ✅ in `llm_result.answerText` |
| Evidence counts | ✅ in `u9.completed` | ✅ in `assembled_prompt.meta` |
| Selected source IDs | ✅ in triage event | ✅ in `snapshot` |

---

## Token Budget Discipline

Before streaming answer:
1. U9 token budget logged: `tokenEstimateTotal`, `truncated`
2. Triage: reduces law snippets to ≤8 before a thinking-enabled model call
3. Thinking model sees: selected law snippets + memory + history (no excess)
4. Answer only forwarded to frontend (no internal reasoning)

---

## OpenRouter Streaming Notes

OpenRouter supports streaming via `stream: true` parameter. Thinking-enabled OpenRouter models return two content block types:
- `thinking`: private reasoning — **must be filtered on server**
- `text`: final answer — forward as `u10.delta` events

Server-side filter pseudocode:
```typescript
for await (const chunk of openrouterStream) {
  if (chunk.type === 'content_block_delta') {
    if (chunk.delta.type === 'text_delta') {
      // Safe to stream
      emit({ type: 'u10.delta', delta: chunk.delta.text });
    }
    // 'thinking_delta' type → drop silently
  }
}
```

---

## Security Notes

- Never emit `thinking` content blocks to frontend
- Never emit system prompt content
- Never emit raw RAG snippets (only counts/IDs)
- Rate-limit SSE connections per tenant
- SSE connections timeout after 120s (LLM max latency)

---

## Next Steps (before enabling real SSE)

1. Add `stream: true` to OpenRouter client when LEGAL_AGENT_STREAMING=true
2. Filter thinking blocks server-side
3. Implement `GET /v1/runs/:id/stream` endpoint
4. Test with 1 manual live call to verify no CoT leakage
5. Add rate limiting + timeout handling
