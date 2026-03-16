-- MM Docs DB shape limits
-- Keep MM Docs rows compact and reject malformed/internal-only storage fields at the database layer.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_original_filename_len_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_original_filename_len_chk
      CHECK (
        char_length(btrim(COALESCE(original_filename, ''))) > 0
        AND char_length(original_filename) <= 255
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_content_type_len_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_content_type_len_chk
      CHECK (content_type IS NULL OR char_length(content_type) <= 255);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_content_sha256_hex_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_content_sha256_hex_chk
      CHECK (content_sha256 ~* '^[0-9a-f]{64}$');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_raw_r2_key_len_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_raw_r2_key_len_chk
      CHECK (
        char_length(btrim(COALESCE(raw_r2_key, ''))) > 0
        AND char_length(raw_r2_key) <= 1024
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_records_canonical_r2_key_len_chk'
  ) THEN
    ALTER TABLE mm_doc_records
      ADD CONSTRAINT mm_doc_records_canonical_r2_key_len_chk
      CHECK (canonical_r2_key IS NULL OR char_length(canonical_r2_key) <= 1024);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mm_doc_ingest_log_stage_len_chk'
  ) THEN
    ALTER TABLE mm_doc_ingest_log
      ADD CONSTRAINT mm_doc_ingest_log_stage_len_chk
      CHECK (
        char_length(btrim(COALESCE(stage, ''))) > 0
        AND char_length(stage) <= 64
      );
  END IF;
END
$$;
