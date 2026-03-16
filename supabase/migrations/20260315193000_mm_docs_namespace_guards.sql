-- MM Docs namespace guards
-- Keep MM Docs pointers confined to approved internal R2 namespaces.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_raw_r2_key_namespace_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_raw_r2_key_namespace_chk
      CHECK (
        raw_r2_key ~ '^tenant/[^/]+/runs/[^/]+/attachments/.+$'
        OR raw_r2_key ~ '^tenant/[^/]+/mm/docs/[^/]+/raw/[^/]+/.+$'
        OR raw_r2_key ~ '^tenant/[^/]+/mm/docs/user/[^/]+/raw/[^/]+/.+$'
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_canonical_r2_key_namespace_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_canonical_r2_key_namespace_chk
      CHECK (
        canonical_r2_key IS NULL
        OR canonical_r2_key ~ '^tenant/[^/]+/mm/docs/[^/]+/scope/(conversation|project|user_global)/[^/]+/[^/]+/canonical\.json$'
        OR canonical_r2_key ~ '^tenant/[^/]+/mm/docs/user/[^/]+/scope/(conversation|project|user_global)/[^/]+/[^/]+/canonical\.v1\.json$'
      );
  END IF;
END
$$;
