-- Read-only function for DB capability check (CI / brain:db:capabilities).
-- Returns columns presence and runs_status_check definition; no writes.

CREATE OR REPLACE FUNCTION public.get_lexery_db_capabilities()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'llm_result',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'llm_result'),
    'verify_result',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'verify_result'),
    'runs_status_check_def',
    (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid JOIN pg_namespace n ON t.relnamespace = n.oid WHERE n.nspname = 'public' AND t.relname = 'runs' AND c.conname = 'runs_status_check' AND c.contype = 'c' LIMIT 1)
  );
$$;

COMMENT ON FUNCTION public.get_lexery_db_capabilities() IS 'Lexery DB capability check: columns llm_result, verify_result and runs_status_check def. Read-only.';
