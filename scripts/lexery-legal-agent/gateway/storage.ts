/**
 * U1 RunRecord persistence (LEX-71)
 */
import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../lib/supabase.js';
import { config } from '../lib/config.js';
import type {
  AuthContext,
  CreateRunRequest,
  RunSnapshot,
  AttachmentManifestItem,
} from './types.js';

export interface RunRecord {
  id: string;
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  conversation_id?: string | null;
  status: string;
  query: string | null;
  query_profile?: unknown;
  search_plan?: unknown;
  retrieval_trace?: unknown;
  gate_decision?: unknown;
  /** U9: durable assembled prompt meta (multi-instance safe). */
  assembled_prompt?: unknown;
  /** U10: durable LLM result (multi-instance safe). */
  llm_result?: unknown;
  /** U11: durable verify result (multi-instance safe). */
  verify_result?: unknown;
  attachments_manifest?: AttachmentManifestItem[] | null;
  snapshot: RunSnapshot;
  created_at: string;
}

export interface CreateRunInput {
  runId: string;
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  query: string;
  snapshot: RunSnapshot;
  attachmentsManifest?: AttachmentManifestItem[];
  idempotencyKey?: string;
}

/** Authoritative run source summary for verification (persisted in snapshot.source_summary). */
export interface RunSourceSummary {
  context_mode?: string | null;
  history_count?: number | null;
  memory_count?: number | null;
  law_count?: number | null;
  document_count?: number | null;
  triage_used?: boolean | null;
  prompt_tokens?: number | null;
  memory_scope_mode?: 'conversation' | 'user_global' | null;
  memory_fallback_used?: boolean | null;
}

export function isTransientStorageReadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|network/i.test(msg);
}

export async function withTransientStorageReadRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 250
): Promise<T> {
  const maxAttempts = Math.max(1, attempts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientStorageReadError(err) || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function isDuplicateRunIdConflict(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === '23505' && /runs_run_id_key/i.test(err.message ?? '');
}

export class RunRepository {
  private async ensureTenant(tenantId: string): Promise<void> {
    const sb = getSupabaseClient();
    const { error } = await sb.from('tenants').upsert(
      { id: tenantId, name: 'Dev Tenant', settings: {}, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
    if (error) {
      // Ignore duplicate / FK issues; tenant may already exist
      if (error.code !== '23505') throw error;
    }
  }

  async create(input: CreateRunInput): Promise<RunRecord> {
    const sb = getSupabaseClient();
    const now = new Date().toISOString();

    if (input.tenantId) {
      await this.ensureTenant(input.tenantId);
    }

    const row = {
      run_id: input.runId,
      tenant_id: input.tenantId || null,
      user_id: input.userId,
      conversation_id: input.conversationId ?? null,
      status: 'Intake',
      query: input.query,
      query_profile: null,
      search_plan: null,
      snapshot: input.snapshot as object,
      degraded_flags: {},
      error_code: null,
      attachments_manifest: (input.attachmentsManifest || null) as object | null,
      idempotency_key: input.idempotencyKey || null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };

    const { data, error } = await sb.from('runs').insert(row).select().single();

    if (error) {
      if (isDuplicateRunIdConflict(error)) {
        const existing = await this.findByRunId(input.runId);
        if (existing) return existing;
      }
      throw new StorageError('DB_WRITE_FAIL', error.message);
    }

    return data as RunRecord;
  }

  async findByRunId(runId: string): Promise<RunRecord | null> {
    return withTransientStorageReadRetry(async () => {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('runs')
        .select('*')
        .eq('run_id', runId)
        .limit(1)
        .single();

      if (error && error.code === 'PGRST116') return null;
      if (error) throw new StorageError('DB_READ_FAIL', error.message);
      return data as RunRecord;
    });
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<RunRecord | null> {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from('runs')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('idempotency_key', key)
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') return null;
    return data as RunRecord | null;
  }

  async updateQueryProfile(
    runId: string,
    queryProfile: object,
    status: string = 'Profiling'
  ): Promise<void> {
    const sb = getSupabaseClient();
    const { error } = await sb
      .from('runs')
      .update({
        query_profile: queryProfile as object,
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('run_id', runId);

    if (error) {
      throw new StorageError('DB_UPDATE_FAIL', error.message);
    }
  }

  async markFailed(runId: string, errorCode: string): Promise<void> {
    const sb = getSupabaseClient();
    const { error } = await sb
      .from('runs')
      .update({
        status: 'failed',
        error_code: errorCode,
        updated_at: new Date().toISOString(),
      })
      .eq('run_id', runId);

    if (error) {
      throw new StorageError('DB_UPDATE_FAIL', error.message);
    }
  }

  /** U3: persist SearchPlan + optional steps (LEX-105). Status → Planning. */
  async updateSearchPlan(
    runId: string,
    searchPlan: object,
    status: string = 'Planning'
  ): Promise<void> {
    const sb = getSupabaseClient();
    const { error } = await sb
      .from('runs')
      .update({
        search_plan: searchPlan as object,
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('run_id', runId);

    if (error) {
      throw new StorageError('DB_UPDATE_FAIL', error.message);
    }
  }

  /** U4: persist RetrievalTrace (LEX-106). Optional status update. */
  async updateRetrievalTrace(
    runId: string,
    retrievalTrace: object,
    status?: string
  ): Promise<void> {
    const sb = getSupabaseClient();
    const update: Record<string, unknown> = {
      retrieval_trace: retrievalTrace as object,
      updated_at: new Date().toISOString(),
    };
    if (status) update.status = status;
    const { error } = await sb.from('runs').update(update).eq('run_id', runId);

    if (error) {
      throw new StorageError('DB_UPDATE_FAIL', error.message);
    }
  }

  /** U5: persist GateDecision (LEX-118). */
  async updateGateDecision(runId: string, gateDecision: object): Promise<void> {
    const sb = getSupabaseClient();
    const { error } = await sb
      .from('runs')
      .update({
        gate_decision: gateDecision as object,
        updated_at: new Date().toISOString(),
      })
      .eq('run_id', runId);

    if (error) {
      throw new StorageError('DB_UPDATE_FAIL', error.message);
    }
  }

  /**
   * U9: persist assembled_prompt compact meta (meta + lawSourceRefs + budget) to DB.
   * Does NOT store full snippet text. Durable for crash recovery (multi-instance Azure).
   * Gracefully no-ops if column is missing.
   */
  async updateAssembledPrompt(runId: string, assembledPromptData: object): Promise<void> {
    try {
      const sb = getSupabaseClient();
      const { error } = await sb
        .from('runs')
        .update({
          assembled_prompt: assembledPromptData as object,
          updated_at: new Date().toISOString(),
        })
        .eq('run_id', runId);
      if (error) {
        // Non-fatal: column may not exist in older deployments
      }
    } catch {
      // Non-fatal: never block U9 → U10 pipeline for persistence failures
    }
  }

  /**
   * U10 idempotency (multi-instance): claim run for LLM. Only one instance gets true.
   * Updates status to U10_RUNNING only when llm_result IS NULL. Requires runs.llm_result column.
   * Returns false on error (e.g. column missing); caller can still proceed and persist to context only.
   */
  async claimU10Run(runId: string): Promise<boolean> {
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('runs')
        .update({
          status: 'U10_RUNNING',
          updated_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .is('llm_result', null)
        .select('run_id')
        .maybeSingle();

      if (error) return false;
      return data != null;
    } catch {
      return false;
    }
  }

  /**
   * Safe status update: try each candidate; on check constraint error try next. Used by U10/U11/U12.
   */
  async safeUpdateRunStatus(
    runId: string,
    statusCandidates: string[],
    extraFields: Record<string, unknown> = {}
  ): Promise<void> {
    const sb = getSupabaseClient();
    const updated_at = new Date().toISOString();
    for (const status of statusCandidates) {
      const payload = { ...extraFields, status, updated_at };
      const { error } = await sb.from('runs').update(payload).eq('run_id', runId);
      if (!error) return;
      if (error.code === '23514' || error.message?.includes('check constraint')) continue;
      throw new StorageError('DB_UPDATE_FAIL', error.message);
    }
    // last candidate failed with constraint: try without status change (only extra + updated_at)
    const payload = { ...extraFields, updated_at };
    const { error } = await sb.from('runs').update(payload).eq('run_id', runId);
    if (error) throw new StorageError('DB_UPDATE_FAIL', error.message);
  }

  /** U10: persist LLM result and set status to U10_DONE. Durable for GET /v1/runs/:id from any instance. */
  async updateLlmResult(runId: string, llmResult: object): Promise<void> {
    const sb = getSupabaseClient();
    const updated_at = new Date().toISOString();
    const statusCandidates = ['U10_DONE', 'Verifying', 'Deliver', 'completed'];
    for (const status of statusCandidates) {
      const { error } = await sb
        .from('runs')
        .update({
          llm_result: llmResult as object,
          status,
          updated_at,
        })
        .eq('run_id', runId);
      if (!error) return;
      if (error.code === '23514' || error.message?.includes('check constraint')) continue;
      throw new StorageError('DB_UPDATE_FAIL', error.message);
    }
    const { error } = await sb
      .from('runs')
      .update({ llm_result: llmResult as object, updated_at })
      .eq('run_id', runId);
    if (error) throw new StorageError('DB_UPDATE_FAIL', error.message);
  }

  /**
   * U11 claim: set status U11_RUNNING only when verify_result IS NULL (and status indicates U11 ready).
   * Returns true if this instance claimed. Requires runs.verify_result column.
   */
  async claimU11Run(runId: string): Promise<boolean> {
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('runs')
        .update({
          status: 'U11_RUNNING',
          updated_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .is('verify_result', null)
        .in('status', ['U10_DONE', 'Verifying', 'Deliver'])
        .select('run_id')
        .maybeSingle();

      if (error) return false;
      return data != null;
    } catch {
      return false;
    }
  }

  /** U11: persist verify result and set status U11_DONE. */
  async persistVerifyResult(runId: string, verifyResult: object): Promise<void> {
    await this.safeUpdateRunStatus(runId, ['U11_DONE', 'Deliver', 'completed'], {
      verify_result: verifyResult as object,
    });
  }

  /**
   * U12 claim: set status U12_RUNNING only when completed_at IS NULL (and status indicates U12 ready).
   * Returns true if this instance claimed.
   */
  async claimU12Run(runId: string): Promise<boolean> {
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('runs')
        .update({
          status: 'U12_RUNNING',
          updated_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .is('completed_at', null)
        .in('status', ['U11_DONE', 'Deliver'])
        .select('run_id')
        .maybeSingle();

      if (error) return false;
      return data != null;
    } catch {
      return false;
    }
  }

  /**
   * Authoritative run source summary for verification/acceptance (machine-readable).
   * Persisted in runs.snapshot.source_summary when run completes.
   */
  async patchRunSourceSummary(runId: string, summary: RunSourceSummary): Promise<void> {
    try {
      await this.patchSnapshotField(runId, 'source_summary', summary);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Patch a single field inside the runs.snapshot JSONB column.
   * Non-destructive: merges at top level (existing keys preserved).
   * Non-fatal: never throws — used for optional preview/diagnostic persistence.
   */
  async patchSnapshotField(runId: string, field: string, value: unknown): Promise<void> {
    try {
      const sb = getSupabaseClient();
      const { data: row } = await sb
        .from('runs')
        .select('snapshot')
        .eq('run_id', runId)
        .single();
      const current = (row?.snapshot as Record<string, unknown>) ?? {};
      const updated = { ...current, [field]: value };
      await sb
        .from('runs')
        .update({ snapshot: updated as object, updated_at: new Date().toISOString() })
        .eq('run_id', runId);
    } catch {
      // Non-fatal: preview persistence failure must never block the pipeline
    }
  }

  /** U12: set completed_at and status to completed. Safe for runs_status_check. */
  async completeRun(runId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.safeUpdateRunStatus(runId, ['completed', 'U11_DONE', 'Deliver'], {
      completed_at: now,
    });
  }

  /**
   * List last N messages for a conversation in chronological order (old -> new).
   * Returns { role, content, created_at } for RunContext.history.
   */
  async listConversationMessages(
    conversationId: string,
    limit: number
  ): Promise<Array<{ role: string; content: string }>> {
    try {
      const sb = getSupabaseClient();
      const { data: rows, error } = await sb
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(limit, 100)));
      if (error || !rows?.length) return [];
      const out = (rows as Array<{ role: string; content: string; created_at: string }>)
        .map((r) => ({ role: r.role ?? 'user', content: String(r.content ?? '').slice(0, 8000) }))
        .reverse();
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Idempotent user message insert. metadata.run_id = runId. Skip if already exists for this run_id.
   */
  async insertUserMessageIfNotExists(
    runId: string,
    conversationId: string,
    content: string
  ): Promise<boolean> {
    try {
      const sb = getSupabaseClient();
      const { data: rows } = await sb
        .from('messages')
        .select('id, metadata')
        .eq('conversation_id', conversationId)
        .eq('role', 'user')
        .limit(100);
      const exists = (rows ?? []).some(
        (r) => (r.metadata as Record<string, unknown>)?.run_id === runId
      );
      if (exists) return false;
      const { error } = await sb.from('messages').insert({
        conversation_id: conversationId,
        role: 'user',
        content: content.slice(0, 50000),
        metadata: { run_id: runId },
        created_at: new Date().toISOString(),
      });
      return !error;
    } catch {
      return false;
    }
  }

  /**
   * U12: idempotent assistant message. messages has no run_id column; use metadata.run_id. Skip if already exists.
   */
  async insertAssistantMessageIfNotExists(
    runId: string,
    conversationId: string,
    content: string
  ): Promise<boolean> {
    try {
      const sb = getSupabaseClient();
      const { data: rows } = await sb
        .from('messages')
        .select('id, metadata')
        .eq('conversation_id', conversationId)
        .eq('role', 'assistant')
        .limit(50);

      const exists = (rows ?? []).some(
        (r) => (r.metadata as Record<string, unknown>)?.run_id === runId
      );
      if (exists) return false;

      const { error } = await sb.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content,
        metadata: { run_id: runId },
        created_at: new Date().toISOString(),
      });
      return !error;
    } catch {
      return false;
    }
  }

  /**
   * U12: idempotent mm_outbox. Writes run_id and tenant_id in columns. Idempotency by run_id + event_type.
   */
  async insertMmOutboxIfNotExists(
    runId: string,
    conversationId: string | null,
    tenantId: string | null,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const sb = getSupabaseClient();
      const convId = conversationId ?? (payload.conversation_id as string | null);
      if (!convId) return false;

      const { data: existing } = await sb
        .from('mm_outbox')
        .select('id')
        .eq('event_type', eventType)
        .eq('run_id', runId)
        .limit(1);
      if (existing?.length) return false;
      const { data: legacy } = await sb
        .from('mm_outbox')
        .select('id, payload')
        .eq('event_type', eventType)
        .is('run_id', null)
        .limit(200);
      const existsLegacy = (legacy ?? []).some(
        (r) => (r.payload as Record<string, unknown>)?.run_id === runId
      );
      if (existsLegacy) return false;

      const row: Record<string, unknown> = {
        conversation_id: convId,
        event_type: eventType,
        payload: { ...payload, run_id: runId },
        status: 'pending',
        created_at: new Date().toISOString(),
        run_id: runId,
      };
      if (tenantId != null) row.tenant_id = tenantId;
      const { error } = await sb.from('mm_outbox').insert(row);
      return !error;
    } catch {
      return false;
    }
  }
}

export class StorageError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
