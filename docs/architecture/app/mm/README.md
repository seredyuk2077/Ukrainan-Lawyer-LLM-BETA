# MM Memory / MM Docs

Канонічна документація для Memory Manager (`MM memory`) і `MM Docs`.

## Основні документи

- `memory-pipeline.md` — runtime-потік memory write/read path.
- `verification.md` — operational runbook і live-proof checklist.
- `r2-storage-map.md` — схема R2 namespace.
- `retrieval-trace-storage-policy.md` — політика compact/durable trace storage.
- `doc-memory-future-structure.md` — майбутня структура DocMemory.
- `reports/README.md` — point-in-time bootstrap/foundation reports.

## Правило структури

- Те, що описує актуальний runtime або storage contract, лишається в корені `mm/`.
- Датовані звіти про конкретний прогін чи фазу стабілізації переносяться в `mm/reports/`.
