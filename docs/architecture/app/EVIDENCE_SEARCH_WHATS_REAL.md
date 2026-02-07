# Evidence Search (U3–U9) — What's Already Real

Документ фіксує реальний стан інфраструктури перед імплементацією Evidence Search Pipeline. Джерело: Phase 0 Research (LEX-104 planning).

## 1. ENV (вже існуючі / потрібні)

| Env | Є в .env | Призначення |
|-----|----------|-------------|
| SUPABASE_LEXERY_LEGAL_AGENT_DB_URL | ✅ | Brain runs, mm_* |
| SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY | ✅ | |
| R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY | ✅ | |
| R2_RUNS_BUCKET / R2_LEGISLATION_BUCKET | ✅ | lexery-legal-agent, legislation |
| OPENROUTER_API_KEY_ONLINE | ✅ | U2, U6, U10, U11 |
| OPEN_ROUTER_API_RAG | ✅ | U4 embeddings, DocList (768d) |
| qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB | ✅ | LLDBI Qdrant |
| qdrant_clusterAPI_LEXERY_LEGISLATION_DB | ✅ | |
| DOCLIST_API_URL | ❌ потрібен | Act Catalog Resolver (Cloudflare Worker URL) |
| QDRANT_TIMEOUT_SEC | ❌ | ~3–5 s для U4 |
| LLDBI_TOP_K, MIN_SCORE_THRESHOLD | ❌ | U4 params |
| GATE_MIN_HITS_THRESHOLD, GATE_MIN_AVG_SCORE | ✅ (defaults) | U5 Gate (canonical) |
| DOCLIST_ENABLED, FORCE_EXPAND | ✅ (defaults) | U5 Gate |
| IMPORT_FAST_MODE_COUNT, IMPORT_TIMEOUT_SEC | ❌ | U8 |
| MEMORY_SEMANTIC_ENABLED | ❌ | U4 Memory (P1) |

## 2. Supabase runs (LEXERY LEGAL AGENT DB)

| Поле | Тип | Є | Примітка |
|------|-----|---|----------|
| id | uuid | ✅ | |
| run_id | text | ✅ | unique |
| tenant_id | uuid | ✅ | |
| user_id | uuid | ✅ | |
| conversation_id | uuid | ✅ | |
| status | text | ✅ | Intake, Profiling, Planning, … |
| query | text | ✅ | |
| query_profile | jsonb | ✅ | U2 пише |
| search_plan | jsonb | ✅ | U3 пише |
| snapshot | jsonb | ✅ | |
| degraded_flags | jsonb | ✅ | |
| error_code | text | ✅ | |
| attachments_manifest | jsonb | ✅ | |
| idempotency_key | text | ✅ | |
| retrieval_trace | jsonb | ✅ | LEX-106: міграція add_runs_retrieval_trace застосована |
| gate_decision | jsonb | ✅ | U5 Gate: expand, reason_codes, thresholds, signals (migration add_runs_gate_decision) |

## 3. Qdrant колекції

| Колекція | dim | env | Призначення |
|----------|-----|-----|-------------|
| lexery_legislation_chunks | 1536 | qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB | LLDBI chunks, U4 |
| lexery_legislation_acts | 1536 | same | LLDBI acts, U4 |
| legislation-catalog-index | 768 | DocList Worker (окремий) | DocList API, U7 |
| lexery_memory_semantic_v1 | 1536 | Qdrant LA cluster | Memory (P1) |

## 4. R2 buckets / prefixes

| Bucket | Prefix | Призначення |
|--------|--------|-------------|
| lexery-legal-agent | runs/…, attachments | U1 overflow, Brain runs |
| legal-court-decisions / legislation | legislation/… | LLDBI canonical JSON |
| — | $.content.chunks[N].text | json_path для RawHit |

## 5. Provenance (r2_key + json_path)

- **LLDBI chunks** payload: `rada_nreg`, `r2_key`, `json_path`, `article_number`, `title`
- **r2_key**: шлях до canonical JSON (R2 legislation bucket)
- **json_path**: `$.content.chunks[<index>].text` (r2Json.extractTextByJsonPath)
- **U4 не копіює тексти в runs** — тільки pointers (RawHit.r2_key, RawHit.json_path)

## 6. DocList Act Catalog Resolver API

- **Endpoint**: POST /catalog/resolve (Cloudflare Worker)
- **Request**: ResolveRequest { query, k?, candidates?, filters?, mode? }
- **Response**: ResolveResponse { results: ResolveResultItem[], meta }
- **ResolveResultItem**: { nreg, dokid, nazva, score, source_score, rerank_score? }
- **Qdrant**: legislation-catalog-index 768d; mode auto/vector-only/llm-rerank

## 7. Brain service (U1/U2/U3 stub)

- **server.ts**: port 3081, POST /v1/runs, GET /v1/runs/:id (повертає query_profile, search_plan, retrieval_trace — nullable)
- **gateway/queue.ts**: InMemoryQueue, onEvent handlers (U2 → U3 → U4 stub → U9 stub)
- **classify/consumer.ts**: handleU2Event, **реально** enqueue U3 після persist
- **RunRepository**: findByRunId, updateQueryProfile, updateSearchPlan, updateRetrievalTrace, markFailed
- **observability.ts**: u2_* metrics, getMetrics()
- **Міграції**: Lexery Legal Agent DB (Supabase project bsiximytmpkjkzdlzzso) — застосовуються через Supabase Dashboard або MCP `apply_migration`. Локальний репо не зберігає SQL-файли цього проєкту в supabase/migrations (там інший проєкт); історія: list_migrations через MCP.

## 8. Multi-tenant

- run_id UUID, tenant_id, user_id у runs
- RunContext key: run_id only (lexery:runctx:{run_id} в Redis)
- Фільтри по tenant_id/user_id для mm_*, legislation_documents
