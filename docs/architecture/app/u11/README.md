# [U11] Verify — verdict scaffold (LEX-133 follow-up)

U11 виносить структурований вердикт по результату U10 (complete | retry | failed). Повна верифікація (CoverageCritic, CrossEncoderReranker, StopPolicy) — майбутня; зараз мінімальний scaffold.

## Inputs

- **llm_result** (from DB or RunContext): LegalAgentResult з U10.
- **RunContext** (from RunContextStore): для збереження verify_result.

## Output

- **VerifyResult**: verdict (`complete` | `retry` | `failed`), reasons?, metrics? (coverageScore).
- Зберігається durable в `runs.verify_result` (jsonb) та в RunContext; після U11 enqueue U12.

## Logic (scaffold)

- Якщо `llm_result.answerText` non-empty → verdict `complete`.
- Інакше → verdict `failed`, reasons e.g. `["Empty answer"]` або `["Missing llm_result"]`.
- Контракт `retry` залишається для майбутньої реалізації (retry_with_more_evidence).

## Concurrency & Durable persistence (Azure)

- **Claim U11:** перед verify викликається `claimU11Run(runId)`: atomic `UPDATE runs SET status='U11_RUNNING'` WHERE `run_id=?` AND `verify_result IS NULL` AND status IN ('U10_DONE','Verifying','Deliver'). Якщо claim false — перечит run; якщо `verify_result` вже є — enqueue U12 і вихід (ідемпотентно).
- **Durable verify_result:** результат зберігається в `runs.verify_result` (jsonb) через `persistVerifyResult(runId, verifyResult)` з safe status update (`U11_DONE` / Deliver / completed). Будь-який інстанс може прочитати verify_result для run_id з DB.

## Code

- `lib/pipeline/contracts.ts` — `VerifyResult`.
- `write/verifyConsumer.ts` — handleU11Event: claim U11, read llm_result (DB/context), compute verdict, persistVerifyResult, enqueue U12.
- `gateway/storage.ts` — claimU11Run, persistVerifyResult, safeUpdateRunStatus.

## Observability

- Structured log: run_id, step U11, verdict, reasons.

## Pipeline

U10 → U11 → U12. U11 не викликає LLM; тільки правила по llm_result.
