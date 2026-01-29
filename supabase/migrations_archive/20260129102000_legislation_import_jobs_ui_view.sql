-- View for monitoring import jobs (operator-friendly dashboard).

CREATE OR REPLACE VIEW public.legislation_import_jobs_ui AS
SELECT
  id,
  status,
  created_at,
  started_at,
  completed_at,
  total_count,
  processed_count,
  success_count,
  error_count,
  (processed_count::float / NULLIF(total_count,0))::numeric(5,2) AS progress_ratio,
  -- Extract key config fields (assuming JSON shape from importer)
  COALESCE(config->>'rada_nreg', config->>'nreg') AS rada_nreg,
  config,
  progress_data,
  error_message
FROM public.legislation_import_jobs;

