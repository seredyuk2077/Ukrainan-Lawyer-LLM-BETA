/**
 * MM outbox lease schema readiness — single source of truth for required lease columns.
 * Used by verify_memory_runtime and outboxWorker to fail closed when migration is not applied.
 * Reason codes: MM_OUTBOX_LEASE_SCHEMA_MISSING only for missing-column (e.g. 42703); generic failures use MM_OUTBOX_SCHEMA_CHECK_FAILED.
 */
import { getSupabaseClient } from '../lib/supabase.js';

export const MM_OUTBOX_LEASE_SCHEMA_MISSING = 'MM_OUTBOX_LEASE_SCHEMA_MISSING';
export const MM_OUTBOX_SCHEMA_CHECK_FAILED = 'MM_OUTBOX_SCHEMA_CHECK_FAILED';

export type OutboxSchemaReasonCode = typeof MM_OUTBOX_LEASE_SCHEMA_MISSING | typeof MM_OUTBOX_SCHEMA_CHECK_FAILED;

const REQUIRED_LEASE_COLUMNS = [
  'processing_started_at',
  'lease_expires_at',
  'attempt_count',
  'last_error',
  'worker_id',
] as const;

const SCHEMA_SUCCESS_CACHE_TTL_MS = 5 * 60 * 1000;
let lastSchemaSuccessAtMs = 0;

export interface OutboxLeaseSchemaResult {
  ready: boolean;
  reason_code?: OutboxSchemaReasonCode;
  error_message?: string;
  /** When reason is MM_OUTBOX_LEASE_SCHEMA_MISSING, which columns were missing (if detectable). */
  missing_columns?: string[];
}

function isMissingColumnError(code: string | undefined, message: string): boolean {
  return code === '42703' || /does not exist|column .* does not exist|undefined_column/i.test(message);
}

export function isTransientOutboxSchemaProbeError(message: string): boolean {
  return /fetch failed|bad gateway|error code 502|error code 503|error code 504|cloudflare|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|network/i.test(
    message
  );
}

function hasFreshSchemaSuccessCache(): boolean {
  return lastSchemaSuccessAtMs > 0 && Date.now() - lastSchemaSuccessAtMs < SCHEMA_SUCCESS_CACHE_TTL_MS;
}

/**
 * Probe mm_outbox for presence of required lease columns.
 * MM_OUTBOX_LEASE_SCHEMA_MISSING: only when Postgres returns 42703 or message indicates missing column.
 * MM_OUTBOX_SCHEMA_CHECK_FAILED: auth, network, or other query failure.
 */
export async function checkMmOutboxLeaseSchema(): Promise<OutboxLeaseSchemaResult> {
  const sb = getSupabaseClient();
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { error } = await sb
        .from('mm_outbox')
        .select(`id, ${REQUIRED_LEASE_COLUMNS.join(', ')}`)
        .limit(1)
        .maybeSingle();
      if (!error) {
        lastSchemaSuccessAtMs = Date.now();
        return { ready: true };
      }
      const code = (error as { code?: string }).code;
      const message = (error as { message?: string }).message ?? (error as Error).message ?? '';
      if (isMissingColumnError(code, message)) {
        return {
          ready: false,
          reason_code: MM_OUTBOX_LEASE_SCHEMA_MISSING,
          error_message: message,
          missing_columns: REQUIRED_LEASE_COLUMNS as unknown as string[],
        };
      }
      const isTransient = isTransientOutboxSchemaProbeError(message);
      if (isTransient && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
      if (isTransient && hasFreshSchemaSuccessCache()) {
        return { ready: true };
      }
      return {
        ready: false,
        reason_code: MM_OUTBOX_SCHEMA_CHECK_FAILED,
        error_message: message,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMissingColumnError(undefined, msg)) {
        return {
          ready: false,
          reason_code: MM_OUTBOX_LEASE_SCHEMA_MISSING,
          error_message: msg,
          missing_columns: REQUIRED_LEASE_COLUMNS as unknown as string[],
        };
      }
      const isTransient = isTransientOutboxSchemaProbeError(msg);
      if (isTransient && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
      if (isTransient && hasFreshSchemaSuccessCache()) {
        return { ready: true };
      }
      return {
        ready: false,
        reason_code: MM_OUTBOX_SCHEMA_CHECK_FAILED,
        error_message: msg,
      };
    }
  }
  return {
    ready: false,
    reason_code: MM_OUTBOX_SCHEMA_CHECK_FAILED,
    error_message: 'mm_outbox schema probe exhausted retries',
  };
}
