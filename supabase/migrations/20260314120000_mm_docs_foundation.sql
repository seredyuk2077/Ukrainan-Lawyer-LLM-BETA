-- MM Docs foundation
-- Metadata and ingest log tables for user-uploaded document RAG.
-- Heavy content stays in R2; embeddings/chunks stay in dedicated Qdrant collection.

CREATE TABLE IF NOT EXISTS mm_doc_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NULL,
  user_id UUID NOT NULL,
  project_id TEXT NULL,
  conversation_id TEXT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('conversation', 'project', 'user_global')),
  scope_id TEXT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('chat_attachment', 'project_upload', 'user_upload')),
  source_run_id UUID NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT NULL,
  content_sha256 TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  canonical_r2_key TEXT NULL,
  parser_format TEXT NULL,
  parser_warnings JSONB NULL DEFAULT '[]'::jsonb,
  chunk_count INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ingesting', 'indexed', 'failed')),
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mm_doc_records_tenant_user_scope
  ON mm_doc_records (tenant_id, user_id, scope_type, scope_id);

CREATE INDEX IF NOT EXISTS mm_doc_records_project
  ON mm_doc_records (tenant_id, user_id, project_id);

CREATE INDEX IF NOT EXISTS mm_doc_records_conversation
  ON mm_doc_records (tenant_id, user_id, conversation_id);

CREATE INDEX IF NOT EXISTS mm_doc_records_status
  ON mm_doc_records (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS mm_doc_records_source_run
  ON mm_doc_records (source_run_id);

CREATE TABLE IF NOT EXISTS mm_doc_ingest_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID NULL REFERENCES mm_doc_records(id) ON DELETE CASCADE,
  tenant_id UUID NULL,
  user_id UUID NOT NULL,
  run_id UUID NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'error')),
  message TEXT NULL,
  metrics JSONB NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mm_doc_ingest_log_doc
  ON mm_doc_ingest_log (doc_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mm_doc_ingest_log_tenant_user
  ON mm_doc_ingest_log (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mm_doc_ingest_log_run
  ON mm_doc_ingest_log (run_id, created_at DESC);
