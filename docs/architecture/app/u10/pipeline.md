# U10 in the pipeline

U10 runs after U9 Assemble. It reads `assembled_prompt` from RunContext, calls the configured Legal Agent model via OpenRouter (current default: `openai/gpt-5.2`), persists `llm_result`, and enqueues U11.

## Flow

1. **U9** stores assembled_prompt in RunContext and enqueues U10.
2. **U10** handleU10Event: `claimU10Run(run_id)` for multi-instance safety. If `llm_result` already exists → idempotent skip, enqueue U11. Else: build prompt stack + evidence sections (`LAW EVIDENCE`, `USER DOCUMENTS`, `MEMORY CONTEXT`, `CHAT HISTORY`), optionally run composer, call `runLegalAgent()`, persist `llm_result`, enqueue U11.
3. **U11** reads `llm_result`, computes/persists `verify_result`, then enqueues U12.
4. **U12** completes the run, optionally inserts assistant message / `mm_outbox`, and marks the run terminal.

## Diagram

```
U9 Assemble → U10 Legal Agent (GPT-5.2 baseline) → U11 Verify → U12 Deliver
```

Azure/concurrency: U10/U11/U12 use DB claims + durable persistence so parallel workers do not duplicate terminal work.
