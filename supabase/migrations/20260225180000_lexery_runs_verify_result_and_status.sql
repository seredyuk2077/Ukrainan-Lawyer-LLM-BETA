-- Lexery Legal Agent: verify_result + extend runs.status for U10/U11 steps (Azure multi-instance).
-- Apply to Supabase project used by Brain.

-- U11 durable result
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS verify_result jsonb DEFAULT NULL;

COMMENT ON COLUMN runs.verify_result IS 'U11 Verify result (verdict, reasons). Durable for multi-instance.';

-- Extend status check to allow U10/U11 step statuses (claim pattern)
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;

ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (
  status = ANY (ARRAY[
    'Intake'::text, 'Profiling'::text, 'Planning'::text, 'Retrieval'::text,
    'Assemble'::text, 'Writing'::text, 'Verifying'::text, 'Deliver'::text,
    'completed'::text, 'failed'::text, 'cancelled'::text,
    'U10_RUNNING'::text, 'U10_DONE'::text, 'U11_RUNNING'::text, 'U11_DONE'::text,
    'U12_RUNNING'::text
  ])
);
