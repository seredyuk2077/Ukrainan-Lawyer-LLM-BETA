# Tools — _reports

Директорія для курованих markdown-звітів і артефактів прогонів.

## Що тут зберігається

| Файл | Опис |
|------|------|
| `u4_final2_go_report_2026-02-22.md` | Фінальний GO/NO-GO звіт U4 (22 лют 2026) — поточна базова лінія |
| `u4_final_go_report_2026-02-21.md` | Фінальний GO/NO-GO звіт U4 (21 лют 2026) — попередня версія |
| `final_go_audit_2026-02-21.md` | MCP chunk audit 15 runs (21 лют 2026) |
| `u4/` | Stage-specific archive для dated U4 markdown reports |

## Що НЕ зберігається в git

- `*.json` — JSON дампи runs/результатів (об'ємні, auto-generated)
- `*.log`, `*.txt` — лог-файли stress/verify прогонів
- Великі auto-generated `.md`/`.txt` прогінні дампи, які не є curated reports

Markdown reports, які варто тримати в git, можна або класти в корінь `_reports/`, або розносити по stage subfolders на кшталт `_reports/u4/`. Великі дампи для прод-аудиту краще зберігати в **R2 bucket `lexery-legal-agent`**.

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
