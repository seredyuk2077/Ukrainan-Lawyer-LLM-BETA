#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'child_process';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

process.env.MM_DOCS_ENABLED ??= 'true';

function normalizeEndpoint(value: string | undefined | null): string {
  return (value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function approxJsonSize(value: unknown): number {
  if (value == null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

function isUrlLikeKey(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function hasBinary(name: string): boolean {
  return spawnSync('which', [name], { encoding: 'utf8' }).status === 0;
}

const MAX_MM_DOC_ROW_JSON_BYTES = 4_096;
const MAX_MM_DOC_LOG_ROW_JSON_BYTES = 4_096;

async function main(): Promise<void> {
  const { config } = await import('../../lib/config.js');
  const {
    isMmDocCanonicalKeyForRecord,
    isMmDocRawKeyForIdentity,
    isRunsAttachmentKeyForTenant,
  } = await import('../../lib/r2-keys.js');
  const { ensureMmDocTablesReady } = await import('../../mm/doc/store.js');
  const { ensureMmDocsCollection } = await import('../../mm/doc/qdrant.js');
  const { putMmDocRaw, getMmDocRaw } = await import('../../mm/doc/r2.js');
  const memoryQdrantEndpoint = normalizeEndpoint(
    process.env.QDRANT_MEMORY_URL ||
      process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA ||
      process.env.qdrant_clusterENDPOINT_LEXERY_LA ||
      process.env.Qdrant_clusterENDPOINT_LEXERY_LA ||
      ''
  );
  const docsQdrantEndpoint = normalizeEndpoint(config.mmDocsQdrantUrl);
  const dedicatedQdrantConfigured = Boolean(
    process.env.MM_DOCS_QDRANT_URL ||
      process.env.QDRANT_DOCS_URL ||
      process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA_DOCS
  );
  const qdrantSharedWithMemory = Boolean(docsQdrantEndpoint && memoryQdrantEndpoint && docsQdrantEndpoint === memoryQdrantEndpoint);

  const report: Record<string, unknown> = {
    mmDocsEnabled: config.mmDocsEnabled,
    bucket: config.mmDocsBucket,
    qdrantCollection: config.mmDocsQdrantCollection,
    dedicatedQdrantConfigured,
    qdrantSharedWithMemory,
    qdrantEndpointConfigured: Boolean(config.mmDocsQdrantUrl && config.mmDocsQdrantApiKey),
    supabaseTablesReady: false,
    qdrantReady: false,
    r2Ready: false,
    securityChecks: {
      publicReadBlocked: false,
    },
    parserCapabilities: {},
    storageShape: {
      mm_doc_records_rows: 0,
      mm_doc_ingest_log_rows: 0,
    },
  };
  const errors: string[] = [];

  if (!config.mmDocsEnabled) {
    throw new Error('MM Docs is disabled by config');
  }

  const parserCapabilities = {
    office_converter_soffice: hasBinary('soffice') || hasBinary('libreoffice'),
    office_converter_textutil: hasBinary('textutil'),
    legacy_word_doc_supported: hasBinary('soffice') || hasBinary('libreoffice') || hasBinary('textutil'),
    legacy_rtf_supported: hasBinary('soffice') || hasBinary('libreoffice') || hasBinary('textutil'),
    legacy_spreadsheet_xls_supported: true,
    pdf_text: hasBinary('pdftotext'),
    pdf_image_count: hasBinary('pdfimages'),
    pdf_rasterize: hasBinary('pdftoppm'),
    image_vision_enabled: config.mmDocsVisionEnabled,
    pdf_vision_enabled: config.mmDocsVisionEnabled && config.mmDocsPdfVisionOcrEnabled,
  };
  report.parserCapabilities = parserCapabilities;
  if (!parserCapabilities.office_converter_soffice && !parserCapabilities.office_converter_textutil) {
    errors.push('MM Docs legacy office parsing has no converter available (expected soffice/libreoffice or textutil)');
  }
  if (!parserCapabilities.pdf_text) {
    errors.push('MM Docs PDF text extraction binary is unavailable (pdftotext missing)');
  }

  if (!config.mmDocsQdrantUrl || !config.mmDocsQdrantApiKey) {
    errors.push(
      'MM Docs Qdrant endpoint/API key is not configured. Set MM_DOCS_QDRANT_URL/MM_DOCS_QDRANT_API_KEY or rely on the shared Lexery-LA memory-cluster env vars.'
    );
  }

  try {
    await ensureMmDocTablesReady();
    report.supabaseTablesReady = true;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    const anonKey =
      process.env.SUPABASE_LEXERY_LEGAL_AGENT_DB_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      '';
    if (!config.supabaseUrl || !config.supabaseServiceKey || !anonKey) {
      throw new Error('SUPABASE_LEXERY_LEGAL_AGENT_DB_URL, SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY and anon key are required');
    }
    const service = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false },
    });
    const anon = createClient(config.supabaseUrl, anonKey, {
      auth: { persistSession: false },
    });

    const [{ data: records, error: recordsError }, { data: logs, error: logsError }] = await Promise.all([
      service.from('mm_doc_records').select('*'),
      service.from('mm_doc_ingest_log').select('*'),
    ]);
    if (recordsError) throw new Error(`mm_doc_records service query failed: ${recordsError.message}`);
    if (logsError) throw new Error(`mm_doc_ingest_log service query failed: ${logsError.message}`);

    const recordRows = records ?? [];
    const logRows = logs ?? [];
    const scopeViolations = {
      conversation: recordRows.filter(
        (row: Record<string, unknown>) =>
          row.scope_type === 'conversation' &&
          (!row.conversation_id || row.scope_id !== row.conversation_id)
      ).length,
      project: recordRows.filter(
        (row: Record<string, unknown>) =>
          row.scope_type === 'project' && (!row.project_id || row.scope_id !== row.project_id)
      ).length,
      user_global: recordRows.filter(
        (row: Record<string, unknown>) => row.scope_type === 'user_global' && row.scope_id !== null
      ).length,
    };
    const keyShape = {
      raw_url_like_keys: recordRows.filter((row: Record<string, unknown>) => isUrlLikeKey(row.raw_r2_key)).length,
      canonical_url_like_keys: recordRows.filter((row: Record<string, unknown>) => isUrlLikeKey(row.canonical_r2_key)).length,
      raw_bad_namespace_keys: recordRows.filter((row: Record<string, unknown>) => {
        const rawKey = typeof row.raw_r2_key === 'string' ? row.raw_r2_key : '';
        const tenantId = typeof row.tenant_id === 'string' ? row.tenant_id : null;
        const userId = typeof row.user_id === 'string' ? row.user_id : '';
        return !(
          isRunsAttachmentKeyForTenant({ tenantId, r2Key: rawKey }) ||
          isMmDocRawKeyForIdentity({ tenantId, userId, r2Key: rawKey })
        );
      }).length,
      canonical_bad_namespace_keys: recordRows.filter((row: Record<string, unknown>) => {
        if (typeof row.canonical_r2_key !== 'string' || row.canonical_r2_key.length === 0) return false;
        if (typeof row.user_id !== 'string' || typeof row.id !== 'string' || typeof row.scope_type !== 'string') return true;
        return !isMmDocCanonicalKeyForRecord({
          tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
          userId: row.user_id,
          scopeType: row.scope_type as 'conversation' | 'project' | 'user_global',
          scopeId: typeof row.scope_id === 'string' ? row.scope_id : null,
          docId: row.id,
          r2Key: row.canonical_r2_key,
        });
      }).length,
      indexed_missing_canonical: recordRows.filter(
        (row: Record<string, unknown>) => row.status === 'indexed' && !row.canonical_r2_key
      ).length,
      indexed_bad_chunk_count: recordRows.filter((row: Record<string, unknown>) => {
        if (row.status !== 'indexed') return false;
        const chunkCount = Number(row.chunk_count ?? 0);
        return !(chunkCount > 0);
      }).length,
    };
    report.storageShape = {
      mm_doc_records_rows: recordRows.length,
      mm_doc_ingest_log_rows: logRows.length,
      ingest_log_retention_policy: {
        retention_days: config.mmDocsIngestLogRetentionDays,
        max_rows: config.mmDocsIngestLogMaxRows,
        prune_batch: config.mmDocsIngestLogPruneBatch,
        prune_cooldown_ms: config.mmDocsIngestLogPruneCooldownMs,
      },
      max_mm_doc_record_json_bytes: Math.max(0, ...recordRows.map((row) => approxJsonSize(row))),
      max_mm_doc_ingest_log_json_bytes: Math.max(0, ...logRows.map((row) => approxJsonSize(row))),
      max_error_message_length: Math.max(0, ...recordRows.map((row: Record<string, unknown>) => String(row.error_message ?? '').length)),
      max_parser_warnings_json_length: Math.max(0, ...recordRows.map((row) => approxJsonSize((row as Record<string, unknown>).parser_warnings))),
      max_log_message_length: Math.max(0, ...logRows.map((row: Record<string, unknown>) => String(row.message ?? '').length)),
      max_log_metrics_json_length: Math.max(0, ...logRows.map((row) => approxJsonSize((row as Record<string, unknown>).metrics))),
      scope_invariants: scopeViolations,
      key_shape: keyShape,
    };

    if ((report.storageShape as Record<string, unknown>).max_mm_doc_record_json_bytes as number > MAX_MM_DOC_ROW_JSON_BYTES) {
      errors.push(`MM Docs record row JSON exceeds budget (${MAX_MM_DOC_ROW_JSON_BYTES} bytes)`);
    }
    if ((report.storageShape as Record<string, unknown>).max_mm_doc_ingest_log_json_bytes as number > MAX_MM_DOC_LOG_ROW_JSON_BYTES) {
      errors.push(`MM Docs ingest-log row JSON exceeds budget (${MAX_MM_DOC_LOG_ROW_JSON_BYTES} bytes)`);
    }
    if (Object.values(scopeViolations).some((count) => count > 0)) {
      errors.push(`MM Docs scope invariants violated: ${JSON.stringify(scopeViolations)}`);
    }
    if (Object.values(keyShape).some((count) => count > 0)) {
      errors.push(`MM Docs key/indexed shape invariants violated: ${JSON.stringify(keyShape)}`);
    }

    const [anonRecordsProbe, anonLogsProbe] = await Promise.all([
      anon.from('mm_doc_records').select('id').limit(1),
      anon.from('mm_doc_ingest_log').select('id').limit(1),
    ]);
    const anonReadsBlocked =
      !anonRecordsProbe.error &&
      !anonLogsProbe.error &&
      (anonRecordsProbe.data?.length ?? 0) === 0 &&
      (anonLogsProbe.data?.length ?? 0) === 0;
    report.securityChecks = {
      publicReadBlocked: anonReadsBlocked,
      mm_doc_records_anon_status: anonRecordsProbe.status,
      mm_doc_ingest_log_anon_status: anonLogsProbe.status,
      mm_doc_records_anon_rows: anonRecordsProbe.data?.length ?? 0,
      mm_doc_ingest_log_anon_rows: anonLogsProbe.data?.length ?? 0,
    };
    if (!anonReadsBlocked) {
      errors.push('MM Docs public/anon read probe returned visible rows. RLS/privilege isolation is not strict enough.');
    }
  } catch (err) {
    errors.push(`Supabase MM Docs security/size audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await ensureMmDocsCollection();
    report.qdrantReady = true;
  } catch (err) {
    errors.push(`Qdrant readiness failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const probe = Buffer.from('mm-docs-readiness-probe', 'utf8');
    const probeId = randomUUID();
    const { r2Key } = await putMmDocRaw({
      tenantId: 'mm-docs-readiness',
      userId: 'probe-user',
      docId: probeId,
      filename: 'probe.txt',
      contentType: 'text/plain',
      buffer: probe,
    });
    const roundTrip = await getMmDocRaw(r2Key);
    if (roundTrip.toString('utf8') !== probe.toString('utf8')) {
      throw new Error('R2 round-trip mismatch for MM Docs readiness probe');
    }
    if (!/\/mm\/docs\/user\/[^/]+\/raw\//.test(r2Key)) {
      throw new Error(`MM Docs probe key shape is invalid: ${r2Key}`);
    }
    report.r2Ready = true;
    report.r2ProbeKey = r2Key;
  } catch (err) {
    errors.push(`R2 readiness failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  report.errors = errors;
  if (errors.length > 0) {
    console.error('MM Docs readiness: FAIL');
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  console.log('MM Docs readiness: PASS');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('MM Docs readiness: FAIL');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
