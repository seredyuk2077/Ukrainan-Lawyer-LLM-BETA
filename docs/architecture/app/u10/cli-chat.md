# Lexery Brain — CLI Chat (How Andriy Tests)

> DEV RUN v15. Interactive terminal chat + single-shot run. No frontend, no manual DB digging.

---

## Як потестити за 5 хв

1. **Dry-run (одна команда):**  
   `pnpm brain:chat` → введи повідомлення → Enter. Отримаєш stub-відповідь і run summary (run_id, total_ms, model).
2. **Single-shot без REPL:**  
   `pnpm brain:chat:run -- --message "Поясни склад умисного вбивства за КК України"` — те саме, але без інтерактиву.
3. **Real LLM (1–2 рази за сесію):** У REPL: `/mode real` → введи `YES` → напиши запит. Або однією командою:  
   `pnpm brain:chat:run -- --real-llm --i-understand-costs --message "..."`.
4. **Перевірка в DB:** run_id з summary →  
   `SELECT run_id, status, completed_at FROM runs WHERE run_id = '<run_id>';`

Env: `DEV_ALLOW_ANONYMOUS=true` (або `DEV_API_KEY`). Для real LLM: `OPENROUTER_API_KEY_BRAIN`.

---

## 1) Setup

### Env (required for full pipeline)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_LEXERY_LEGAL_AGENT_DB_URL` | Supabase project URL (Lexery Legal Agent DB). |
| `SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY` | Service role key for runs/messages. |
| `OPENROUTER_API_KEY_BRAIN` (or `OPENROUTER_API_KEY_ONLINE`) | For real LLM (U10, composer, triage). |
| `R2_*` | R2 credentials + bucket (legislation, runs overflow). |
| `Qdrant_*` / `QDRANT_*` | Qdrant endpoint + API key (memory semantic). |
| `DEV_ALLOW_ANONYMOUS=true` or `DEV_API_KEY` | Auth for local CLI (no product backend). |

### Check capabilities (no LLM)

```bash
pnpm brain:db:capabilities
pnpm brain:r2:capabilities
```

---

## 2) Quick start (dry-run)

One command to open the chat:

```bash
pnpm brain:chat
```

- Default: **dry-run** (LLM disabled, stub answer).
- Default tenant/user/conversation: seed UUIDs (same as `seed-dev-user`).
- Type your message and press Enter. After the run you see: **Lexery:** answer + **Run summary** (run_id, total_ms, lawCount, memoryCount, triage_used, evidence_insufficient, usage if real).

### Example (dry-run)

```
You: Поясни склад злочину умисного вбивства за КК України

Lexery: [DRY_RUN] Legal agent disabled in verify mode.

--- Run summary ---
run_id: ...
total_ms: ...
```

### Toggle memory / triage

Memory semantic and triage are **env-driven** (read at server start). To change:

- Memory: `MEMORY_SEMANTIC_ENABLED=true pnpm brain:chat`
- Triage: `EVIDENCE_TRIAGE_ENABLED=true pnpm brain:chat`

Restart the process after changing env.

---

## 3) Interactive commands

| Command | Description |
|---------|-------------|
| `/mode dry` | Use dry-run (default). |
| `/mode real` | Switch to real LLM (then type `YES` to confirm costs). |
| `/triage on` / `/memory on` | Show reminder: set env and restart. |
| `/prompt show` | Show prompt_stack keys and lengths (no full content). |
| `/prompt set user` | Enter multi-line user prompt (end with empty line or `.`). |
| `/new` | New conversation_id (new UUID). |
| `/status` | Print tenant_id, user_id, conversation_id, mode, real_llm_confirmed, real_run_count, verbose. |
| `/run <message>` | Send one message (same as typing the message). |
| `/verbose on` / `off` | Toggle DB verification line after each run (completed_at, has_assembled, has_llm_result). |
| `/exit` | Quit. |

---

## 4) Real LLM (1–2 runs per session)

1. In the REPL: `/mode real`
2. Type: `YES` (confirms you understand costs).
3. Send your message. You get a real answer + usage/tokens.
4. **Safety:** max **2** real LLM runs per interactive session. Restart for more, or `pnpm brain:chat -- --unsafe-unlimited` (not recommended).

### Single-shot real run (no REPL)

```bash
pnpm brain:chat:run -- --real-llm --i-understand-costs --message "Поясни склад злочину умисного вбивства за КК України і наведи статтю"
```

Use `--tenant`, `--user`, `--conversation` with **UUIDs**. Aliases: `tenant-dev`, `user-dev-andrii`, `conv-dev-andrii` resolve to seed UUIDs.

### Example queries (real LLM)

- “Поясни склад злочину умисного вбивства за КК України і наведи статтю” — expect citation (ч. 1 ст. 115), Склад злочину, санкція.
- “Як мене звати?” — if memory is enabled and you have stored facts.

### Verify in Supabase

After a run, copy the `run_id` from the summary. Then:

```sql
SELECT run_id, status, assembled_prompt IS NOT NULL AS has_assembled, llm_result IS NOT NULL AS has_llm_result, completed_at
FROM runs WHERE run_id = '<run_id>';
```

---

## 5) Debug / troubleshooting

- **Answer off-topic**  
  Enable `/verbose on` and check run summary: triage_used, lawCount. Run `pnpm brain:test:u10-units`; ensure FocusSpec/triage tests pass.

- **Memory not used**  
  - `MEMORY_SEMANTIC_ENABLED=true` and restart.  
  - `pnpm brain:mm:smoke` to check memory pipeline.  
  - Same tenant/user/conversation as seed so history is attached.

- **R2 / legislation errors**  
  `pnpm brain:r2:capabilities` to verify bucket and keys.

- **Single-shot with DB check**  
  `pnpm brain:chat:run -- --message "..." --verbose` — prints a short DB verification block (completed_at, has_assembled, has_llm_result).

---

## 6) Command reference

| Command | Description |
|---------|-------------|
| `pnpm brain:chat` | Interactive chat (REPL). |
| `pnpm brain:chat:interactive` | Same as `brain:chat`. |
| `pnpm brain:chat:run -- --message "..."` | Single-shot (dry-run by default). |
| `pnpm brain:chat:run -- --real-llm --i-understand-costs --message "..."` | Single-shot real LLM. |
| `pnpm brain:chat:dev -- --message "..."` | Alias for single-shot (same as `brain:chat:run`). |

Optional flags for `brain:chat:run`: `--tenant`, `--user`, `--conversation`, `--verbose`, `--prompt-stack-json '{"user":"..."}'`, `--prompt-stack-file path/to.json`, `--project-id <id>`.
