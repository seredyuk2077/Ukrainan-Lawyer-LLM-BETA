-- AI-controlled importer foundation: proposals table (stub, no logic yet).

CREATE TABLE IF NOT EXISTS public.legislation_import_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rada_nreg text NOT NULL,
  proposed_by text NOT NULL DEFAULT 'manual', -- manual/system/ai
  decision text NOT NULL DEFAULT 'pending',   -- pending/approved/rejected
  decision_reason text,
  evidence jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS legislation_import_proposals_nreg_idx
  ON public.legislation_import_proposals (rada_nreg);

