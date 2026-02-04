# PHASE A — Evidence: tree audit and classification

**Дата:** 2026-01-29

## 1. Фактичний стан (коротко)

- **Дерево:** `scripts/legislation` містить: `admin-cli.ts`, compat stubs (`commands/`, `lib/`, `config.ts`, `radaClient.ts`), `prod_lexery_legislation_db_infra/` (повний runtime), `docs_lexery_legislation_db_infra/`, `tests_lexery_legislation_db_infra/`, `trash_oneoff_lexery_legislation_db_infra/`, `Documentation List DB/`, `runs/`, `test/`, кореневі .ts/.md та одноразові скрипти.
- **Порожні папки (empty):** лише всередині `Documentation List DB/` (наприклад `.npm-cache/_cacache/tmp`, `.wrangler/tmp`, `node_modules/@emnapi`) — це **GENERATED** (npm/wrangler), не в git; у репо порожніх папок без README в межах prod/docs/test/trash не виявлено після попереднього cleanup.
- **Тимчасові/артефакти:** `.gitignore` вже містить `scripts/legislation/runs/**/*.json`, `*.txt`, `*/logs.txt`. Файли типу `*.log`, `*.tmp` у підпапках Documentation List DB — локальні, не трекаються.

## 2. Класифікація підозрілих елементів

| Елемент | Категорія | Дія |
|--------|------------|-----|
| `prod_lexery_legislation_db_infra/**` | PROD-NEEDED | Залишаємо; єдиний source of truth runtime |
| `admin-cli.ts`, `commands/*` (stubs), `lib/`, `config.ts`, `radaClient.ts` | PROD-NEEDED | Compat layer; не чіпати |
| `Documentation List DB/` | LEGACY/SEPARATE | Позначено в README: окремий каталог (DocListDB/Catalog), не входить в основний pipeline add/verify/remove; залишаємо з чітким README |
| `Documentation List DB/**/node_modules`, `.npm`, `.wrangler`, `tmp` | GENERATED | Не в git; переконатися, що в .gitignore (локальні .gitignore в підпапках є) |
| `runs/` та `runs/audit/*.md` | LEGACY/ARCHIVE | Історичні звіти; залишаємо в репо, додано README у runs/ |
| `docs_lexery_legislation_db_infra/` | PROD-NEEDED (docs) | Історія та аудит; залишаємо |
| `tests_lexery_legislation_db_infra/` | PROD-NEEDED (test contract) | Placeholder stages + README; залишаємо |
| `trash_oneoff_lexery_legislation_db_infra/` | LEGACY/ARCHIVE | Місце для oneoff/мертвих звітів; README є |
| `test/` (fixtures, golden, reports) | PROD-NEEDED | Sanity/regression; залишаємо |
| Кореневі одноразові скрипти (`audit_script.ts`, `pilot_*.ts`, `r2_*.ts`, тощо) | LEGACY | Не видаляти без 100% впевненості; залишаємо, можна згадати в README як optional/legacy |
| `supabase/migrations` | PROD-NEEDED | 25 файлів; без зайвих тимчасових |
| `supabase/migrations_archive/` | LEGACY/ARCHIVE | 7 legislation-міграцій; не чіпати |

## 3. Висновки PHASE A

- Жодних **JUNK** у sense «видалити з репо» не визначено; все або PROD-NEEDED, або LEGACY/ARCHIVE з README.
- Порожні папки в репо (не під node_modules) відсутні після попереднього cleanup; placeholder-директорії мають README.
- Runtime-артефакти (runs/*.json, *.txt) вже в .gitignore; runs/*.md залишені як історичні звіти.
