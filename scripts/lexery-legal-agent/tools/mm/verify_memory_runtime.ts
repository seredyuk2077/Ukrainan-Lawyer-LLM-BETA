/**
 * Runtime verification for memory path: Qdrant LEXERY-LA bootstrap, semantic probe, outbox backlog.
 * Uses production config and production code path (ensureMemoryCollectionPayloadIndexes, searchMemorySemantic, fetchRecentMemory).
 * Output: machine-readable JSON report (no API keys in output).
 *
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/mm/verify_memory_runtime.ts
 */
import { config } from '../../lib/config.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import { checkMmOutboxLeaseSchema, MM_OUTBOX_LEASE_SCHEMA_MISSING, MM_OUTBOX_SCHEMA_CHECK_FAILED } from '../../mm/outboxSchema.js';
import {
  ensureMemoryCollectionPayloadIndexes,
  searchMemorySemantic,
} from '../../mm/semanticSearch.js';
import { fetchRecentMemory } from '../../retrieval/memory-store.js';

/** Valid UUIDs for Supabase uuid columns; same tenant as seed-dev-user. */
const VERIFY_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const VERIFY_USER_ID = '00000000-0000-0000-0000-0000000000fe';

export interface VerifyMemoryRuntimeReport {
  status: 'ok' | 'degraded' | 'fail' | 'skipped';
  /** When true, semantic path was not run (MEMORY_SEMANTIC_ENABLED=false). Do not treat as "semantic validated". */
  semantic_validation_skipped?: boolean;
  /** What was actually validated: 'semantic_disabled' | 'semantic_infra_healthy' | 'semantic_degraded' | 'semantic_fail' */
  validation_summary: string;
  /** Semantic infra only: collection exists, bootstrap, direct search. */
  infra_status?: 'ok' | 'degraded' | 'fail';
  /** Memory fetch path: fetchRecentMemory with valid tenant/user. */
  fetch_status?: 'ok' | 'degraded' | 'fail';
  qdrant_host: string | null;
  collection: string;
  payload_indexes_present?: boolean;
  semantic_enabled: boolean;
  probe_hits_count: number;
  degraded_reason_codes: string[];
  latency_ms: number;
  outbox?: {
    pending: number;
    processing: number;
    done: number;
    failed: number;
    oldest_pending_age_sec: number | null;
    backlog_growth_signal?: string;
  };
  memory_same_as_legislation_warning?: boolean;
  collection_exists?: boolean;
  bootstrap_ok?: boolean;
  /** Processing rows past lease or legacy stale (no lease) older than threshold. Fail if > 0 in live mode. */
  stale_processing_count?: number;
  /** Age in seconds of oldest stale processing row. */
  oldest_stale_processing_age_sec?: number | null;
}

async function getCollectionInfo(): Promise<{ exists: boolean; payload_schema_keys?: string[] }> {
  const base = config.memoryQdrantUrl?.replace(/\/$/, '');
  const apiKey = config.memoryQdrantApiKey;
  const collection = config.memoryQdrantCollection;
  if (!base || !apiKey) return { exists: false };

  const res = await fetch(`${base}/collections/${collection}`, {
    method: 'GET',
    headers: { 'api-key': apiKey },
  });
  if (res.status === 404) return { exists: false };
  if (!res.ok) return { exists: false };

  const data = (await res.json()) as {
    result?: { payload_schema?: Record<string, unknown> };
    payload_schema?: Record<string, unknown>;
  };
  const payloadSchema = data.result?.payload_schema ?? data.payload_schema ?? {};
  const payload_schema_keys = Object.keys(payloadSchema);
  return { exists: true, payload_schema_keys };
}

async function getOutboxMetrics(skipLeaseChecks: boolean): Promise<{
  outbox: VerifyMemoryRuntimeReport['outbox'];
  stale_processing_count: number;
  oldest_stale_processing_age_sec: number | null;
  lease_schema_error?: boolean;
  lease_schema_reason_code?: string;
}> {
  const empty = {
    outbox: undefined as VerifyMemoryRuntimeReport['outbox'],
    stale_processing_count: 0,
    oldest_stale_processing_age_sec: null as number | null,
    lease_schema_error: false,
  };
  try {
    const sb = getSupabaseClient();
    const statuses = ['pending', 'processing', 'done', 'failed'] as const;
    const counts: Record<string, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const status of statuses) {
      const { count, error } = await sb
        .from('mm_outbox')
        .select('*', { count: 'exact', head: true })
        .eq('status', status);
      if (error) return empty;
      counts[status] = count ?? 0;
    }
    let oldest_pending_age_sec: number | null = null;
    const { data: oldest } = await sb
      .from('mm_outbox')
      .select('created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (oldest?.created_at) {
      oldest_pending_age_sec = (Date.now() - new Date(oldest.created_at as string).getTime()) / 1000;
    }
    const outbox: VerifyMemoryRuntimeReport['outbox'] = {
      pending: counts.pending,
      processing: counts.processing,
      done: counts.done,
      failed: counts.failed,
      oldest_pending_age_sec,
    };
    if (skipLeaseChecks) {
      return { outbox, stale_processing_count: 0, oldest_stale_processing_age_sec: null };
    }
    const staleThresholdSec = config.mmOutboxStaleProcessingThresholdSec;
    const nowIso = new Date().toISOString();
    const staleThresholdIso = new Date(Date.now() - staleThresholdSec * 1000).toISOString();
    let stale_processing_count = 0;
    let oldest_stale_processing_age_sec: number | null = null;
    const { data: expired, error: expiredErr } = await sb
      .from('mm_outbox')
      .select('id, created_at, processing_started_at, lease_expires_at')
      .eq('status', 'processing')
      .not('lease_expires_at', 'is', null)
      .lt('lease_expires_at', nowIso);
    if (expiredErr) {
      const code = (expiredErr as { code?: string }).code;
      const msg = (expiredErr as { message?: string }).message ?? '';
      if (code === '42703' || /does not exist/i.test(msg)) {
        return { outbox, stale_processing_count: 0, oldest_stale_processing_age_sec: null, lease_schema_error: true, lease_schema_reason_code: MM_OUTBOX_LEASE_SCHEMA_MISSING };
      }
      return empty;
    }
    const { data: legacyStale, error: legacyErr } = await sb
      .from('mm_outbox')
      .select('id, created_at')
      .eq('status', 'processing')
      .is('lease_expires_at', null)
      .lt('created_at', staleThresholdIso);
    if (legacyErr) {
      const code = (legacyErr as { code?: string }).code;
      const msg = (legacyErr as { message?: string }).message ?? '';
      if (code === '42703' || /does not exist/i.test(msg)) {
        return { outbox, stale_processing_count: 0, oldest_stale_processing_age_sec: null, lease_schema_error: true, lease_schema_reason_code: MM_OUTBOX_LEASE_SCHEMA_MISSING };
      }
      return empty;
    }
    const staleRows = [...(expired ?? []), ...(legacyStale ?? [])];
    stale_processing_count = staleRows.length;
    if (staleRows.length > 0) {
      const oldestCreated = staleRows.reduce((acc, r) => {
        const t = (r as { created_at?: string }).created_at;
        return !t ? acc : Math.min(acc, new Date(t).getTime());
      }, Number.MAX_SAFE_INTEGER);
      if (oldestCreated !== Number.MAX_SAFE_INTEGER) {
        oldest_stale_processing_age_sec = (Date.now() - oldestCreated) / 1000;
      }
    }
    return {
      outbox,
      stale_processing_count,
      oldest_stale_processing_age_sec,
    };
  } catch {
    return empty;
  }
}

export async function runVerifyMemoryRuntime(): Promise<VerifyMemoryRuntimeReport> {
  const t0 = Date.now();
  const degradedReasons: string[] = [];
  let probe_hits_count = 0;
  let payload_indexes_present = false;
  let collection_exists = false;
  let bootstrap_ok = false;

  const schemaCheck = await checkMmOutboxLeaseSchema();
  const outboxSchemaMissing = !schemaCheck.ready;
  if (outboxSchemaMissing) {
    degradedReasons.push(schemaCheck.reason_code ?? MM_OUTBOX_SCHEMA_CHECK_FAILED);
  }

  const semantic_enabled = config.memorySemanticEnabled;
  const qdrant_host = config.memoryQdrantUrl
    ? new URL(config.memoryQdrantUrl).origin
    : null;

  const memorySameAsLegislation =
    semantic_enabled &&
    !!config.memoryQdrantUrl &&
    !!config.qdrantUrl &&
    config.memoryQdrantUrl.replace(/\/$/, '') === config.qdrantUrl.replace(/\/$/, '') &&
    !config.memoryQdrantAllowLegislationFallback;

  if (memorySameAsLegislation) {
    degradedReasons.push('MEMORY_SAME_AS_LEGISLATION_CLUSTER');
  }

  if (!semantic_enabled) {
    const metrics = await getOutboxMetrics(outboxSchemaMissing);
    if (metrics.lease_schema_error) {
      const code = metrics.lease_schema_reason_code ?? MM_OUTBOX_SCHEMA_CHECK_FAILED;
      if (!degradedReasons.includes(code)) degradedReasons.push(code);
    }
    const latency_ms = Date.now() - t0;
    const status: 'ok' | 'degraded' | 'fail' | 'skipped' = outboxSchemaMissing || metrics.lease_schema_error ? 'fail' : 'skipped';
    return {
      status,
      semantic_validation_skipped: true,
      validation_summary: status === 'fail' ? 'semantic_fail' : 'semantic_disabled',
      qdrant_host,
      collection: config.memoryQdrantCollection,
      payload_indexes_present: undefined,
      semantic_enabled: false,
      probe_hits_count: 0,
      degraded_reason_codes: [...degradedReasons],
      latency_ms,
      outbox: metrics.outbox,
      stale_processing_count: metrics.stale_processing_count,
      oldest_stale_processing_age_sec: metrics.oldest_stale_processing_age_sec,
      memory_same_as_legislation_warning: memorySameAsLegislation || undefined,
      collection_exists: undefined,
      bootstrap_ok: undefined,
    };
  }

  if (!config.memoryQdrantUrl || !config.memoryQdrantApiKey) {
    degradedReasons.push('QDRANT_MEMORY_NOT_CONFIGURED');
    const metrics = await getOutboxMetrics(outboxSchemaMissing);
    if (metrics.lease_schema_error) {
      const code = metrics.lease_schema_reason_code ?? MM_OUTBOX_SCHEMA_CHECK_FAILED;
      if (!degradedReasons.includes(code)) degradedReasons.push(code);
    }
    const failStatus = outboxSchemaMissing || metrics.lease_schema_error;
    return {
      status: failStatus ? 'fail' : 'degraded',
      validation_summary: 'semantic_fail',
      qdrant_host,
      collection: config.memoryQdrantCollection,
      payload_indexes_present: false,
      semantic_enabled: true,
      probe_hits_count: 0,
      degraded_reason_codes: degradedReasons,
      latency_ms: Date.now() - t0,
      outbox: metrics.outbox,
      stale_processing_count: metrics.stale_processing_count,
      oldest_stale_processing_age_sec: metrics.oldest_stale_processing_age_sec,
      memory_same_as_legislation_warning: memorySameAsLegislation || undefined,
      collection_exists: false,
      bootstrap_ok: false,
    };
  }

  const collInfoBefore = await getCollectionInfo();
  collection_exists = collInfoBefore.exists;
  if (!collInfoBefore.exists) {
    degradedReasons.push('COLLECTION_MISSING');
  }

  const bootstrap = await ensureMemoryCollectionPayloadIndexes();
  bootstrap_ok = bootstrap.ok;

  // Refresh collection info after bootstrap so we report current payload schema
  const collInfo = bootstrap.ok ? await getCollectionInfo() : collInfoBefore;
  const requiredPayloadFields = ['user_id', 'tenant_id', 'conversation_id'];
  const schemaHasRequired =
    !collInfo.payload_schema_keys ||
    requiredPayloadFields.every((f) => collInfo.payload_schema_keys!.includes(f));
  if (!bootstrap.ok) {
    degradedReasons.push(bootstrap.reason_code ?? 'BOOTSTRAP_FAILED');
  } else {
    payload_indexes_present = schemaHasRequired;
    if (!schemaHasRequired && collInfo.payload_schema_keys) {
      degradedReasons.push('PAYLOAD_SCHEMA_MISSING_FIELDS');
    }
  }

  // Semantic infra probe (collection, bootstrap, direct search) — valid UUID required for Supabase
  const semanticResult = await searchMemorySemantic({
    queryText: 'test memory verification probe',
    tenantId: VERIFY_TENANT_ID,
    userId: VERIFY_USER_ID,
    topK: 3,
  });
  probe_hits_count = semanticResult.hits.length;
  const infra_status: 'ok' | 'degraded' | 'fail' =
    !collection_exists || !bootstrap_ok
      ? 'fail'
      : semanticResult.degraded
        ? 'degraded'
        : 'ok';
  if (semanticResult.degraded) {
    degradedReasons.push('SEMANTIC_PROBE_DEGRADED');
  }

  // Memory fetch probe (fetchRecentMemory uses tenant_id/user_id in DB; valid UUID required)
  const fetchResult = await fetchRecentMemory({
    tenantId: VERIFY_TENANT_ID,
    userId: VERIFY_USER_ID,
    queryText: 'test memory verification probe',
  });
  const fetch_status: 'ok' | 'degraded' | 'fail' = fetchResult.degraded ? 'degraded' : 'ok';
  if (fetchResult.degraded && fetchResult.degraded_reason_codes?.length) {
    for (const code of fetchResult.degraded_reason_codes) {
      if (!degradedReasons.includes(code)) degradedReasons.push(code);
    }
  }

  const metrics = await getOutboxMetrics(outboxSchemaMissing);
  if (metrics.lease_schema_error) {
    const code = metrics.lease_schema_reason_code ?? MM_OUTBOX_SCHEMA_CHECK_FAILED;
    if (!degradedReasons.includes(code)) degradedReasons.push(code);
  }
  if (metrics.stale_processing_count > 0) {
    degradedReasons.push('STALE_PROCESSING_OUTBOX');
  }

  const latency_ms = Date.now() - t0;
  const hasCritical = degradedReasons.some((c) =>
    ['COLLECTION_MISSING', 'QDRANT_MEMORY_NOT_CONFIGURED', 'BOOTSTRAP_ERROR', 'INDEX_CREATE_FAILED', 'SUPABASE_QUERY_ERROR', 'STALE_PROCESSING_OUTBOX', MM_OUTBOX_LEASE_SCHEMA_MISSING, MM_OUTBOX_SCHEMA_CHECK_FAILED].includes(c)
  );
  const status: 'ok' | 'degraded' | 'fail' =
    outboxSchemaMissing || metrics.lease_schema_error
      ? 'fail'
      : hasCritical && !semanticResult.hits.length
        ? 'fail'
        : degradedReasons.length > 0
          ? 'degraded'
          : 'ok';
  const validation_summary: string =
    status === 'ok'
      ? 'semantic_infra_healthy'
      : status === 'fail'
        ? 'semantic_fail'
        : 'semantic_degraded';

  return {
    status: metrics.stale_processing_count > 0 ? 'fail' : status,
    validation_summary: metrics.stale_processing_count > 0 ? 'semantic_fail' : validation_summary,
    infra_status,
    fetch_status,
    qdrant_host,
    collection: config.memoryQdrantCollection,
    payload_indexes_present,
    semantic_enabled: true,
    probe_hits_count,
    degraded_reason_codes: degradedReasons,
    latency_ms,
    outbox: metrics.outbox,
    stale_processing_count: metrics.stale_processing_count,
    oldest_stale_processing_age_sec: metrics.oldest_stale_processing_age_sec,
    memory_same_as_legislation_warning: memorySameAsLegislation || undefined,
    collection_exists,
    bootstrap_ok,
  };
}

async function main(): Promise<void> {
  const report = await runVerifyMemoryRuntime();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === 'fail' ? 1 : 0);
}

export function isVerifyUserIdValid(): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(VERIFY_USER_ID) && uuidRegex.test(VERIFY_TENANT_ID);
}

const entryScript = process.argv[1] ?? '';
const isVerifierEntry = /verify_memory_runtime\.(ts|js)$/.test(entryScript.replace(/\\/g, '/')) && !/test_/.test(entryScript);
if (isVerifierEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
