# Tests — Lexery Legislation DB Infrastructure

**Призначення:** тести по етапах (import, verify, qdrant sync, validity, soak) + helpers + data.  
**Статус:** структура створена; тести поки в `scripts/legislation/test/`, команди в `admin-cli` (test-kku, soak-test, verify, regression-validity, тощо).

**Як запускати:** `pnpm tsx scripts/legislation/admin-cli.ts soak-test --dry-run`, `verify --nreg <nreg>`, `regression-validity`, тощо. Див. INVENTORY_INDEX TEST MATRIX.

---

*Working process audit — 2025-01-29*
