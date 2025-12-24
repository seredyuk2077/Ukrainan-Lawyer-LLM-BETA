-- Supabase storage + metadata setup for dedicated ZU bucket

-- Bucket for Ukrainian laws (ЗУ)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'zu',
    'zu',
    false,
    104857600,
    ARRAY['application/json', 'text/plain', 'text/html']
)
ON CONFLICT (id) DO UPDATE
SET file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policies for bucket "zu"
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Authenticated users can read zu bucket'
      AND tablename = 'objects'
      AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Authenticated users can read zu bucket"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'zu'
        AND auth.role() = 'authenticated'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Service role can manage zu bucket'
      AND tablename = 'objects'
      AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Service role can manage zu bucket"
      ON storage.objects FOR ALL
      USING (
        bucket_id = 'zu'
        AND auth.role() = 'service_role'
      )
      WITH CHECK (
        bucket_id = 'zu'
        AND auth.role() = 'service_role'
      );
  END IF;
END $$;

-- Metadata table for stored laws
CREATE TABLE IF NOT EXISTS legal_documents_storage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rada_dokid bigint,
  rada_nreg text UNIQUE NOT NULL,
  title text NOT NULL,
  law_number text,
  document_type text,
  codex_type text,
  is_procedural boolean DEFAULT false,
  storage_bucket text NOT NULL DEFAULT 'zu',
  storage_path text NOT NULL,
  category text,
  theme_code text,
  keywords jsonb DEFAULT '[]'::jsonb,
  file_size integer,
  articles_count integer,
  last_synced_at timestamptz DEFAULT now(),
  next_sync_at timestamptz,
  sync_status text DEFAULT 'synced',
  sync_error text,
  is_active boolean DEFAULT true,
  source_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legal_documents_storage_rada_nreg
  ON legal_documents_storage (rada_nreg);
CREATE INDEX IF NOT EXISTS idx_legal_documents_storage_theme
  ON legal_documents_storage (theme_code);
CREATE INDEX IF NOT EXISTS idx_legal_documents_storage_category
  ON legal_documents_storage (category);

CREATE OR REPLACE FUNCTION trg_legal_documents_storage_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'legal_documents_storage_updated_at_trg'
  ) THEN
    CREATE TRIGGER legal_documents_storage_updated_at_trg
      BEFORE UPDATE ON legal_documents_storage
      FOR EACH ROW
      EXECUTE FUNCTION trg_legal_documents_storage_updated_at();
  END IF;
END $$;

-- Grant access
GRANT SELECT, INSERT, UPDATE, DELETE ON legal_documents_storage TO service_role;
GRANT SELECT ON legal_documents_storage TO authenticated;

