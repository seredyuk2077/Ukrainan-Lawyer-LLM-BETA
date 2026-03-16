-- DEV RUN v11: Memory storage policy — Supabase minimal, R2 offload for heavy content.
-- Add pointer fields to mm_memory_items when content is stored in R2.

ALTER TABLE mm_memory_items ADD COLUMN IF NOT EXISTS r2_key TEXT;
ALTER TABLE mm_memory_items ADD COLUMN IF NOT EXISTS content_size INTEGER;

COMMENT ON COLUMN mm_memory_items.r2_key IS 'R2 object key when content is offloaded (tenant/{tenant_id}/mm/offload/{id}.json)';
COMMENT ON COLUMN mm_memory_items.content_size IS 'Byte length of full content; when offloaded, content column holds preview only';
