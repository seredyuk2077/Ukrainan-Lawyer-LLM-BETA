# Додаткові скрипти (other)

Скрипти, які не входять у основний пайплайн **admin-cli** + **Lexery Legislation DB Infra**.

- **pilot_*** — пілотні/тестові імпорти (конституція, fetch, canonical).
- **r2_*** — утиліти R2: upload, verify, repair, cleanup.
- **cli_lookup.ts** — швидкий lookup документів за назвою/nreg (Open Data Portal).
- **check_readiness.ts**, **setup_qdrant_rag.ts**, **test_verify_qdrant.ts** — перевірка інфраструктури.
- **find_nreg.ts**, **docIndex.ts**, **radaDocIndex.ts**, **openDataPortalClient.ts** — допоміжні індекси/клієнти.
- **audit_script.ts**, **test-resolver-quick.ts** — разові аудити/тести.
- **pipeline_import_one.ts**, **pilot_import_full.ts** — альтернативні точки входу для імпорту одного документа (основний спосіб — `admin-cli add`).
- **test_batch_nregs.txt** — приклад файлу з nreg для batch-операцій.

Основні команди: див. кореневий [README.md](../README.md) та [Lexery Legislation DB Infra](../Lexery%20Legislation%20DB%20Infra/README.md).
