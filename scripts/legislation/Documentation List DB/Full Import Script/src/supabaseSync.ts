import { createClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { EnvConfig } from './config.js';
import { backoffDelayMs, sleep } from './utils.js';

export interface SupabaseDocMapEntry {
  supabase_doc_id: string;
}

export interface SupabaseSyncConfig {
  enabled: boolean;
  table: string; // primary table (default: legal_documents)
  nregColumn: string; // primary nreg column (default: nreg)
  idColumn: string; // primary id column (default: id)
  pageSize: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export type SupabaseNregToIdMap = Map<string, string>;

export function defaultSupabaseSyncConfig(): SupabaseSyncConfig {
  return {
    enabled: true,
    table: 'legal_documents',
    nregColumn: 'nreg',
    idColumn: 'id',
    pageSize: 1000,
    maxRetries: 5,
    backoffBaseMs: 500,
    backoffMaxMs: 10_000,
  };
}

export async function loadSupabaseNregMap(params: {
  logger: Logger;
  env: EnvConfig;
  cfg: SupabaseSyncConfig;
}): Promise<SupabaseNregToIdMap> {
  if (!params.cfg.enabled) {
    params.logger.info('supabase sync disabled');
    return new Map();
  }

  const url = params.env.supabaseUrl;
  const key = params.env.supabaseServiceRoleKey;
  if (!url || !key) {
    throw new Error(
      'Supabase sync is enabled, but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing. ' +
        'Set env vars or run with --skip-supabase-sync.'
    );
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  }) as any;

  const map: SupabaseNregToIdMap = new Map();

  // "Auto" fallback strategy:
  // We prefer the contract table `legal_documents (id, nreg)`, but real projects may use:
  // - `legal_documents_storage (id, rada_nreg)`
  // - `legislation_documents (rada_nreg)` with PK=rada_nreg (no UUID id)
  // In all cases we build an in-memory map `nreg -> supabase_doc_id` (string).
  const candidates: Array<{ table: string; nregColumn: string; idColumn: string | null; idIsNreg?: boolean }> = [
    { table: params.cfg.table, nregColumn: params.cfg.nregColumn, idColumn: params.cfg.idColumn },
    { table: 'legal_documents_storage', nregColumn: 'rada_nreg', idColumn: 'id' },
    { table: 'legislation_documents', nregColumn: 'rada_nreg', idColumn: null, idIsNreg: true },
  ];

  let lastErr: unknown = null;
  for (const c of candidates) {
    try {
      const loaded = await loadMapFromTable({
        logger: params.logger,
        supabase,
        cfg: params.cfg,
        table: c.table,
        nregColumn: c.nregColumn,
        idColumn: c.idColumn,
        idIsNreg: Boolean(c.idIsNreg),
      });
      params.logger.info(
        { table: c.table, nregColumn: c.nregColumn, idColumn: c.idColumn, count: loaded.size },
        'supabase nreg->id map loaded'
      );
      return loaded;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      params.logger.warn({ table: c.table, err: msg }, 'supabase sync: table candidate failed; trying next');
      continue;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function withRetries<T>(
  params: { logger: Logger; cfg: SupabaseSyncConfig },
  fn: () => Promise<T>
): Promise<T> {
  for (let attempt = 1; attempt <= params.cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryableSupabaseError(e)) throw e;
      if (attempt === params.cfg.maxRetries) throw e;
      const delay = backoffDelayMs(attempt, params.cfg.backoffBaseMs, params.cfg.backoffMaxMs);
      params.logger.warn({ attempt, delayMs: delay, err: e instanceof Error ? e.message : String(e) }, 'supabase retry');
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}

function isRetryableSupabaseError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);

  // Non-retryable: table doesn't exist / schema cache doesn't have it
  if (msg.includes("Could not find the table 'public.")) return false;
  if (msg.toLowerCase().includes('schema cache')) return false;
  if (msg.toLowerCase().includes('relation') && msg.toLowerCase().includes('does not exist')) return false;

  // Retryable: transient network issues
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) return true;
  if (msg.includes('ECONNRESET') || msg.includes('EAI_AGAIN')) return true;

  // Default conservative: retry (but bounded by maxRetries)
  return true;
}

export interface SupabaseMetadataFields {
  source_system: 'rada';
  is_in_supabase: boolean;
  supabase_doc_id: string | null;
}

export function attachSupabaseFields(nreg: string, map: SupabaseNregToIdMap): SupabaseMetadataFields {
  const id = map.get(nreg);
  if (id) {
    return { source_system: 'rada', is_in_supabase: true, supabase_doc_id: id };
  }
  return { source_system: 'rada', is_in_supabase: false, supabase_doc_id: null };
}

async function loadMapFromTable(params: {
  logger: Logger;
  supabase: any;
  cfg: SupabaseSyncConfig;
  table: string;
  nregColumn: string;
  idColumn: string | null;
  idIsNreg: boolean;
}): Promise<SupabaseNregToIdMap> {
  const map: SupabaseNregToIdMap = new Map();
  let offset = 0;

  params.logger.info(
    { table: params.table, nregColumn: params.nregColumn, idColumn: params.idColumn, idIsNreg: params.idIsNreg },
    'loading supabase nreg->id map'
  );

  while (true) {
    const from = offset;
    const to = offset + params.cfg.pageSize - 1;

    const rows = await withRetries({ logger: params.logger, cfg: params.cfg }, async () => {
      const sel = params.idIsNreg ? params.nregColumn : `${params.idColumn},${params.nregColumn}`;
      const { data, error } = await params.supabase.from(params.table).select(sel).range(from, to);
      if (error) throw new Error(`Supabase select failed: ${error.message}`);
      return (data || []) as unknown as Array<Record<string, unknown>>;
    });

    if (rows.length === 0) break;

    for (const r of rows) {
      const nreg = r[params.nregColumn];
      const id = params.idIsNreg ? r[params.nregColumn] : params.idColumn ? r[params.idColumn] : null;
      if (typeof nreg === 'string' && nreg.length > 0) {
        if (typeof id === 'string' && id.length > 0) {
          map.set(nreg, id);
        }
      }
    }

    offset += rows.length;
    if (rows.length < params.cfg.pageSize) break;
  }

  return map;
}

