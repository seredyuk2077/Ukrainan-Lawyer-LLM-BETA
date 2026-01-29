# Security + RLS — Baseline & Access Matrix (2026-01-27)

## Phase 0 — Baseline (before RLS)

- **Tables:** `legislation_documents` (244), `legislation_import_jobs` (534), `legislation_import_proposals` (0)
- **Views:** `legislation_documents_ui`, `legislation_import_jobs_ui`
- **RLS:** All three tables had RLS **disabled**. No policies.
- **Privileges:** `anon`, `authenticated`, `service_role`, `postgres` had full CRUD on all three tables and both views (default Supabase public schema grants).

## RLS Access Matrix (after migration `rls_legislation_tables_20260127`)

| Actor            | legislation_documents | legislation_import_jobs | legislation_import_proposals | legislation_documents_ui | legislation_import_jobs_ui |
|------------------|------------------------|--------------------------|------------------------------|---------------------------|----------------------------|
| **anon**         | No access              | No access                | No access                    | No access                 | No access                  |
| **authenticated**| SELECT only            | SELECT only              | SELECT only                   | SELECT only               | SELECT only                |
| **service_role** | Full (RLS bypass)      | Full (RLS bypass)        | Full (RLS bypass)             | Full                      | Full                       |

- **CLI/importer/backfill/repair/verify** use `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY` → service_role → RLS bypass → no breakage.
- **Operator dashboard** (authenticated users): read-only access to base tables and views.

## Where to set secrets

- **Legislation CLI / scripts:** `.env` in project root. Required: `SUPABASE_LEGISLATION_URL`, `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY`, `R2_*`, `qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB`, `qdrant_clusterAPI_LEXERY_LEGISLATION_DB`, `OPEN_ROUTER_API_RAG` (or `OPEN_ROUTER_API_KEY`). Never commit `.env`; use `.env.example` with placeholders only.
- **Frontend (Vite):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` in `.env` (anon key is publishable by design; no service key in frontend).
- **Backend:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`) in env.

## Migration file

- Repo: `supabase/migrations/20260127120000_rls_legislation_tables.sql`
- Applied to legislation project via MCP: `rls_legislation_tables_20260127`
