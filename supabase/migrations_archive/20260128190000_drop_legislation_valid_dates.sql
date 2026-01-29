-- Drop unused validity date columns (no longer used by pipeline).
-- Keeping validity_status + source_status_* + status_note as the minimal contract.

ALTER TABLE public.legislation_documents
  DROP COLUMN IF EXISTS valid_from;

ALTER TABLE public.legislation_documents
  DROP COLUMN IF EXISTS valid_to;

