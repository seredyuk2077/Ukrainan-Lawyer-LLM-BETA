-- MM Docs prod shape guards
-- Lift key storage invariants into the DB to keep MM Docs compact and isolated.

ALTER TABLE IF EXISTS mm_doc_records FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS mm_doc_ingest_log FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_scope_shape_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_scope_shape_chk
      CHECK (
        (scope_type = 'conversation' AND conversation_id IS NOT NULL AND scope_id = conversation_id)
        OR (scope_type = 'project' AND project_id IS NOT NULL AND scope_id = project_id)
        OR (scope_type = 'user_global' AND scope_id IS NULL)
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_raw_r2_key_not_url_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_raw_r2_key_not_url_chk
      CHECK (raw_r2_key !~* '^https?://');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_canonical_r2_key_not_url_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_canonical_r2_key_not_url_chk
      CHECK (canonical_r2_key IS NULL OR canonical_r2_key !~* '^https?://');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_indexed_shape_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_indexed_shape_chk
      CHECK (
        status <> 'indexed'
        OR (
          canonical_r2_key IS NOT NULL
          AND chunk_count IS NOT NULL
          AND chunk_count > 0
        )
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_error_message_len_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_error_message_len_chk
      CHECK (char_length(COALESCE(error_message, '')) <= 1000);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_parser_warnings_shape_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_parser_warnings_shape_chk
      CHECK (
        jsonb_typeof(COALESCE(parser_warnings, '[]'::jsonb)) = 'array'
        AND jsonb_array_length(COALESCE(parser_warnings, '[]'::jsonb)) <= 8
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_ingest_log_message_len_chk'
  ) THEN
    ALTER TABLE mm_doc_ingest_log
      ADD CONSTRAINT mm_doc_ingest_log_message_len_chk
      CHECK (char_length(COALESCE(message, '')) <= 1000);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_ingest_log_metrics_object_chk'
  ) THEN
    ALTER TABLE mm_doc_ingest_log
      ADD CONSTRAINT mm_doc_ingest_log_metrics_object_chk
      CHECK (metrics IS NULL OR jsonb_typeof(metrics) = 'object');
  END IF;
END
$$;
