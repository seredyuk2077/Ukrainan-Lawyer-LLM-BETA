# U10 Real LLM Readiness Checklist

> DEV RUN v14 | Last updated: 2026-02-28

**v14 acceptance (umysne vbivstvo):** Answer must start with citation (ч. 1 ст. 115), include Склад злочину (4 elements), not say "надані матеріали"; use "витяги з норм законодавства з внутрішньої бази Lexery". FocusSpec + validator enforce this.

Use this before enabling real LLM in production or running sanity runs.

## Env vars required

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY_BRAIN` | OpenRouter key for U9/U10 (composer, triage, memory extractor, embeddings). Precedence: BRAIN > ONLINE. |
| `LEGAL_AGENT_DISABLE_LLM` | `true` = dry-run (stub answer, no cost). `false` = real LLM. Default in scripts: `true`. |
| `DEV_API_KEY` or `DEV_ALLOW_ANONYMOUS=true` | For dev chat CLI tools and local API calls (auth). |
| Supabase / R2 / Qdrant | As per main runbook (DB, R2 bucket, memory collection). |

## Safety toggles

- **Dry-run by default**: `pnpm brain:chat:dev` uses `LEGAL_AGENT_DISABLE_LLM=true` unless `--real-llm` is passed.
- **Real LLM**: Requires `--real-llm` and `--i-understand-costs` on the CLI; set `LEGAL_AGENT_DISABLE_LLM=false` (or omit) when running.

**CLI chat (interactive + single-shot):** see [cli-chat.md](./cli-chat.md) for `pnpm brain:chat` and `pnpm brain:chat:run`.

## Commands to run (order)

1. **Capabilities (no LLM)**  
   `pnpm brain:db:capabilities`  
   `pnpm brain:r2:capabilities`

2. **Dry-run E2E (CLI)**  
   `LEGAL_AGENT_DISABLE_LLM=true DEV_ALLOW_ANONYMOUS=true pnpm brain:chat:dev -- --dry-run --message "Ваше питання"`

3. **One real LLM sanity run (only after all above PASS)**  
   `LEGAL_AGENT_DISABLE_LLM=false DEV_ALLOW_ANONYMOUS=true pnpm brain:chat:dev -- --real-llm --i-understand-costs --message "Поясни склад злочину умисного вбивства за КК України і наведи статтю"`

## Expected outputs

- **Dry-run**: status `completed`, final answer `[DRY_RUN] Legal agent disabled in verify mode.`, run stored in Supabase.
- **Real LLM**: status `completed`, `llm_result` with `answerText`, model id, usage; citations/sourceRefs in answer.

## MCP / DB proof (after run)

```sql
SELECT run_id, status, assembled_prompt IS NOT NULL AS has_assembled, llm_result IS NOT NULL AS has_llm_result, completed_at
FROM runs WHERE run_id = '<run_id>';
```

## Rollback

- Set `LEGAL_AGENT_DISABLE_LLM=true` and redeploy / restart.
- Do not run `--real-llm` without explicit cost confirmation.
