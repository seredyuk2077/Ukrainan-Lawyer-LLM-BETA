# SELF-VALIDATION GATE (Phase 3.5)

**Дата:** 2025-01-29 · **Acceptance:** Gate passed перед Phase 4.

---

## A) Git coverage sanity (7 днів)

**Перевірка:**
```bash
git log --since="7 days ago" --name-only --pretty=format: | sort -u | awk 'NF' > /tmp/git_7d_files.txt
# 23 унікальних шляхи
```

**Кожен шлях з `/tmp/git_7d_files.txt`:**
- **FILES_CHANGED_LAST_7_DAYS.md:** всі 23 присутні (або явно в таблиці, або під патерном PHASE_*/GATE_A_*).
- **INVENTORY_INDEX.md:** спочатку 8 missing (GATE_A_*, PHASE_3_*, PHASE_4_5_*). Додано явний рядок «Git 7d explicit paths» з усіма 8 → повторна перевірка: **missing = 0**.

**Скрипт валідації:** Python читає `git_7d_files.txt`, шукає кожен path (і `scripts/legislation/`-relative) у FILES_CHANGED та INVENTORY → виводить missing. **Result: missing = 0** ✅

---

## B) Repo tree sanity (scripts/legislation)

**Tree:** `find scripts/legislation -type f` (excluding node_modules, .npm, .git) → `/tmp/leg_files.txt` (3684 files).

**Підозрілі класи:** `runs/**`, `runs/audit/**`, `*.json`, `*.md`, `*.txt`, `README*`, `*GUIDE*`, `*NOTES*`, `test/fixtures/*`.

**Індекс:**
- `runs/*.md`, `runs/audit/*.md` — у DOC INDEX (архів/довідка).
- `test/*.txt`, `test/*.json`, `test/*.report.md`, `test/fixtures/*` — у TEST MATRIX / тестові дані.
- `README.md`, `OPERATIONAL_GUIDE.md`, `*NOTES*`, `SCHEMA_MAP`, `VERSIONING_POLICY` — у DOC INDEX.

**Documentation List DB:** явно виключено з реорганізації (INVENTORY); дерево лишаємо як є.

**Acceptance:** немає «цілих папок» у scope реорганізації, яких немає в індексі. **OK** ✅

---

## C) PROD vs TEST vs LEGACY vs ONEOFF — доказовість

**PROD:** У INVENTORY для кожного PROD-файлу вказано «Хто викликає» (admin-cli, import paths, grep). Вибірково перевірено:
- `config.ts` — radaClient, radaDocIndex, r2_*, pipeline_import_one, pilot_*, openDataPortalClient, find_nreg, docIndex, cli_lookup.
- `canonical/contentUnits.ts` — importer, parseUnits, aiParsingAssist, chunking, inspect, parseUnitsAdvanced, sanitizeHtml.test.

**Reclassification:**
- `utils/rawFetch.ts`: **PROD → LEGACY.** Evidence: використовує лише `pilot_fetch`. radaClient не імпортує rawFetch. Перенесено в секцію LEGACY в INVENTORY.

**TEST:** Кожен тест має команду запуску (admin-cli або `pnpm tsx test/...`) або згадку в docs. `test/run-benchmark.ts` позначено «можливо застарілий» (MIGRATION_PLAN).

**LEGACY/ONEOFF:** Підтверджено README / grep (docIndex, find_nreg, pilot_*, pipeline_import_one, check_readiness, rawFetch, plan_batches, generate_candidates_*, continue_batch2, audit_script, r2_*).

---

## D) DOC INDEX — актуальність / критичність

**Актуальні:**
- `README.md`, `OPERATIONAL_GUIDE.md`: `git log -1` — 1123474 2026-01-22. Посилання на `docs/legislation-rag/ARCHITECTURE_AS_IS_TO_BE.md`, `OPERATIONAL_GUIDE.md` — ці файли існують.
- `CONTEXT_RESTORE_NOTES.md`: без історії в поточному репо; посилання на модулі (admin-cli, importer, verify, repair, …) відповідають кодбузі.

**Застаріле / неточне:**
- `README.md` згадує `parser.ts --nreg=...` («Парсинг в canonical формат (майбутнє)»). **Файл `parser.ts` відсутній** — це майбутня команда, не поточний шлях. Доказ: `ls scripts/legislation/parser.ts` → missing. Рекомендація: у DOC INDEX залишити README «актуальна», але у «Top risks» вказати мертве посилання на `parser.ts`.

**Історичні (PHASE_*, GATE_A_*, runs/*):** прив’язані до комітів/фаз; зберігати в архіві / history_by_commit.

---

## E) Reclassification changes

| Path | Old | New | Причина |
|------|-----|-----|---------|
| `utils/rawFetch.ts` | PROD | LEGACY | Тільки pilot_fetch; radaClient не використовує |

---

## F) Top risks перед Phase 4

1. **Імпорти та шляхи:** admin-cli імпортує 50+ модулів з `./commands/*`, `./lib/*`, `./canonical/*`. Будь-яке переміщення цих модулів вимагає оновлення імпортів або **compat stubs** на старих шляхах.
2. **Мертве посилання в README:** `parser.ts` — не існує. При оновленні доків варто виправити або позначити «майбутнє».
3. **Git status:** Є незакомічені зміни (backend, src, scripts/legislation, migrations, docs/_audit). Phase 4 лише структура/аудит; не змішувати з іншими фічами. При коміті — тільки audit + restructure.

---

## Gate passed ✅

- **Coverage git 7d:** OK (missing = 0).
- **Coverage repo tree:** OK; підозрілі класи проіндексовані.
- **Reclassification:** 1 зміна (rawFetch → LEGACY), зафіксовано в INVENTORY.
- **DOC:** Актуальні доки перевірені; виявлено мертве посилання `parser.ts`.
- **Top risks:** Перелічено вище.

**Далі:** Phase 4 (structure rebuild).

---

*Створено: 2025-01-29 · SELF_VALIDATION_GATE*
