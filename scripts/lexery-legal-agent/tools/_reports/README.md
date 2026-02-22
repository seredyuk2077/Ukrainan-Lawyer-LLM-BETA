# Tools — _reports

Директорія для звітів і артефактів прогонів.

## Що тут зберігається

| Файл | Опис |
|------|------|
| `u4_final2_go_report_2026-02-22.md` | Фінальний GO/NO-GO звіт U4 (22 лют 2026) — поточна базова лінія |
| `u4_final_go_report_2026-02-21.md` | Фінальний GO/NO-GO звіт U4 (21 лют 2026) — попередня версія |
| `final_go_audit_2026-02-21.md` | MCP chunk audit 15 runs (21 лют 2026) |

## Що НЕ зберігається в git

- `*.json` — JSON дампи runs/результатів (об'ємні, auto-generated)
- `*.log`, `*.txt` — лог-файли stress/verify прогонів
- Dated `.md` файли (context_restore_*, mcp_audit_*, task9_*, stress_e2e_*, rag_assessment_*, etc.)

Ці файли генеруються тулами з `tools/u4/`. За потреби зберегти для прод-аудиту — використовуй **R2 bucket `lexery-legal-agent`**.

## Як згенерувати звіт

```bash
# Stress test output
pnpm brain:stress:e2e

# Retrieval regression report
pnpm brain:report:retrieval-real-dev-regression

# Task9 dump
pnpm exec tsx scripts/lexery-legal-agent/tools/u4/run_one_query.ts --batch 1 24

# MCP chunks quality audit
pnpm brain:audit:runs-chunks
```
