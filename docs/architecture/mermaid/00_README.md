# Lexery Legal AI Agent — Mermaid Architecture Diagrams

Ця директорія містить Mermaid-діаграми повної архітектури Lexery Legal AI Agent (Online Serving, Offline DocListDB Updater, Offline LLDBI Ingestion) та допоміжні артефакти.

## Як рендерити в Cursor

1. Відкрийте будь-який файл `*.md` з цієї директорії.
2. Cursor (VS Code) з підключеним **Mermaid extension** автоматично рендерить блоки ` ```mermaid ` у попередній перегляд.
3. Якщо попередній перегляд не з’явився: відкрийте Command Palette (`Cmd+Shift+P`), введіть **“Mermaid: Preview”** або **“Markdown: Open Preview”** — діаграма відобразиться в сайдбарі.

## Як експортувати в SVG/PNG

### Варіант A: mermaid-cli (mmdc)

```bash
# Встановлення (якщо ще немає)
npm install -g @mermaid-js/mermaid-cli

# Експорт одного файлу (діаграма має бути в першому mermaid-блоці)
mmdc -i docs/architecture/mermaid/01_MEGA_ARCHITECTURE.md -o docs/architecture/mermaid/export/01_MEGA.svg

# Експорт усіх .md у export/*.svg (скрипт)
for f in docs/architecture/mermaid/0*.md; do
  name=$(basename "$f" .md)
  mmdc -i "$f" -o "docs/architecture/mermaid/export/${name}.svg" 2>/dev/null || true
done
```

### Варіант B: Cursor / VS Code

1. Відкрийте preview Mermaid (правою кнопкою по блоці → “Preview Mermaid” або через extension).
2. Правий клік по зображенню → “Copy Image” / “Save Image As” (залежно від extension).
3. Або використайте онлайн [mermaid.live](https://mermaid.live): вставте код діаграми та експортуйте SVG/PNG.

### Варіант C: Mermaid Live Editor

1. Відкрийте https://mermaid.live
2. Скопіюйте вміст блоку ` ```mermaid ` з потрібного `.md` файлу.
3. Експорт: **Actions → PNG/SVG**.

## Підтримка ID і оновлення

- **Block ID** у діаграмах (U1, U2a, T0, O6 тощо) мають збігатися з **07_BLOCK_CARDS.md** та з джерелами `docs/plan_archinecture_Agnet/answer.md`, `plan.md`.
- При зміні архітектури:
  1. Оновіть відповідний Mermaid-файл (01–06).
  2. Оновіть **07_BLOCK_CARDS.md** для змінених блоків (всі 11 полів).
  3. Перевірте рендер у Cursor і при потребі експортуйте SVG у `export/`.

## Файли в цій директорії

| Файл | Опис |
|------|------|
| **00_README.md** | Ця інструкція. |
| **01_MEGA_ARCHITECTURE.md** | Один великий flowchart: Online (U1–U12 + підблоки), DocListDB (T0/O1–O6), LLDBI (T6/O7–O12), Storages. |
| **02_ONLINE_DETAILED.md** | Деталізований Online: кожна нода з purpose/inputs/outputs/deps/secrets/timeouts. |
| **03_DOCLISTDB_DETAILED.md** | Деталізований Offline DocListDB + R2 state/locks/runs. |
| **04_LLDBI_DETAILED.md** | Деталізований Offline LLDBI Ingestion. |
| **05_ONLINE_SEQUENCE.md** | Sequence diagram: User → Brain → Orchestrator → Retrieval → Assemble → OpenRouter → Verify → SSE. |
| **06_RUN_STATE_MACHINE.md** | State diagram: стани Run (Intake → … → Deliver, Failed, Cancelled, Degraded); Import (U8) timing, timeout, degraded. |
| **07_BLOCK_CARDS.md** | Картки блоків: усі блоки з 11 полями (Purpose, Inputs, Outputs, Storage, Dependencies, Secrets, Failure Modes, Retries, Observability, Test Hooks). |
| **export/** | Каталог для згенерованих SVG/PNG (заповнюється вручну або через mmdc). |

## Легенда кольорів (на діаграмах)

- **online** — блоки Online Serving (блакитний відтінок).
- **offline** — блоки Offline pipelines (зелений).
- **storage** — сховища (Supabase, Qdrant, R2) (жовтий/оранжевий).
- **external** — зовнішні сервіси (OpenRouter, Rada, DocList API, Web) (червоний відтінок).
