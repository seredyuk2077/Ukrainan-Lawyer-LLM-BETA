-- MM Docs hardening
-- Security, dedupe invariants, and query-path indexes for production usage.

ALTER TABLE IF EXISTS mm_doc_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS mm_doc_ingest_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE mm_doc_records FROM anon, authenticated;
REVOKE ALL ON TABLE mm_doc_ingest_log FROM anon, authenticated;

GRANT ALL ON TABLE mm_doc_records TO service_role;
GRANT ALL ON TABLE mm_doc_ingest_log TO service_role;

DROP POLICY IF EXISTS mm_doc_records_service_role_all ON mm_doc_records;
CREATE POLICY mm_doc_records_service_role_all
  ON mm_doc_records
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS mm_doc_ingest_log_service_role_all ON mm_doc_ingest_log;
CREATE POLICY mm_doc_ingest_log_service_role_all
  ON mm_doc_ingest_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE UNIQUE INDEX IF NOT EXISTS mm_doc_records_tenant_user_raw_r2_key_uniq
  ON mm_doc_records ((COALESCE(tenant_id::text, '')), user_id, raw_r2_key);

CREATE INDEX IF NOT EXISTS mm_doc_records_indexed_scope_lookup
  ON mm_doc_records (tenant_id, user_id, scope_type, scope_id, updated_at DESC)
  WHERE status = 'indexed';

CREATE INDEX IF NOT EXISTS mm_doc_records_indexed_project_lookup
  ON mm_doc_records (tenant_id, user_id, project_id, updated_at DESC)
  WHERE status = 'indexed' AND project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mm_doc_records_indexed_conversation_lookup
  ON mm_doc_records (tenant_id, user_id, conversation_id, updated_at DESC)
  WHERE status = 'indexed' AND conversation_id IS NOT NULL;
