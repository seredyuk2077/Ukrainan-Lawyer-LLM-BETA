BEGIN;

ALTER TABLE legal_cases
  ADD COLUMN IF NOT EXISTS normalized_articles text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS topic text,
  ADD COLUMN IF NOT EXISTS subtopic text,
  ADD COLUMN IF NOT EXISTS issue_keywords text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS embedding_summary vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_norm_articles vector(1536),
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE INDEX IF NOT EXISTS legal_cases_search_tsv_idx ON legal_cases USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS legal_cases_category_idx ON legal_cases (category);
CREATE INDEX IF NOT EXISTS legal_cases_chamber_idx ON legal_cases (chamber);
CREATE INDEX IF NOT EXISTS legal_cases_decision_date_idx_v2 ON legal_cases (decision_date);

CREATE INDEX IF NOT EXISTS legal_cases_embedding_summary_idx
  ON legal_cases
  USING ivfflat (embedding_summary vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS legal_cases_embedding_norm_articles_idx
  ON legal_cases
  USING ivfflat (embedding_norm_articles vector_cosine_ops)
  WITH (lists = 100);

CREATE OR REPLACE FUNCTION legal_cases_refresh_tsv()
RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.legal_conclusion, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.topic, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.subtopic, '')), 'B') ||
    setweight(to_tsvector('simple', array_to_string(coalesce(NEW.issue_keywords, '{}'::text[]), ' ')), 'C') ||
    setweight(to_tsvector('simple', array_to_string(coalesce(NEW.normalized_articles, '{}'::text[]), ' ')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS legal_cases_search_tsv_trg ON legal_cases;
CREATE TRIGGER legal_cases_search_tsv_trg
  BEFORE INSERT OR UPDATE ON legal_cases
  FOR EACH ROW
  EXECUTE FUNCTION legal_cases_refresh_tsv();

CREATE OR REPLACE FUNCTION match_supreme_court_hybrid(
  query_text text,
  query_embedding vector(1536),
  year_from integer DEFAULT NULL,
  year_to integer DEFAULT NULL,
  category text DEFAULT NULL,
  chamber text DEFAULT NULL,
  match_limit integer DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  case_number text,
  court text,
  chamber_out text,
  decision_date date,
  document_type text,
  law_articles text[],
  normalized_articles text[],
  main_law_code text,
  category_out text,
  summary text,
  legal_conclusion text,
  topic text,
  subtopic text,
  issue_keywords text[],
  edrsr_url text,
  motiv_part text,
  court_panel text[],
  metadata jsonb,
  similarity double precision,
  tsv_rank double precision,
  norm_boost double precision
) LANGUAGE plpgsql AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  IF query_embedding IS NULL THEN
    RAISE EXCEPTION 'query_embedding must not be null';
  END IF;

  v_tsquery := CASE
    WHEN query_text IS NOT NULL AND length(trim(query_text)) > 0
      THEN plainto_tsquery('simple', query_text)
    ELSE NULL
  END;

  RETURN QUERY
  WITH base AS (
    SELECT
      lc.*,
      CASE
        WHEN v_tsquery IS NOT NULL THEN COALESCE(ts_rank_cd(COALESCE(lc.search_tsv, to_tsvector('simple', '')), v_tsquery), 0)
        ELSE 0
      END AS tsv_rank,
      1 - (lc.embedding_summary <=> query_embedding) AS vec_sim,
      CASE
        WHEN query_text IS NOT NULL AND lc.normalized_articles IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM unnest(lc.normalized_articles) na
            WHERE lower(query_text) LIKE '%' || lower(na) || '%'
          )
        THEN 0.05 ELSE 0 END AS norm_boost
    FROM legal_cases lc
    WHERE lc.is_significant IS TRUE
      AND lc.embedding_summary IS NOT NULL
      AND (year_from IS NULL OR lc.decision_date >= make_date(year_from, 1, 1))
      AND (year_to IS NULL OR lc.decision_date <= make_date(year_to, 12, 31))
      AND (category IS NULL OR lc.category = category)
      AND (chamber IS NULL OR lc.chamber = chamber)
      AND (v_tsquery IS NULL OR lc.search_tsv @@ v_tsquery)
  )
  SELECT
    id,
    case_number,
    court,
    chamber AS chamber_out,
    decision_date,
    document_type,
    law_articles,
    normalized_articles,
    main_law_code,
    category AS category_out,
    summary,
    legal_conclusion,
    topic,
    subtopic,
    issue_keywords,
    edrsr_url,
    motiv_part,
    court_panel,
    metadata,
    COALESCE(vec_sim, 0) + COALESCE(norm_boost, 0) + (COALESCE(tsv_rank, 0) * 0.4) AS similarity,
    tsv_rank,
    norm_boost
  FROM base
  ORDER BY (COALESCE(vec_sim, 0) + COALESCE(norm_boost, 0) + (COALESCE(tsv_rank, 0) * 0.4)) DESC
  LIMIT GREATEST(1, match_limit);
END;
$$;

COMMIT;

