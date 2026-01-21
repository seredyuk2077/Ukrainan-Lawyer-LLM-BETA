import fsp from 'node:fs/promises';
import type { Logger } from 'pino';
import { getDefaults, type CliCommonOptions, type EnvConfig, type ImporterPaths } from './config.js';
import { OpenRouterEmbeddingProvider } from './embeddingProvider.js';
import { parseDocTsvLine } from './parser.js';
import { normalizeRow } from './normalizers.js';
import { Heartbeat } from './logger.js';
import {
  appendInsertedIdEntries,
  assertFingerprintMatch,
  computeFingerprint,
  createNewState,
  loadState,
  logError,
  resetLocalArtifacts,
  saveState,
  type ImportState,
} from './state.js';
import { readLocalDocLines } from './source.js';
import { attachSupabaseFields, defaultSupabaseSyncConfig, loadSupabaseNregMap } from './supabaseSync.js';
import { QdrantVectorDbClient, getQdrantConnectionFromEnv } from './qdrantClient.js';
import { nregToUuid } from './qdrantIds.js';
import { estimateEtaSeconds, formatSeconds, nowIso } from './utils.js';

export interface RunReport {
  kind: 'run_report';
  mode: 'import' | 'resume' | 'test';
  indexName: string;
  started_at: string;
  stopped_at: string;
  counters: {
    processed: number;
    upserted: number;
    failed: number;
    skipped: number;
    batches: number;
  };
  cursor: { lineNumber: number };
  test_run_id?: string;
  notes?: string[];
}

export interface ImportRunParams {
  mode: 'import' | 'resume' | 'test';
  options: CliCommonOptions;
  paths: ImporterPaths;
  env: EnvConfig;
  logger: Logger;
  testRunId?: string;
  trackInsertedIds?: boolean;
}

export async function runImport(params: ImportRunParams): Promise<RunReport> {
  const defaults = getDefaults();
  const startedAt = nowIso();
  const startedAtMs = Date.now();

  const stop = new StopController(params.logger);
  stop.install();

  // Ensure local source exists
  const fingerprint = await computeFingerprint(params.paths.docTxtPath, { sha256: false });

  let state: ImportState;
  if (params.mode === 'import' || params.mode === 'test') {
    // Clean local "memory" for a fresh Qdrant import.
    // Important: keep tmp/doc.zip + tmp/doc.txt (source) intact.
    await resetLocalArtifacts(params.paths.tmpDir, { keepDocFiles: true });

    state = createNewState({
      mode: params.mode === 'test' ? 'test' : 'import',
      fingerprint,
      runConfig: {
        indexName: params.options.indexName,
        expectedIndexDimensions: params.options.expectedIndexDimensions,
        batchSize: params.options.batchSize,
        openrouterModel: params.options.openrouterModel,
        openrouterDimensions: params.options.openrouterDimensions,
        skipSupabaseSync: params.options.skipSupabaseSync,
      },
      estimatedTotalRecords: undefined,
      testRunId: params.testRunId,
    });
    await saveState(params.paths.statePath, state);
  } else {
    state = await loadState(params.paths.statePath);
    assertFingerprintMatch(state, fingerprint);
    params.logger.info({ cursorLine: state.cursor.lineNumber }, 'resuming from state');
  }

  // Supabase sync (one-time)
  const supabaseMap = await loadSupabaseNregMap({
    logger: params.logger,
    env: params.env,
    cfg: { ...defaultSupabaseSyncConfig(), enabled: !params.options.skipSupabaseSync },
  }).catch(async (e) => {
    await logError(params.paths.errorsPath, {
      ts: nowIso(),
      kind: 'supabase_error',
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      context: { table: defaultSupabaseSyncConfig().table },
    });
    throw e;
  });

  // Qdrant client (also confirms collection vector dimensions early)
  const { baseUrl, apiKey } = getQdrantConnectionFromEnv(params.env);
  const qdrant = new QdrantVectorDbClient(params.logger, {
    baseUrl,
    apiKey,
    collectionName: params.options.indexName,
    timeoutMs: params.env.qdrantTimeoutMs ?? defaults.defaultQdrantTimeoutMs,
    maxRetries: defaults.defaultMaxRetries,
    backoffBaseMs: defaults.defaultBackoffBaseMs,
    backoffMaxMs: defaults.defaultBackoffMaxMs,
  });
  await qdrant.initialize();
  const indexDims = qdrant.getIndexDimensions();
  if (!indexDims) throw new Error('Could not determine Qdrant collection vector dimensions.');
  if (indexDims !== params.options.expectedIndexDimensions) {
    throw new Error(
      `Qdrant collection dimensions mismatch. Collection "${params.options.indexName}" has ${indexDims}, but --expected-index-dimensions=${params.options.expectedIndexDimensions}.`
    );
  }

  // Embeddings provider
  const openRouterKey = params.env.openRouterApiKey;
  if (!openRouterKey) throw new Error('OPEN_ROUTER_API_RAG is missing (OpenRouter API key for embeddings).');

  const embedder = new OpenRouterEmbeddingProvider(params.logger, {
    apiKey: openRouterKey,
    model: params.options.openrouterModel,
    dimensions: params.options.openrouterDimensions,
    timeoutMs: defaults.defaultOpenRouterTimeoutMs,
    maxRetries: defaults.defaultMaxRetries,
    backoffBaseMs: defaults.defaultBackoffBaseMs,
    backoffMaxMs: defaults.defaultBackoffMaxMs,
  });

  // Embedding dimensions preflight (fail fast before reading 289k lines)
  {
    params.logger.info(
      {
        model: params.options.openrouterModel,
        requestedDimensions: params.options.openrouterDimensions ?? null,
        expectedIndexDimensions: indexDims,
      },
      'embedding preflight'
    );
    const probe = await embedder.embedTexts(['dimension_preflight']);
    const got = probe[0]?.length ?? 0;
    if (got !== indexDims) {
      throw new Error(
        `Embedding dimensions mismatch: got ${got}, expected ${indexDims} (Qdrant collection).\n` +
          `Model: ${params.options.openrouterModel}\n` +
          `Fix options:\n` +
          `- OR use a model / API option that returns ${indexDims} dims (try: --openrouter-dimensions ${indexDims})\n` +
          `No silent truncation is performed.`
      );
    }
  }

  const batchSize = params.options.batchSize;
  const maxRecords = params.options.maxRecords;
  const timeLimitMs = params.options.timeLimitSeconds ? params.options.timeLimitSeconds * 1000 : undefined;
  const pauseAfterBatches = params.options.pauseAfterBatches;
  const trackInsertedIds = Boolean(params.trackInsertedIds);
  const testRunId = params.testRunId || state.test_run_id;

  let batchesThisRun = 0;
  let buffer: Array<{ lineNo: number; nreg: string; embedding_text: string; metadata: Record<string, any> }> = [];
  let lastCommittedLine = state.cursor.lineNumber;

  const heartbeat = new Heartbeat(params.logger, defaults.defaultHeartbeatSeconds, () => ({
    processed: state.counters.processed,
    upserted: state.counters.upserted,
    failed: state.counters.failed,
    skipped: state.counters.skipped,
    batches: state.counters.batches,
    cursorLine: state.cursor.lineNumber,
    bufferSize: buffer.length,
    batchSize,
    estimatedTotalRecords: state.estimated_total_records,
    startedAtMs,
  }));
  heartbeat.start();

  const flushBuffer = async (reason: string): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    const batchLineMax = batch[batch.length - 1].lineNo;
    state.counters.batches += 1;
    batchesThisRun += 1;

    params.logger.info(
      { reason, batchSize: batch.length, batchNo: state.counters.batches, cursorLineBefore: state.cursor.lineNumber },
      'flushing batch'
    );

    const { upsertedCount, insertedIds } = await processWithSplit({
      batch,
      embedder,
      qdrant,
      indexDims,
      onRecordFailure: async (kind, record, err) => {
        const http = extractHttpErrorLike(err);
        state.counters.failed += 1;
        await logError(params.paths.errorsPath, {
          ts: nowIso(),
          kind,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          context: {
            nreg: record.nreg,
            lineNumber: record.lineNo,
            batchReason: reason,
            collectionName: params.options.indexName,
            http_status: http?.status ?? undefined,
            http_body: http?.body ? truncate(http.body, 1200) : undefined,
          },
        });
      },
    });

    state.counters.upserted += upsertedCount;

    if (trackInsertedIds && insertedIds.length > 0) {
      await appendInsertedIdEntries(
        params.paths.insertedIdsPath,
        insertedIds.map((x) => ({ id: x.id, nreg: x.nreg, test_run_id: testRunId || undefined }))
      );
    }

    lastCommittedLine = batchLineMax;
    state.cursor.lineNumber = lastCommittedLine;
    await saveState(params.paths.statePath, state);

    params.logger.info(
      { upserted: upsertedCount, ids: insertedIds.length, cursorLineAfter: state.cursor.lineNumber },
      'batch upsert complete'
    );
  };

  const shouldStopNow = (): boolean => {
    if (stop.shouldStop) return true;
    if (timeLimitMs !== undefined && Date.now() - startedAtMs >= timeLimitMs) return true;
    if (pauseAfterBatches !== undefined && batchesThisRun >= pauseAfterBatches) return true;
    if (maxRecords !== undefined && state.counters.processed >= maxRecords) return true;
    return false;
  };

  let seenLine = 0;
  try {
    for await (const line of readLocalDocLines(params.paths.docTxtPath)) {
      seenLine++;
      if (seenLine <= state.cursor.lineNumber) continue;

      const parsed = parseDocTsvLine(line);
      if (!parsed.ok) {
        state.counters.skipped += 1;
        // We can safely advance the cursor past malformed lines by committing them immediately.
        // But to preserve "no data loss", we only commit cursor when the buffer is empty.
        // Otherwise we'd skip buffered (unflushed) records on resume.
        await logError(params.paths.errorsPath, {
          ts: nowIso(),
          kind: 'parse_error',
          message: parsed.reason,
          context: { lineNumber: seenLine, sample: line.slice(0, 500) },
        });
        if (buffer.length === 0) {
          state.cursor.lineNumber = seenLine;
          lastCommittedLine = seenLine;
          await saveState(params.paths.statePath, state);
        }
        if (shouldStopNow()) break;
        continue;
      }

      const normalized = normalizeRow(parsed.row);
      const supa = attachSupabaseFields(normalized.nreg, supabaseMap);
      const metadata: Record<string, any> = {
        nreg: normalized.nreg,
        dokid: normalized.dokid,
        nazva: truncate(normalized.nazva, 800),
        type: truncate(normalized.type, 200),
        organ: truncate(normalized.organ, 200),
        status: truncate(normalized.status, 50),
        year: normalized.year ?? null,
        datred: normalized.datred ?? null,
        minjust: normalized.minjust,
        source_system: supa.source_system,
        is_in_supabase: supa.is_in_supabase,
        supabase_doc_id: supa.supabase_doc_id,
      };

      // Optional raw fields (helpful for later debugging / enrichment)
      if (normalized.types_raw) metadata.types_raw = truncate(normalized.types_raw, 500);
      if (normalized.organs_raw) metadata.organs_raw = truncate(normalized.organs_raw, 500);

      const isTestRun = params.mode === 'test' || state.mode === 'test';
      if (isTestRun && testRunId) {
        metadata.is_test = true;
        metadata.test_run_id = testRunId;
      }

      buffer.push({
        lineNo: seenLine,
        nreg: normalized.nreg,
        embedding_text: normalized.embedding_text,
        metadata,
      });

      state.counters.processed += 1;

      if (buffer.length >= batchSize) {
        await flushBuffer('batch_full');
      }

      if (shouldStopNow()) break;
    }

    // FINAL FLUSH always
    await flushBuffer('final_flush');
  } catch (e) {
    const http = extractHttpErrorLike(e);
    await logError(params.paths.errorsPath, {
      ts: nowIso(),
      kind: 'fatal',
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      context: {
        cursorLine: state.cursor.lineNumber,
        processed: state.counters.processed,
        batches: state.counters.batches,
        collectionName: params.options.indexName,
        http_status: http?.status ?? undefined,
        http_body: http?.body ? truncate(http.body, 1200) : undefined,
      },
    });
    throw e;
  } finally {
    heartbeat.stop();
    stop.uninstall();
  }

  const stoppedAt = nowIso();
  state.timestamps.stopped_at = stoppedAt;
  await saveState(params.paths.statePath, state);

  const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
  const eta = estimateEtaSeconds(state.counters.processed, state.estimated_total_records, elapsedSeconds);
  const notes: string[] = [];
  if (eta !== undefined) notes.push(`eta=${formatSeconds(eta)}`);
  if (stop.stopReason) notes.push(`stop_reason=${stop.stopReason}`);

  return {
    kind: 'run_report',
    mode: params.mode,
    indexName: params.options.indexName,
    started_at: startedAt,
    stopped_at: stoppedAt,
    counters: {
      processed: state.counters.processed,
      upserted: state.counters.upserted,
      failed: state.counters.failed,
      skipped: state.counters.skipped,
      batches: state.counters.batches,
    },
    cursor: { lineNumber: state.cursor.lineNumber },
    test_run_id: testRunId,
    notes: notes.length > 0 ? notes : undefined,
  };
}

function truncate(v: string, max: number): string {
  if (v.length <= max) return v;
  return v.slice(0, max) + '…';
}

class StopController {
  shouldStop = false;
  stopReason: string | null = null;
  private handler: (() => void) | null = null;

  constructor(private readonly logger: Logger) {}

  install(): void {
    if (this.handler) return;
    this.handler = () => {
      if (this.shouldStop) {
        this.logger.warn('second SIGINT received; exiting immediately');
        process.exit(130);
      }
      this.shouldStop = true;
      this.stopReason = 'sigint';
      this.logger.warn('SIGINT received; will stop after final flush');
    };
    process.on('SIGINT', this.handler);
  }

  uninstall(): void {
    if (!this.handler) return;
    process.off('SIGINT', this.handler);
    this.handler = null;
  }
}

async function fileExistsSafe(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function processWithSplit(params: {
  batch: Array<{ lineNo: number; nreg: string; embedding_text: string; metadata: Record<string, any> }>;
  embedder: OpenRouterEmbeddingProvider;
  qdrant: QdrantVectorDbClient;
  indexDims: number;
  onRecordFailure: (kind: 'embedding_error' | 'vector_db_error', record: { lineNo: number; nreg: string }, err: unknown) => Promise<void>;
}): Promise<{ upsertedCount: number; insertedIds: Array<{ id: string; nreg: string }> }> {
  if (params.batch.length === 0) return { upsertedCount: 0, insertedIds: [] };

  // Step 1: embeddings
  let embeddings: number[][];
  try {
    embeddings = await params.embedder.embedTexts(params.batch.map((b) => b.embedding_text));
    for (const v of embeddings) {
      if (v.length !== params.indexDims) {
        // This should not happen after preflight; treat as fatal.
        throw new Error(`Embedding batch has inconsistent dims: expected ${params.indexDims}, got ${v.length}`);
      }
    }
  } catch (e) {
    if (params.batch.length === 1) {
      await params.onRecordFailure('embedding_error', params.batch[0], e);
      return { upsertedCount: 0, insertedIds: [] };
    }
    const mid = Math.floor(params.batch.length / 2);
    const left = await processWithSplit({ ...params, batch: params.batch.slice(0, mid) });
    const right = await processWithSplit({ ...params, batch: params.batch.slice(mid) });
    return { upsertedCount: left.upsertedCount + right.upsertedCount, insertedIds: [...left.insertedIds, ...right.insertedIds] };
  }

  // Step 2: upsert
  const points = params.batch.map((b, i) => ({
    id: nregToUuid(b.nreg),
    vector: embeddings[i],
    payload: b.metadata,
  }));

  try {
    await params.qdrant.upsertPoints(points);
    return { upsertedCount: points.length, insertedIds: points.map((p, i) => ({ id: p.id, nreg: params.batch[i].nreg })) };
  } catch (e) {
    if (params.batch.length === 1) {
      await params.onRecordFailure('vector_db_error', params.batch[0], e);
      return { upsertedCount: 0, insertedIds: [] };
    }
    const mid = Math.floor(params.batch.length / 2);
    const left = await processWithSplit({ ...params, batch: params.batch.slice(0, mid) });
    const right = await processWithSplit({ ...params, batch: params.batch.slice(mid) });
    return { upsertedCount: left.upsertedCount + right.upsertedCount, insertedIds: [...left.insertedIds, ...right.insertedIds] };
  }
}

function extractHttpErrorLike(e: unknown): { status?: number; body?: string } | null {
  const anyE: any = e as any;
  const status = typeof anyE?.status === 'number' ? anyE.status : undefined;
  const body = typeof anyE?.body === 'string' ? anyE.body : undefined;
  if (status === undefined && body === undefined) return null;
  return { status, body };
}

