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
  status: string;
  query: string | null;
  snapshot: RunSnapshot;
  created_at: string;
}

export interface CreateRunInput {
  runId: string;
  tenantId: string | null;
  userId: string;
  query: string;
  snapshot: RunSnapshot;
  attachmentsManifest?: AttachmentManifestItem[];
  idempotencyKey?: string;
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
      conversation_id: null,
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
      throw new StorageError('DB_WRITE_FAIL', error.message);
    }

    return data as RunRecord;
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
