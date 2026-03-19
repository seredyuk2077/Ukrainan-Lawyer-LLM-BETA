# Tools — _datasets

Куровані вхідні датасети для тестових і verify-інструментів.

## Файли

| Файл | Використовується в | Опис |
|------|-------------------|------|
| `verify_packs.json` | verify_retrieval_real_dev, verify_retrieval_quality, verify_retrieval_multigoal, verify_u2_domain_audit, verify_u2_routing_audit | Конфігурація smoke/fast verify-паків |
| `retrieval_real_labeled.json` | verify_retrieval_real_dev, report_retrieval_real_failures | Мічений датасет реальних запитів (DEV split) |
| `retrieval_real_article_expectations.json` | verify_retrieval_real_dev (`--article-rank`) | Overlay для strict article/rank assertions поверх weak-labeled real-dev датасету |
| `retrieval_real_queries.jsonl` | dataset_retrieval_real, label_retrieval_expectations | Сирі запити для розмітки |
| `act_type_audit_cases.json` | verify_retrieval_act_type_audit | Кейси для аудиту типів актів |
| `act_type_audit_snapshot.json` | generate_act_type_audit_cases | Snapshot типів актів з LLDBI (auto-generated, потрібен для regeneration) |
| `task9_query.txt` | run_one_query, stress_test_e2e | 24 юридичних завдання (Task9 benchmark) |
| `out_of_domain_cases.json` | verify_retrieval_act_type_audit | Out-of-domain тест-кейси |
| `reference_expansion_cases.json` | verify_retrieval_act_type_audit | Кейси для reference expansion |
| `special_multiact_cases.json` | verify_retrieval_act_type_audit | Мульти-актові спеціальні кейси |
| `rag_assessment_cases.json` | verify_rag_assessment | RAG assessment кейси (explicit/implicit/natural) |
| `rag_golden_cases.json` | verify_rag_golden | Strong legal golden cases з article/rank assertions, selected_acts budgets, latency/qdrant budgets і bucket-ами (`single-act`, `same-act multi-article`, `substantive+procedure`, `multi-act mixed-source`, `primary law + secondary order`) |
| `rag_secondary_acts_cases.json` | verify_rag_secondary_acts | Кейси для вторинних актів |
| `u2_domain_audit_cases.json` | verify_u2_domain_audit | U2 domain audit кейси |
| `u2_routing_audit_cases.json` | verify_u2_routing_audit | U2 routing audit кейси |
| `final_go_audit_queries.json` | run_final_manual_audit | Фінальний GO-audit набір запитів (15 типів) |
| `final_manual_audit_queries.json` | run_final_manual_audit | Ручний audit набір запитів |
| `mcp_final_audit_queries.json` | run_final_manual_audit | MCP final audit набір |
| `lldbi_vocabulary_snapshot.json` | act-taxonomy-store (fallback) | Snapshot LLDBI vocabulary (категорії/типи документів) |

## Оновлення датасетів

```bash
# Оновити LLDBI vocabulary snapshot
pnpm brain:dataset:lldbi-vocabulary

# Оновити act type audit snapshot
pnpm brain:dataset:act-type-audit

# Оновити retrieval real queries
pnpm brain:dataset:retrieval-real

# Регенерувати act_type_audit_cases.json зі snapshot
pnpm brain:generate:act-type-audit-cases

# Прогнати article-level legal golden set
pnpm exec tsx scripts/lexery-legal-agent/tools/u4/verify_rag_golden.ts
```

## Golden dataset notes

- `rag_golden_cases.json` не має бути smoke-only набором. Це article-level benchmark для українського legal RAG.
- Для same-act multi-article сценаріїв використовуйте `expected_hits`, а не лише `expected_primary`, якщо важливо перевірити кілька норм одного кодексу.
- Для substantive+procedure або mixed-source кейсів додавайте `expected_selected_acts` і, коли потрібно, `forbidden_selected_acts` / `forbidden_selected_act_kinds`, щоб verifier ловив не тільки miss релевантної норми, а й writer-noise.
- Для point-level bylaw cases (`п. 12`, `п. 21`) пам’ятайте про structural ambiguity: якщо в одному акті є кілька однакових номерів пунктів у різних частинах, benchmark повинен або мати додатковий contextual cue в query, або чесно позначати такий кейс як corpus-hard, а не маскувати його під простий exact-match.
- `verify_rag_golden` тепер пише ще й `priority_summary` та `high_priority_failures`, щоб release-gate було видно не лише загальний pass rate, а й чи валяться справді критичні українські legal сценарії.
