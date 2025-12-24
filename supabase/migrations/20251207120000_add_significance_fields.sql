-- Add significance flags for Supreme Court cases
ALTER TABLE legal_cases
  ADD COLUMN IF NOT EXISTS is_significant boolean DEFAULT false;

ALTER TABLE legal_cases
  ADD COLUMN IF NOT EXISTS significance_score numeric;

-- Preserve existing discoverability until переоцінка завершена
UPDATE legal_cases
SET is_significant = true
WHERE is_significant IS NULL;

-- Filter RPC to return лише значимі справи
CREATE OR REPLACE FUNCTION match_supreme_court_cases(
  query_embedding vector(1536),
  match_limit integer DEFAULT 5,
  min_similarity double precision DEFAULT 0.7
)
RETURNS TABLE (
  id uuid,
  case_number text,
  court text,
  chamber text,
  decision_date date,
  document_type text,
  law_articles text[],
  main_law_code text,
  category text,
  summary text,
  legal_conclusion text,
  edrsr_url text,
  motiv_part text,
  court_panel text[],
  metadata jsonb,
  similarity double precision
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF query_embedding IS NULL THEN
    RAISE EXCEPTION 'query_embedding must not be null';
  END IF;

  RETURN QUERY
  SELECT
    lc.id,
    lc.case_number,
    lc.court,
    lc.chamber,
    lc.decision_date,
    lc.document_type,
    lc.law_articles,
    lc.main_law_code,
    lc.category,
    lc.summary,
    lc.legal_conclusion,
    lc.edrsr_url,
    lc.motiv_part,
    lc.court_panel,
    lc.metadata,
    1 - (lc.embedding <=> query_embedding) AS similarity
  FROM legal_cases lc
  WHERE lc.embedding IS NOT NULL
    AND lc.is_significant IS TRUE
    AND (1 - (lc.embedding <=> query_embedding)) >= min_similarity
  ORDER BY lc.embedding <=> query_embedding
  LIMIT GREATEST(1, match_limit);
END;
$$;

