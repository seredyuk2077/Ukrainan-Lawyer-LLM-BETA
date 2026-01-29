-- Drop legacy legal_status column — superseded by validity_status.

ALTER TABLE public.legislation_documents
  DROP COLUMN IF EXISTS legal_status;

