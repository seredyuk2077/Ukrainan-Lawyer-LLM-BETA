-- DEV RUN v10: Memory pipeline schema improvements
-- 1. mm_outbox: add run_id + tenant_id for proper worker indexing
-- 2. mm_summaries: add tenant_id for multi-tenant isolation
-- 3. chat_sessions: add project_id + prompt fields
-- 4. projects: new table for project-level system prompts

-- ── mm_outbox enhancements ─────────────────────────────────────────────────────
ALTER TABLE mm_outbox ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE mm_outbox ADD COLUMN IF NOT EXISTS tenant_id UUID;
CREATE INDEX IF NOT EXISTS mm_outbox_status_created ON mm_outbox (status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS mm_outbox_tenant_conv ON mm_outbox (tenant_id, conversation_id);

-- ── mm_summaries: add tenant_id ───────────────────────────────────────────────
ALTER TABLE mm_summaries ADD COLUMN IF NOT EXISTS tenant_id UUID;
CREATE INDEX IF NOT EXISTS mm_summaries_tenant_conv ON mm_summaries (tenant_id, conversation_id);
CREATE INDEX IF NOT EXISTS mm_summaries_user_conv ON mm_summaries (user_id, conversation_id);

-- ── mm_memory_items: add index for semantic lookup ─────────────────────────────
CREATE INDEX IF NOT EXISTS mm_memory_items_tenant_user ON mm_memory_items (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS mm_memory_items_conv ON mm_memory_items (conversation_id);

-- ── projects: new table for project-level system prompts ──────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  system_prompt TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS projects_tenant ON projects (tenant_id);

-- ── chat_sessions: extend with project_id + prompt overrides ─────────────────
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS chat_system_prompt TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS user_system_prompt TEXT;
CREATE INDEX IF NOT EXISTS chat_sessions_project ON chat_sessions (project_id);
