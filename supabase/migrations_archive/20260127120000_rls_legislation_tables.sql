-- RLS + least-privilege for legislation tables (no breakage: service_role bypasses RLS).
-- Goal: anon = no access; authenticated = read-only (monitoring); service_role = full (CLI/importer).

-- 1) Enable RLS on base tables
ALTER TABLE public.legislation_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legislation_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legislation_import_proposals ENABLE ROW LEVEL SECURITY;

-- 2) Policies: authenticated can SELECT only (views use these tables under invoker)
CREATE POLICY "legislation_documents_select_authenticated"
  ON public.legislation_documents FOR SELECT TO authenticated USING (true);

CREATE POLICY "legislation_import_jobs_select_authenticated"
  ON public.legislation_import_jobs FOR SELECT TO authenticated USING (true);

CREATE POLICY "legislation_import_proposals_select_authenticated"
  ON public.legislation_import_proposals FOR SELECT TO authenticated USING (true);

-- 3) Revoke anon: no access to base tables
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.legislation_documents FROM anon;
REVOKE SELECT ON public.legislation_documents FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.legislation_import_jobs FROM anon;
REVOKE SELECT ON public.legislation_import_jobs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.legislation_import_proposals FROM anon;
REVOKE SELECT ON public.legislation_import_proposals FROM anon;

-- 4) Revoke anon: no access to views
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.legislation_documents_ui FROM anon;
REVOKE SELECT ON public.legislation_documents_ui FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.legislation_import_jobs_ui FROM anon;
REVOKE SELECT ON public.legislation_import_jobs_ui FROM anon;

-- 5) Revoke authenticated write on base tables (read-only for operators)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.legislation_documents FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.legislation_import_jobs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.legislation_import_proposals FROM authenticated;

-- 6) Revoke authenticated write on views (explicit read-only)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.legislation_documents_ui FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.legislation_import_jobs_ui FROM authenticated;
