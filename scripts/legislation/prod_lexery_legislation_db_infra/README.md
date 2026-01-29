# Prod — Lexery Legislation DB Infrastructure

**Призначення:** канонічне місце прод-коду (commands, lib, canonical, documentTypes, taxonomy, utils).  
**Статус:** код перенесено сюди; compat stubs у корені `scripts/legislation` (commands/, lib/, config, radaClient). Entrypoint без змін: `scripts/legislation/admin-cli.ts`.

**Як запускати:** `pnpm exec tsx scripts/legislation/admin-cli.ts --help` | `add` | `verify` | `remove` | `soak-test` тощо.

---

*Working process audit — 2025-01-29; final restructure — 2026-01-30*
