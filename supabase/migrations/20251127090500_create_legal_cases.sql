-- Table for Supreme Court case law embeddings
CREATE TABLE IF NOT EXISTS legal_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number text,
  court text NOT NULL,
  chamber text,
  decision_date date,
  document_type text,
  law_articles text[] DEFAULT '{}',
  main_law_code text,
  category text,
  summary text NOT NULL,
  legal_conclusion text NOT NULL,
  edrsr_url text,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legal_cases_case_number_idx
  ON legal_cases (case_number);

CREATE INDEX IF NOT EXISTS legal_cases_decision_date_idx
  ON legal_cases (decision_date DESC);

CREATE INDEX IF NOT EXISTS legal_cases_court_idx
  ON legal_cases (court);

-- Vector index optimized for cosine similarity search
CREATE INDEX IF NOT EXISTS legal_cases_embedding_idx
  ON legal_cases
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Keep updated_at synced automatically
CREATE OR REPLACE FUNCTION trg_legal_cases_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'legal_cases_updated_at_trg'
  ) THEN
    CREATE TRIGGER legal_cases_updated_at_trg
      BEFORE UPDATE ON legal_cases
      FOR EACH ROW
      EXECUTE FUNCTION trg_legal_cases_updated_at();
  END IF;
END $$;


