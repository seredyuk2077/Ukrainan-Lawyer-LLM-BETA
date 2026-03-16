# Context Recovery

Контекстні та recovery-документи для крос-стадійної роботи по Lexery Legal Agent.

## Що тримати тут

- `CONTEXT_RECOVERY_REPORT.md` — коротке відновлення поточного стану системи.
- `CURRENT_PIPELINE_STATE.md` — канонічний state-of-the-world по U1-U12/MM, тестах і architectural drift.
- `U9_U10_STATE_AND_REQUIREMENTS.md` — крос-стадійні вимоги та обмеження для U9/U10.
- `reports/` — датовані аудити, stabilization reports, implementation snapshots.

## Правило структури

- Канонічні документи по конкретній стадії мають жити у відповідній папці `u*/` або `mm/`.
- `context/` зберігає тільки recovery notes, cross-stage state snapshots і історичні звіти, які не є єдиним джерелом правди для окремого етапу.
