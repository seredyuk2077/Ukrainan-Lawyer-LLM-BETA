# Lexery Legal Agent — Current Pipeline State
**Дата оновлення:** 2026-03-16  
**Джерело правди:** код у `scripts/lexery-legal-agent/`, міграції `supabase/migrations/`, stage docs `docs/architecture/app/`, реальні CLI smoke/live прогони цього dirty-tree.

---

## 1. Executive summary

Поточний runtime уже не є просто skeleton. End-to-end ланцюг `U1 -> U2 -> U3 -> U4 -> U5 -> U9 -> U10 -> U11 -> U12` працює, MM memory і MM Docs інтегровані, Redis queue + Redis RunContext стали штатною durable основою, а `Supabase / R2 / Qdrant` реально використовуються в бойовому маршруті.

Головний незакритий борг зараз не в handoff між стадіями, а в **якості відповіді U10** і в окремих великих runtime-модулях, які ще не розкладені на чистіші підсистеми. U6 лишається stub-path для expansion, а U11 поки що є **мінімальним verdict scaffold**, а не повним critic/rerank/web loop.

---

## 2. Поточний pipeline по стадіях

| Stage | Поточна роль | Реальний стан |
|------|---------------|---------------|
| **U1 Gateway** | HTTP intake, auth/dev gate, run persistence, enqueue | Працює. Durable path через `runs`, Redis queue, Redis RunContext. |
| **U2 Classify** | Query profile, domain tagging, ambiguity, routing flags | Працює. Є unit coverage, але quality/JSON-brittleness ще не ідеальні. |
| **U3 / U3a Plan** | Build SearchPlan (`use_lldbi`, `use_memory`, `use_doclist`, thresholds, reason_codes`) | Працює стабільно; mixed/memory/law routing реально керують downstream policy. |
| **U4 CacheRAG** | LLDBI retrieval, memory retrieval hooks, retrieval trace | Працює. Побудовано `compact trace in DB + full trace in R2`; semantic memory infra жива. |
| **U5 Gate** | Decide `expand=false/true`, degrade handling | Працює. Поточний baseline: A `expand=false`, B `expand=false`, C degraded `expand=true`. |
| **U6 Expand** | Expansion / doclist escalation path | Частково. Код і wiring є, але це не основний продовий шлях і не завершений quality-layer. |
| **U9 Assemble** | Build evidence-only prompt from `law + docs + memory + history` | Працює добре. Є MM Docs channel, meta-triage, budgeting, R2 snippet load, compact persistence. |
| **U10 Write** | Prompt stack, evidence triage, focus spec, model call, output validation | Працює. Це головне місце поточного quality gap: pipeline живий, але answer quality ще треба покращувати. |
| **U11 Verify** | Verdict after U10 | Працює як scaffold: `complete | failed` based on `llm_result`, durable `verify_result`, enqueue U12. Повного critic-loop ще немає. |
| **U12 Deliver** | Persist assistant message, patch source summary, enqueue MM outbox, complete run | Працює. Durable/idempotent path побудований. |
| **MM Memory** | Outbox -> summaries/items -> semantic index -> U9 memory channel | Працює. Semantic infra, outbox, source summary, isolation tests і runtime checks є. |
| **MM Docs** | Ingest attachments/doc candidates -> R2/DB/Qdrant -> retrieve snippets into U9 | Працює. Live smoke підтверджує indexing, retrieval, scope isolation і shared Lexery-LA Qdrant path. |

---

## 3. Що реально побудовано понад стару архітектуру

### 3.1 Durable orchestration

- **Redis queue factory + Redis streams** для U1→U12.
- **Redis RunContext store** як окремий durable layer, а не лише in-memory helper.
- **Idempotent claim logic** у U11/U12 для multi-instance execution.

### 3.2 Retrieval / evidence layer

- **Compact retrieval trace** persisted у DB.
- **Full retrieval trace** persisted у R2.
- U4 вже не просто “rag lookup”, а вузол з memory-aware retrieval і trace persistence.

### 3.3 U9 assemble expanded

- Канали: **law + docs + memory + history**.
- **MM Docs retrieve/ingest** включені прямо перед assemble.
- **Meta triage** на law hits.
- Compact `assembled_prompt` persistence у `runs`.

### 3.4 U10 write expanded

- **Prompt Stack** (`global -> project -> chat -> user`).
- **Evidence Triage**.
- **Focus Spec**.
- **Output Validator**.
- **Memory Search fallback/tooling**.

### 3.5 MM layer expanded

- `mm_memory_items`, `mm_summaries`, `mm_outbox`.
- Semantic memory collection.
- MM Docs foundation: `mm_doc_records`, `mm_doc_ingest_log`, docs Qdrant collection, docs R2 storage, scope isolation.

---

## 4. Де поточний runtime відрізняється від старої full architecture

| Тема | Старе уявлення | Поточна реальність |
|------|----------------|--------------------|
| **Supabase topology** | 3 окремі проєкти: Main + Legislation + Memory | Фактично 2: **Lexery DB** + **Legislation DB**. MM tables і MM Docs tables зараз у Lexery DB. |
| **R2 topology** | 1 bucket з різними prefix | Фактично 2 buckets: `legislation` і `lexery-legal-agent`. |
| **OpenRouter keys** | 3 key families: online / rag / web | Поточний runtime використовує **single Brain key family** з precedence `OPENROUTER_API_KEY_BRAIN > OPENROUTER_API_KEY_ONLINE`; цим самим шляхом ідуть і LLM, і embedding виклики Brain. |
| **Qdrant topology** | Legislation + separate memory only | Зараз: Legislation cluster + Lexery-LA cluster, де memory semantic і MM Docs можуть жити разом, якщо docs-specific endpoint не заданий. |
| **U11** | Повний verify loop як current runtime | Насправді current runtime має **minimal scaffold**; повний critic/rerank/web loop поки planned. |
| **U10** | Просто один Write call | Насправді U10 має Prompt Stack, Evidence Triage, Focus Spec, Output Validator і memory-aware helpers. |
| **U9** | Law + memory + history | Насправді U9 уже став `law + docs + memory + history`. |

---

## 5. Verification snapshot — 2026-03-16

### 5.1 Unit / focused verification

PASS:

- `pnpm -s brain:test:queue-units`
- `pnpm -s brain:test:gate-units`
- `pnpm -s brain:test:u9-units`
- `pnpm -s brain:test:u10-units`
- `pnpm -s brain:test:u10-preview-units`
- `pnpm -s brain:test:u10-memory-search-units`
- `pnpm -s brain:test:u11-units`
- `pnpm -s brain:test:u12-units`
- `pnpm -s brain:test:mm-units`
- `pnpm -s brain:test:mm-doc-units`
- `pnpm -s brain:test:storage-history-units`
- `pnpm -s brain:test:redis-queue-units`
- `pnpm -s brain:test:rag-units`
- `pnpm -s brain:test:u4-memory-units`
- `pnpm -s brain:test:config-key-precedence`
- `pnpm -s brain:test:dev-chat-units`
- focused `tsx` unit scripts under `tools/u2`, `tools/u3`, `tools/u4`

Деталі:

- `brain:test:redis-queue-units` має **expected skip** для reclaim-сценарію без `REDIS_RECLAIM_MIN_IDLE_MS`.
- `brain:test:queue-units` був timing-flaky один раз; тест hardened polling-based `waitUntil(...)`, після чого стабільно PASS.

### 5.2 Smoke / live verification

PASS:

- `pnpm -s brain:verify:u3`
- `pnpm -s brain:verify:u4-runtime-config`
- `pnpm -s brain:verify:u5`
- `pnpm -s brain:db:capabilities`
- `pnpm -s brain:r2:capabilities`
- `MEMORY_SEMANTIC_ENABLED=true pnpm -s brain:verify:memory-runtime`
- `pnpm exec tsx scripts/lexery-legal-agent/tools/load/api_acceptance_verify.ts`
- `pnpm -s brain:concurrency:smoke`
- `pnpm -s brain:verify:mm-doc-readiness`
- `MM_DOCS_VERIFY_ALLOW_FALLBACK=true pnpm -s brain:verify:mm-doc-live`
- `DEV_ALLOW_ANONYMOUS=true pnpm -s exec tsx scripts/lexery-legal-agent/tools/dev_chat/runner_legacy.ts --message "Що передбачає ст. 115 ККУ?" --dry-run`
- `pnpm -s brain:mm:smoke`

Ключові результати:

- `brain:verify:u5`: A `expand=false`, B `expand=false`, C degraded `expand=true`.
- `brain:concurrency:smoke`: `50/50 PASS`; є warning по total time, але cross-contamination не знайдено.
- `brain:verify:memory-runtime`: isolated rerun дав `semantic_infra_healthy`.
- `brain:verify:mm-doc-live`: PASS, `docs_indexed=9`, shared Lexery-LA docs Qdrant path підтверджено.
- `api_acceptance_verify.ts`: isolated run PASS, `accepted_202=10/10`, `p50_latency_ms=929`, `queue_driver=redis`, `run_context_driver=redis`.
- `brain:mm:smoke`: PASS після оновлення smoke під поточну mixed/memory policy U9.

### 5.3 Важливі нюанси інтерпретації

- `brain:verify:memory-runtime` і `brain:verify:api-acceptance` можуть дати хибний red під агресивним паралельним навантаженням verification-suite. У чистому повторі обидва підтвердились.
- `brain:mm:smoke` падав до виправлення smoke-скрипта, бо він очікував memory parts у `law mode`, що вже суперечило поточній U9 policy. Це був **дріфт smoke**, а не runtime regression.

---

## 6. Що працює добре вже зараз

- **Stage handoff** від U1 до U12.
- **Durable queue/run-context path** на Redis.
- **U4 -> U5 -> U9 -> U10 -> U12** як реальний робочий маршрут.
- **MM outbox + memory semantic infra**.
- **MM Docs ingest/retrieve/isolation**.
- **DB / R2 / Qdrant capability checks**.
- **Dry-run dev chat path** до U12.
- **Source summary / prompt budgeting / law-doc-memory-history accounting**.

---

## 7. Що ще не ідеально

### 7.1 Якість відповіді U10

Основний поточний gap. Pipeline працює, але:

- triage/focus selection ще може бути занадто агресивною;
- answer quality залежить від prompt composition і evidence reduction;
- великі модулі `gateway/storage.ts`, `retrieval/cache-rag.ts`, `retrieval/memory-store.ts`, `classify/consumer.ts` ще потребують окремого cleanup/refactor slice.

### 7.2 U11 ще не фінальний

Поки що немає повного production verify-loop з:

- coverage critic,
- reranker/citation audit,
- refined-query retry orchestration,
- web enrichment branch.

Є тільки durable scaffold, який не ламає pipeline.

### 7.3 U6 / expand path

Код і wiring існують, але це ще не завершений quality subsystem. Основний стабільний шлях зараз не на ньому.

---

## 8. Поточна інфраструктурна карта

### Supabase

- **Lexery DB**: `runs`, `messages`, `mm_memory_items`, `mm_summaries`, `mm_outbox`, `mm_doc_records`, `mm_doc_ingest_log`.
- **Legislation DB**: `legislation_documents`, import/job metadata, catalog-related tables.

### R2

- **`legislation` bucket**: canonical legislation/doclist artifacts.
- **`lexery-legal-agent` bucket**: retrieval traces, MM Docs payloads, MM offload/runtime artifacts.

### Qdrant

- **Legislation cluster**: chunks, acts, catalog.
- **Lexery-LA cluster**: memory semantic, MM Docs chunks by default when docs-specific endpoint is absent.

### Redis

- Durable event queue / retry / DLQ paths.
- Durable RunContext store.

---

## 9. Практичний висновок для наступного блоку

Архітектурно ми вже глибше, ніж це показували старі docs: pipeline не просто “skeleton”, а **дійсно працюючий multi-stage legal-agent runtime** з memory, docs, durable queue/context, compact/full traces і delivery/outbox.

Найбезпечніший наступний етап робіт:

1. окремим slice розкласти великі runtime-модулі без зміни контрактів;
2. покращувати якість U10 answers;
3. тільки після цього повертатись до глибокого переписування важких підсистем.
