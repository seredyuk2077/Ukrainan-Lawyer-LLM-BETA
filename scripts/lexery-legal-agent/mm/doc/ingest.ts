import { createHash } from 'crypto';
import { chunkParsedDocument } from './chunking.js';
import { parseMmDocument } from './parse.js';
import { putMmDocCanonical, getMmDocCanonical, getMmDocRaw } from './r2.js';
import {
  createMmDocRecord,
  findMmDocRecordByRawR2Key,
  logMmDocEvent,
  type MmDocRecordRow,
  updateMmDocRecord,
} from './store.js';
import { upsertMmDocChunks } from './qdrant.js';
import { resolveMmDocScope } from './formats.js';
import type { MmDocCanonical, MmDocScope, MmDocSourceKind } from './types.js';
import { config } from '../../lib/config.js';

function textLooksLikeCorruptedMojibake(text: string | null | undefined): boolean {
  if (!text) return false;
  const hasClassicMojibake = /[ÐÑÃ]{2,}/.test(text);
  const hasDashSoup = /[—–±]{3,}/.test(text);
  const hasCyrillic = /[\u0400-\u04FF]/.test(text);
  return (hasClassicMojibake || hasDashSoup) && !hasCyrillic;
}

async function shouldRepairIndexedMmDocRecord(record: MmDocRecordRow): Promise<boolean> {
  if (!record.canonical_r2_key || record.status !== 'indexed' || !record.chunk_count || record.chunk_count <= 0) {
    return false;
  }
  try {
    const canonical = await getMmDocCanonical(record.canonical_r2_key);
    const sampleTexts = [
      canonical.content.blocks[0]?.text,
      canonical.content.chunks[0]?.text,
    ];
    return sampleTexts.some((text) => textLooksLikeCorruptedMojibake(text));
  } catch {
    return true;
  }
}

function getScopeFromRecord(record: MmDocRecordRow): MmDocScope {
  return {
    type: record.scope_type,
    id: record.scope_id,
  };
}

async function indexMmDocRecord(params: {
  record: MmDocRecordRow;
  runId?: string | null;
  rawBuffer?: Buffer;
}): Promise<{ docId: string; canonicalR2Key: string; chunkCount: number }> {
  const startedAt = Date.now();
  const rawBuffer = params.rawBuffer ?? (await getMmDocRaw(params.record.raw_r2_key));
  if (rawBuffer.length > config.mmDocsRawMaxBytes) {
    throw new Error(
      `MM Docs raw object too large: ${rawBuffer.length} > ${config.mmDocsRawMaxBytes}`
    );
  }

  const scope = getScopeFromRecord(params.record);
  const parseStartedAt = Date.now();
  const parsed = await parseMmDocument({
    buffer: rawBuffer,
    filename: params.record.original_filename,
    contentType: params.record.content_type,
  });
  const parseDurationMs = Date.now() - parseStartedAt;
  const chunkStartedAt = Date.now();
  const chunks = chunkParsedDocument(parsed.blocks);
  const chunkDurationMs = Date.now() - chunkStartedAt;
  if (chunks.length === 0) {
    throw new Error('MM Docs parse produced no indexable chunks');
  }

  const canonical: MmDocCanonical = {
    version: 1,
    doc_id: params.record.id,
    tenant_id: params.record.tenant_id,
    user_id: params.record.user_id,
    project_id: params.record.project_id,
    conversation_id: params.record.conversation_id,
    scope,
    source_kind: params.record.source_kind as MmDocSourceKind,
    source_run_id: params.record.source_run_id,
    original_filename: params.record.original_filename,
    content_type: params.record.content_type ?? undefined,
    content_sha256: params.record.content_sha256,
    parser: {
      format: parsed.format,
      warnings: parsed.warnings,
    },
    stats: {
      block_count: parsed.blocks.length,
      chunk_count: chunks.length,
      plain_text_chars: parsed.plainText.length,
    },
    content: {
      blocks: parsed.blocks,
      chunks,
    },
  };

  const canonicalStartedAt = Date.now();
  const { r2Key } = await putMmDocCanonical({
    tenantId: params.record.tenant_id,
    userId: params.record.user_id,
    scopeType: scope.type,
    scopeId: scope.id,
    docId: params.record.id,
    canonical,
  });
  const canonicalDurationMs = Date.now() - canonicalStartedAt;

  const qdrantStartedAt = Date.now();
  await upsertMmDocChunks({
    docId: params.record.id,
    tenantId: params.record.tenant_id,
    userId: params.record.user_id,
    projectId: params.record.project_id,
    conversationId: params.record.conversation_id,
    scopeType: scope.type,
    scopeId: scope.id,
    filename: params.record.original_filename,
    title: parsed.title,
    contentType: params.record.content_type ?? undefined,
    canonicalR2Key: r2Key,
    chunks,
  });
  const qdrantDurationMs = Date.now() - qdrantStartedAt;

  const persistStartedAt = Date.now();
  await updateMmDocRecord(params.record.id, {
    canonical_r2_key: r2Key,
    parser_format: parsed.format,
    parser_warnings: parsed.warnings,
    chunk_count: chunks.length,
    status: 'indexed',
    error_message: null,
  });
  const persistDurationMs = Date.now() - persistStartedAt;
  await logMmDocEvent({
    docId: params.record.id,
    tenantId: params.record.tenant_id,
    userId: params.record.user_id,
    runId: params.runId ?? params.record.source_run_id ?? null,
    stage: 'indexed',
    status: 'ok',
    metrics: {
      chunk_count: chunks.length,
      canonical_r2_key: r2Key,
      parser_format: parsed.format,
      parser_engine: parsed.metadata.parser_engine ?? null,
      parser_warnings: parsed.warnings,
      image_count: parsed.metadata.image_count ?? 0,
      page_count: parsed.metadata.page_count ?? null,
      ocr_page_count: parsed.metadata.ocr_page_count ?? 0,
      section_count: parsed.metadata.section_count ?? 0,
      vision_model: parsed.metadata.vision_model ?? null,
      parse_ms: parseDurationMs,
      chunk_ms: chunkDurationMs,
      canonical_r2_write_ms: canonicalDurationMs,
      qdrant_upsert_ms: qdrantDurationMs,
      persist_ms: persistDurationMs,
      total_index_ms: Date.now() - startedAt,
    },
  });
  return { docId: params.record.id, canonicalR2Key: r2Key, chunkCount: chunks.length };
}

export async function ingestMmDocFromRawR2(params: {
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
  requestedScope?: string | null;
  runId?: string | null;
  sourceKind?: MmDocSourceKind;
  rawR2Key: string;
  filename: string;
  contentType?: string | null;
}): Promise<{ docId: string; canonicalR2Key: string; chunkCount: number }> {
  const scope = resolveMmDocScope({
    requestedScope: params.requestedScope,
    projectId: params.projectId,
    conversationId: params.conversationId,
  });
  const existing = await findMmDocRecordByRawR2Key({
    tenantId: params.tenantId,
    userId: params.userId,
    rawR2Key: params.rawR2Key,
  });
  if (
    existing?.status === 'indexed' &&
    existing.canonical_r2_key &&
    typeof existing.chunk_count === 'number' &&
    existing.chunk_count > 0
  ) {
    if (await shouldRepairIndexedMmDocRecord(existing)) {
      await logMmDocEvent({
        docId: existing.id,
        tenantId: params.tenantId,
        userId: params.userId,
        runId: params.runId ?? null,
        stage: 'ingest_repair_reused',
        status: 'warn',
        message: 'Detected corrupted/stale canonical payload, reindexing existing MM Docs record',
        metrics: { raw_r2_key: params.rawR2Key, canonical_r2_key: existing.canonical_r2_key },
      });
      return await repairMmDocRecord({
        record: existing,
        runId: params.runId ?? null,
      });
    }
    await logMmDocEvent({
      docId: existing.id,
      tenantId: params.tenantId,
      userId: params.userId,
      runId: params.runId ?? null,
      stage: 'ingest_reused',
      status: 'ok',
      metrics: { raw_r2_key: params.rawR2Key, canonical_r2_key: existing.canonical_r2_key },
    });
    return {
      docId: existing.id,
      canonicalR2Key: existing.canonical_r2_key,
      chunkCount: existing.chunk_count,
    };
  }
  const rawBuffer = await getMmDocRaw(params.rawR2Key);
  if (rawBuffer.length > config.mmDocsRawMaxBytes) {
    throw new Error(
      `MM Docs raw object too large: ${rawBuffer.length} > ${config.mmDocsRawMaxBytes}`
    );
  }
  const sha256 = createHash('sha256').update(rawBuffer).digest('hex');

  const record = await createMmDocRecord({
    tenant_id: params.tenantId,
    user_id: params.userId,
    project_id: params.projectId ?? null,
    conversation_id: params.conversationId ?? null,
    scope,
    source_kind: params.sourceKind ?? 'chat_attachment',
    source_run_id: params.runId ?? null,
    original_filename: params.filename,
    content_type: params.contentType ?? undefined,
    content_sha256: sha256,
    raw_r2_key: params.rawR2Key,
    status: 'ingesting',
  });

  await logMmDocEvent({
    docId: record.id,
    tenantId: params.tenantId,
    userId: params.userId,
    runId: params.runId ?? null,
    stage: 'ingest_started',
    status: 'ok',
    metrics: { raw_r2_key: params.rawR2Key, scope_type: scope.type },
  });

  try {
    return await indexMmDocRecord({
      record,
      runId: params.runId ?? null,
      rawBuffer,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateMmDocRecord(record.id, {
      status: 'failed',
      error_message: msg,
    });
    await logMmDocEvent({
      docId: record.id,
      tenantId: params.tenantId,
      userId: params.userId,
      runId: params.runId ?? null,
      stage: 'failed',
      status: 'error',
      message: msg,
    });
    throw err;
  }
}

export async function repairMmDocRecord(params: {
  record: MmDocRecordRow;
  runId?: string | null;
}): Promise<{ docId: string; canonicalR2Key: string; chunkCount: number }> {
  await updateMmDocRecord(params.record.id, {
    status: 'ingesting',
    error_message: null,
  });
  await logMmDocEvent({
    docId: params.record.id,
    tenantId: params.record.tenant_id,
    userId: params.record.user_id,
    runId: params.runId ?? params.record.source_run_id ?? null,
    stage: 'repair_started',
    status: 'ok',
    metrics: { raw_r2_key: params.record.raw_r2_key, previous_status: params.record.status },
  });

  try {
    return await indexMmDocRecord({
      record: params.record,
      runId: params.runId ?? params.record.source_run_id ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateMmDocRecord(params.record.id, {
      status: 'failed',
      error_message: msg,
    });
    await logMmDocEvent({
      docId: params.record.id,
      tenantId: params.record.tenant_id,
      userId: params.record.user_id,
      runId: params.runId ?? params.record.source_run_id ?? null,
      stage: 'repair_failed',
      status: 'error',
      message: msg,
    });
    throw err;
  }
}
