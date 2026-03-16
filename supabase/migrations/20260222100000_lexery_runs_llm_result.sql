-- Lexery Legal Agent: add llm_result to runs for durable U10 persistence (multi-instance Azure).
-- Apply to Supabase project used by Brain (SUPABASE_LEXERY_LEGAL_AGENT_DB_URL).
-- Enables idempotent U10: claim by updating status where llm_result IS NULL.

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS llm_result jsonb DEFAULT NULL;

COMMENT ON COLUMN runs.llm_result IS 'U10 Legal Agent result (answerText, model, latencyMs, usage). Durable for multi-instance.';
