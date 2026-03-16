-- MM outbox lease/reclaim: processing_started_at, lease_expires_at, attempt_count, last_error, worker_id.
-- Enables reclaim of expired 'processing' rows; no fire-and-forget stuck rows.

ALTER TABLE mm_outbox ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE mm_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE mm_outbox ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mm_outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE mm_outbox ADD COLUMN IF NOT EXISTS worker_id TEXT;

-- Reclaim: find pending or expired processing rows
CREATE INDEX IF NOT EXISTS mm_outbox_reclaim_pending
  ON mm_outbox (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS mm_outbox_reclaim_processing
  ON mm_outbox (lease_expires_at, created_at) WHERE status = 'processing';

COMMENT ON COLUMN mm_outbox.processing_started_at IS 'When worker claimed the row (set on claim)';
COMMENT ON COLUMN mm_outbox.lease_expires_at IS 'Lease expiry; expired rows are eligible for reclaim';
COMMENT ON COLUMN mm_outbox.attempt_count IS 'Number of processing attempts';
COMMENT ON COLUMN mm_outbox.last_error IS 'Last error message on failure';
COMMENT ON COLUMN mm_outbox.worker_id IS 'Worker run id that holds the lease';
