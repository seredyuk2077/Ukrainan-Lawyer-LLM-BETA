# Lexery Legal Agent — Tools Index

Інструменти для розробки, тестування, аудиту та збору датасетів.
Всі інструменти розкладені по підпапках за модулями: `u1/`, `u2/`, `u3/`, `u4/`.
Вхідні датасети — у `_datasets/`. Звіти (куровані фінали) — у `_reports/`.

---

## u1/ — Gateway/Intake

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `migrate_r2_runs.ts` | `brain:migrate-r2-runs` | Міграція runs/ з legislation → lexery-legal-agent R2 bucket |

---

## u2/ — Domain Classify / Routing

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u2_test_queries.ts` | `brain:u2:test` | Ручне тестування U2 класифікатора |
| `u2_bench_models.ts` | `brain:u2:bench-models` | Бенчмарк LLM моделей для U2 |
| `u2_loadtest.ts` | `brain:u2:loadtest` | Load test U2 (100 concurrent) |
| `u2_stress_queries.ts` | `brain:u2:stress` | Stress test U2 queries |
| `verify_u2_domain_audit.ts` | `brain:verify:u2-domain:smoke/fast` | Verify domain audit cases |
| `verify_u2_domain_cues.ts` | `brain:verify:u2-cues` | Verify domain cues/keywords |
| `verify_u2_routing_audit.ts` | `brain:verify:u2-routing:smoke/fast` | Verify routing hint audit cases |

---

## u3/ — Plan

| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `u3_plan_test.ts` | `brain:u3:test` | Ручне тестування U3 plan builder |
| `verify_u3.ts` | `brain:verify:u3` | U3 smoke verify |

---

## u4/ — CacheRAG / Retrieval

### Verify / Smoke suite
| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `verify_u4.ts` | `brain:verify:u4` | U4 smoke: server → POST → poll retrieval_trace |
| `verify_u5.ts` | `brain:verify:u5` | U5 Gate smoke (U4→U9 boundary) |
| `verify_u4_memory.ts` | — | U4 memory retrieval verify (Supabase mm_memory_items) |
| `verify_u4_query_rewrite_smoke.ts` | `brain:verify:u4-query-rewrite:smoke` | Query rewrite smoke |
| `verify_retrieval_quality.ts` | `brain:verify:retrieval-quality(:smoke)` | Retrieval quality suite (20–30 cases) |
| `verify_retrieval_multigoal.ts` | `brain:verify:retrieval-multigoal(:smoke)` | Multi-goal retrieval suite |
| `verify_retrieval_real_dev.ts` | `brain:verify:retrieval-real-dev(:smoke/:fast)` | Real-dev labeled dataset suite |
| `verify_retrieval_real_holdout.ts` | `brain:verify:retrieval-real-holdout` | Holdout labeled dataset suite |
| `verify_retrieval_act_type_audit.ts` | `brain:verify:act-type-audit(:smoke/:fast)` | Act-type audit (diverse act types) |
| `verify_retrieval_suite.ts` | `brain:verify:retrieval` | Combined retrieval suite |
| `verify_rag_assessment.ts` | `brain:verify:rag-assessment(:smoke/:explicit/:natural/:out)` | RAG assessment (explicit/implicit/natural/OOD) |
| `verify_rag_secondary_acts.ts` | `brain:verify:rag-secondary-acts` | Secondary acts coverage verify |
| `verify_edge_cases.ts` | `brain:verify:edge-cases` | Edge cases verify |
| `verify_lldbi_kku115.ts` | `brain:verify:lldbi-kku115` | Specific KKU 115 article verify |

### Run / Manual query tools
| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `run_one_query.ts` | — | Запустити один запит: `tsx tools/u4/run_one_query.ts "запит"` або `--task N` або `--batch N M` |
| `run_final_manual_audit.ts` | — | Batch запуск final_go_audit_queries.json (15 queries) |
| `manual_query_run.ts` | `brain:manual:query` | Ручний запит з детальним виводом |
| `manual_run_inspect.ts` | `brain:inspect:run` | Інспекція конкретного run_id через MCP |
| `inspect_lldbi_payload.ts` | — | Інспекція LLDBI payload (r2_key → json) |

### Dataset builders
| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `dataset_act_type_audit.ts` | `brain:dataset:act-type-audit` | Генерує act_type_audit_snapshot.json з LLDBI |
| `dataset_lldbi_vocabulary_snapshot.ts` | `brain:dataset:lldbi-vocabulary` | Генерує lldbi_vocabulary_snapshot.json |
| `dataset_retrieval_real.ts` | `brain:dataset:retrieval-real` | Збирає retrieval_real_queries.jsonl з production runs |
| `generate_act_type_audit_cases.ts` | `brain:generate:act-type-audit-cases` | Генерує act_type_audit_cases.json зі snapshot |
| `generate_task9_summary.ts` | — | Генерує summary по Task9 batch |
| `label_retrieval_expectations.ts` | `brain:label:retrieval-expectations` | Розмічає retrieval_real_queries → retrieval_real_labeled.json |
| `retrieval_real_split.ts` | _(утиліта для report tools)_ | DEV/holdout split для labeled dataset |

### Report generators
| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `report_retrieval_real_failures.ts` | `brain:report:retrieval-real-failures` | Failure report по labeled dev set |
| `report_retrieval_real_dev_regression.ts` | `brain:report:retrieval-real-dev-regression` | Regression compare (baseline vs current) |
| `report_retrieval_real_failures_policy_targets_v2.ts` | `brain:report:retrieval-real-failures-policy-targets-v2` | Policy targets v2 failure report |

### Audit tools (MCP/Supabase)
| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `audit_runs_retrieval_quality.ts` | `brain:audit:runs-retrieval-quality` | Audit останніх runs через Supabase MCP |
| `mcp_audit_runs_chunks_quality.ts` | `brain:audit:runs-chunks` | MCP audit chunk quality (топ-30 hits) |

### Stress test
| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `stress_test_e2e.ts` | `brain:stress:e2e` | E2E stress test (50 concurrent runs) |
| `stress_test_concurrent.ts` | — | Concurrent stress (configurable) |
| `stress_test_direct.ts` | — | Direct server stress |
| `stress_test_prod.ts` | — | Prod-like stress |

### Test utils
| Скрипт | pnpm script | Опис |
|--------|-------------|------|
| `test_prod_hardening.ts` | `brain:test:prod-hardening` | Prod hardening smoke (OOD guard, noise) |
| `test_rag_units.ts` | `brain:test:rag-units` | RAG unit tests (scoring, dedup, RRF) |

---

## Smoke chain (рекомендований порядок перед комітом)

```bash
pnpm brain:verify:smoke                         # u3 + u4 + u5 + quality:smoke + multigoal:smoke
pnpm brain:verify:retrieval-real-dev:fast       # 40 real-dev cases
pnpm brain:verify:act-type-audit:fast           # 20 act-type cases
pnpm brain:verify:u2-domain:smoke               # U2 domain smoke
pnpm brain:verify:u2-routing:smoke              # U2 routing smoke
```
