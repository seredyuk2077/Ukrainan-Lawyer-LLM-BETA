-- Lexery Legal Agent: add assembled_prompt to runs for durable U9 persistence (multi-instance Azure).
-- Stores compact AssembledPrompt (meta + sourceRefs, not full text to keep size reasonable).
-- U10 can read from DB when in-memory RunContext is unavailable (e.g. instance crash/restart).

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS assembled_prompt jsonb DEFAULT NULL;

COMMENT ON COLUMN runs.assembled_prompt IS 'U9 Assemble result (meta + lawSourceRefs + budget). Durable for multi-instance. Full snippet text NOT stored (re-loadable from R2).';
