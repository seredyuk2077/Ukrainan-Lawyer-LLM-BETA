# Lexery Legal Agent — Tools Index

Інструменти для розробки, тестування, аудиту, forensics і live verification.

- `_datasets/` — вхідні датасети, audit packs, labeled fixtures.
- `_reports/` — куровані markdown reports і stage-specific архіви (`_reports/u4/`).
- `_units/` — дрібні cross-stage unit tests для shared helpers/parsers.

## Карта директорій

| Директорія | Призначення | Типові команди |
|------------|-------------|----------------|
| `u1/` | Gateway / intake utilities | `brain:migrate-r2-runs` |
| `u2/` | Classify smoke, verify, stress, unit helpers | `brain:verify:u2-cues`, `brain:u2:test` |
| `u3/` | Plan smoke + unit helpers | `brain:verify:u3`, `brain:u3:test` |
| `u4/` | Retrieval, datasets, audits, reports | `brain:verify:retrieval-real-dev:fast`, `brain:verify:act-type-audit:fast` |
| `u5/` | Gate smoke + unit suites | `brain:verify:u5`, `brain:test:gate-units` |
| `u9/` | Assemble tests / snippet audit | `brain:test:u9-units`, `brain:u9:snippet-audit` |
| `u10/` | Legal-agent, preview, evidence/memory/focus validators | `brain:test:u10-units`, `brain:test:u10-preview-units` |
| `u11/`, `u12/` | Verify / deliver unit suites | `brain:test:u11-units`, `brain:test:u12-units` |
| `gateway/` | Queue/storage/attachment unit tests | `brain:test:queue-units`, `brain:test:storage-history-units` |
| `db/`, `r2/` | Infra capability checks | `brain:db:capabilities`, `brain:r2:capabilities` |
| `mm/` | MM memory smoke, runtime, e2e, isolation, rollout helpers | `brain:mm:smoke`, `brain:verify:memory-runtime` |
| `mm-doc/` | MM Docs readiness/live/pipeline/repair tools | `brain:test:mm-doc-units`, `brain:verify:mm-doc-live` |
| `load/` | API acceptance and concurrency smoke | `brain:verify:api-acceptance`, `brain:concurrency:smoke` |
| `dev_chat/` | Interactive CLI/dev chat helpers | `brain:chat`, `brain:test:dev-chat-units` |
| `forensics/` | Debug/audit scripts for U9/U10 and source refs | `brain:forensics:u10-debug` |
| `retrieval/`, `write/` | Focused shared unit suites | `brain:test:retrieval-trace-compact-units`, `brain:test:memory-summary-units` |

## U1 — Gateway / intake

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u1/migrate_r2_runs.ts` | `brain:migrate-r2-runs` | Міграція `runs/attachments` з legislation bucket у `lexery-legal-agent` |

## U2 — Classify / routing

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u2/u2_test_queries.ts` | `brain:u2:test` | Ручне тестування U2 класифікатора |
| `u2/u2_bench_models.ts` | `brain:u2:bench-models` | Бенчмарк LLM моделей для U2 |
| `u2/u2_loadtest.ts` | `brain:u2:loadtest` | Load test U2 |
| `u2/u2_stress_queries.ts` | `brain:u2:stress` | Stress test U2 queries |
| `u2/verify_u2_domain_audit.ts` | `brain:verify:u2-domain:smoke/fast` | Domain audit cases |
| `u2/verify_u2_domain_cues.ts` | `brain:verify:u2-cues` | Domain cues/keywords |
| `u2/verify_u2_routing_audit.ts` | `brain:verify:u2-routing:smoke/fast` | Routing hint audit |
| `u2/test_ambiguity_detector_units.ts` | — | Unit tests для ambiguity detector |
| `u2/test_consumer_retry_units.ts` | — | Retry policy U2 consumer |
| `u2/test_query_scope_hints_units.ts` | — | Docs/memory scope hints |

## U3 — Plan

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u3/u3_plan_test.ts` | `brain:u3:test` | Ручне тестування U3/U3a |
| `u3/verify_u3.ts` | `brain:verify:u3` | U3 smoke verify |
| `u3/test_plan_consumer_units.ts` | — | Retry/only-docs plan unit tests |

## U4 — Retrieval

### Verify / smoke

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u4/verify_u4.ts` | `brain:verify:u4` | U4 smoke |
| `u4/verify_u4_runtime_config.ts` | `brain:verify:u4-runtime-config` | Runtime config sanity check |
| `u4/verify_u4_query_rewrite_smoke.ts` | `brain:verify:u4-query-rewrite:smoke` | Query rewrite smoke |
| `u4/verify_retrieval_quality.ts` | `brain:verify:retrieval-quality(:smoke)` | Retrieval quality suite |
| `u4/verify_retrieval_multigoal.ts` | `brain:verify:retrieval-multigoal(:smoke)` | Multi-goal suite |
| `u4/verify_retrieval_real_dev.ts` | `brain:verify:retrieval-real-dev(:smoke/:fast)` | Real-dev labeled dataset |
| `u4/verify_retrieval_real_holdout.ts` | `brain:verify:retrieval-real-holdout` | Holdout labeled dataset |
| `u4/verify_retrieval_act_type_audit.ts` | `brain:verify:act-type-audit(:smoke/:fast)` | Act-type audit |
| `u4/verify_retrieval_suite.ts` | `brain:verify:retrieval` | Combined retrieval suite |
| `u4/verify_rag_assessment.ts` | `brain:verify:rag-assessment(:smoke/:explicit/:natural/:out)` | RAG assessment |
| `u4/verify_rag_secondary_acts.ts` | `brain:verify:rag-secondary-acts` | Secondary acts coverage |
| `u4/verify_routing_hints_low_recall.ts` | `brain:verify:routing-hints-low-recall` | Low-recall routing-hints check |
| `u4/verify_retrieval_latency_profile.ts` | `brain:verify:retrieval-latency-profile` | Retrieval latency profile |
| `u4/verify_edge_cases.ts` | `brain:verify:edge-cases` | Edge cases |
| `u4/verify_lldbi_kku115.ts` | `brain:verify:lldbi-kku115` | Focused article verify |

### Manual runs / datasets / reports

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u4/manual_query_run.ts` | `brain:manual:query` | Детальний ручний query run |
| `u4/manual_run_inspect.ts` | `brain:inspect:run` | Інспекція конкретного `run_id` |
| `u4/run_one_query.ts` | — | Разовий запуск retrieval case |
| `u4/dataset_retrieval_real.ts` | `brain:dataset:retrieval-real` | Збір prod-like queries |
| `u4/dataset_act_type_audit.ts` | `brain:dataset:act-type-audit` | Snapshot act types |
| `u4/dataset_lldbi_vocabulary_snapshot.ts` | `brain:dataset:lldbi-vocabulary` | Vocabulary snapshot |
| `u4/generate_act_type_audit_cases.ts` | `brain:generate:act-type-audit-cases` | Генерація audit cases |
| `u4/label_retrieval_expectations.ts` | `brain:label:retrieval-expectations` | Розмітка expectations |
| `u4/report_retrieval_real_failures.ts` | `brain:report:retrieval-real-failures` | Failure report |
| `u4/report_retrieval_real_dev_regression.ts` | `brain:report:retrieval-real-dev-regression` | Regression compare |
| `u4/report_retrieval_real_failures_policy_targets_v2.ts` | `brain:report:retrieval-real-failures-policy-targets-v2` | Policy-target report |
| `u4/audit_runs_retrieval_quality.ts` | `brain:audit:runs-retrieval-quality` | Supabase/MCP audit |
| `u4/mcp_audit_runs_chunks_quality.ts` | `brain:audit:runs-chunks` | Chunks quality audit |

### U4 unit suites

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u4/test_rag_units.ts` | `brain:test:rag-units` | RAG scoring / selection units |
| `u4/test_plan_rules_units.ts` | — | Plan rule interactions |
| `u4/test_retrieval_consumer_units.ts` | — | Consumer retry logic |
| `u4/test_u4_memory_propagation_units.ts` | `brain:test:u4-memory-units` | Memory trace propagation |
| `u4/test_verify_retrieval_real_dev_units.ts` | — | Real-dev verifier thresholds |
| `u4/test_verify_routing_hints_low_recall_units.ts` | — | Routing-hints verifier units |
| `u4/test_prod_hardening.ts` | `brain:test:prod-hardening` | OOD/noise hardening smoke |

## U5 — Gate

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u5/verify_u5.ts` | `brain:verify:u5` | Server-level U5 gate smoke with dry-run writer path enabled |
| `u5/test_gate_units.ts` | `brain:test:gate-units` | Gate contract + policy |

## U9 — Assemble

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u9/test_assemble_units.ts` | `brain:test:u9-units` | U9 assemble unit suite |
| `u9/manual_snippet_audit.ts` | `brain:u9:snippet-audit` | Manual snippet selection audit |

## U10 / U11 / U12 — Write path

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u10/test_legal_agent_units.ts` | `brain:test:u10-units` | U10 legal-agent unit suite |
| `u10/test_u10_preview_units.ts` | `brain:test:u10-preview-units` | Preview / prompt hash checks |
| `u10/test_memory_search_units.ts` | `brain:test:u10-memory-search-units` | Internal memory-search tool |
| `u10/test_focus_spec_units.ts` | `brain:test:focus-spec-units` | FocusSpec policy |
| `u10/test_evidence_triage_units.ts` | `brain:test:evidence-triage-units` | Evidence triage units |
| `u10/test_output_validator_units.ts` | `brain:test:output-validator-units` | Output validation |
| `u11/test_verify_units.ts` | `brain:test:u11-units` | U11 verify scaffold |
| `u12/test_deliver_units.ts` | `brain:test:u12-units` | U12 deliver / dedupe |
| `write/test_memory_summary_units.ts` | `brain:test:memory-summary-units` | Memory summary helpers |

## Gateway / shared units

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `gateway/test_queue_units.ts` | `brain:test:queue-units` | In-memory queue semantics |
| `gateway/test_redis_queue_units.ts` | `brain:test:redis-queue-units` | Redis queue integration |
| `gateway/test_storage_history_units.ts` | `brain:test:storage-history-units` | Storage/history retry + dedupe |
| `gateway/test_attachment_units.ts` | — | Attachment policies |
| `_units/test_json_extract_units.ts` | `brain:test:json-extract-units` | JSON extraction helper |
| `_units/test_u2_classify_json_units.ts` | `brain:test:u2-classify-json-units` | U2 JSON parser/schema |
| `_units/test_config_key_precedence_units.ts` | `brain:test:config-key-precedence` | Key precedence sanity check |
| `retrieval/test_retrieval_trace_compact_units.ts` | `brain:test:retrieval-trace-compact-units` | Trace compaction |

## MM memory

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `mm/seed_memory_smoke.ts` | `brain:mm:smoke` | Seed + one-pass smoke |
| `mm/seed-dev-user.ts` | `brain:mm:seed-dev-user` | Dev identity seed |
| `mm/migrate_memory_vectors_to_la.ts` | `brain:mm:migrate-memory-vectors` | Vector migration helper |
| `mm/verify_memory_runtime.ts` | `brain:verify:memory-runtime` | Runtime/Qdrant/outbox health |
| `mm/verify_memory_e2e.ts` | `brain:verify:memory-e2e` | End-to-end materialization |
| `mm/verify_memory_parallel_stress.ts` | `brain:verify:memory-parallel-stress` | Parallel stress |
| `mm/verify_memory_isolation_real.ts` | `brain:verify:memory-isolation-real` | Real isolation checks |
| `mm/verify_memory_long_conversation.ts` | — | Long-chat recall check |
| `mm/test_outbox_units.ts` | `brain:test:mm-units` | Outbox / extraction units |
| `mm/test_source_summary_units.ts` | `brain:test:source-summary-units` | Summary helper units |

## MM Docs

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `mm-doc/test_mm_doc_units.ts` | `brain:test:mm-doc-units` | Parser/store/retrieval unit suite |
| `mm-doc/verify_mm_docs_readiness.ts` | `brain:verify:mm-doc-readiness` | Readiness / storage shape |
| `mm-doc/verify_mm_docs_live_smoke.ts` | `brain:verify:mm-doc-live` | Live ingest/retrieve smoke |
| `mm-doc/verify_mm_docs_pipeline_live.ts` | `brain:verify:mm-doc-pipeline-live` | Scope-aware live pipeline |
| `mm-doc/verify_mm_docs_large_context_stress.ts` | `brain:verify:mm-doc-large-stress` | Large-context stress |
| `mm-doc/repair_failed_mm_docs.ts` | `brain:repair:mm-doc-failed` | Repair failed ingest rows |
| `mm-doc/ingest_run_attachments.ts` | — | Run attachment ingest helper |

## Infra / load / ops

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `db/db_capabilities_check.ts` | `brain:db:capabilities` | Supabase schema/status capability check |
| `r2/r2_capabilities_check.ts` | `brain:r2:capabilities` | R2 readability/offload check |
| `load/api_acceptance_verify.ts` | `brain:verify:api-acceptance` | Intake acceptance under load |
| `load/concurrency_smoke.ts` | `brain:concurrency:smoke` | Cross-run concurrency smoke |

## Dev chat / forensics

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `dev_chat/interactive.ts` | `brain:chat`, `brain:chat:interactive` | Інтерактивний CLI chat |
| `dev_chat/run_cli.ts` | `brain:chat:run`, `brain:chat:dev` | Single-run CLI |
| `dev_chat/test_core_units.ts` | `brain:test:dev-chat-units` | Dev chat core units |
| `dev_chat/runner_legacy.ts` | — | Legacy one-shot runner kept for compatibility/debug |
| `forensics/run_law_refs_report.ts` | `brain:forensics:law-refs` | Law refs report |
| `forensics/u10_prompt_debug.ts` | `brain:forensics:u10-debug` | U10 prompt debug |
| `forensics/u9_u10_chunk_diagnostic.ts` | `brain:forensics:u9-u10-chunks` | U9/U10 chunk diagnostic |

## Рекомендований smoke chain перед комітом

```bash
pnpm brain:verify:u3
pnpm brain:verify:u5
pnpm brain:verify:retrieval-real-dev:fast
pnpm brain:verify:act-type-audit:fast
pnpm brain:test:u9-units
pnpm brain:test:u10-units
pnpm brain:test:u11-units
pnpm brain:test:u12-units
pnpm brain:test:mm-units
```
