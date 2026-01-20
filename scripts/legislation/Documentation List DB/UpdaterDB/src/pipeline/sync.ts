import crypto from 'node:crypto';
import type { Logger } from 'pino';
import pLimit from 'p-limit';
import type { CliOptions, EnvConfig } from '../config.js';
import { getDefaults, getQdrantConnectionFromEnv } from '../config.js';
import { OpenRouterEmbeddingProvider } from '../embedding/client.js';
import { acquireDailyLock, releaseLock } from '../r2/lock.js';
import { writeRunReport } from '../r2/logs.js';
import { createR2S3Client } from '../r2/s3.js';
import { defaultState, loadState, saveStateAtomic, type UpdaterState } from '../r2/state.js';
import { fetchAndNormalizeCard } from '../rada/cards.js';
import { RadaHttpClient } from '../rada/client.js';
import { fetchBackstop30dFeed, fetchNewTodayFeed, fetchUpdatedFeed } from '../rada/feeds.js';
import { canonicalizePayload, payloadEquals, type DocCardPayload } from '../qdrant/compare.js';
import { QdrantDocListClient } from '../qdrant/client.js';
import { backoffDelayMs, makeRunId, nowIso, safeJson, sleep, truncate } from '../utils.js';

export interface SyncResult {
  ok: boolean;
  runId: string;
}

type ChangedDoc = {
  nreg: string;
  dokid: number;
  pointId: string | number;
  payload: DocCardPayload;
  embedding_text: string;
};

function msSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Date.now() - ms;
}

function shouldRunBackstop(cli: CliOptions, state: UpdaterState): boolean {
  if (cli.backstop) return true;
  const sinceLastSuccess = msSince(state.last_success_at);
  // If we have no record of a successful run, do one backstop run to avoid missing updates.
  if (sinceLastSuccess === null) return true;
  if (sinceLastSuccess > 48 * 3600 * 1000) return true;
  const sinceLastBackstop = msSince(state.last_backstop_success_at);
  // Backstop is optional; if never ran before and we have recent successes, don't force it daily.
  if (sinceLastBackstop === null) return false;
  if (sinceLastBackstop > 7 * 24 * 3600 * 1000) return true;
  return false;
}

function dedupePreserveOrder(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of items) {
    const t = String(x || '').trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function embeddingPreflight(params: { logger: Logger; embedder: OpenRouterEmbeddingProvider; expectedDims: number }): Promise<void> {
  params.logger.info({ expectedDims: params.expectedDims }, 'embedding preflight');
  const probe = await params.embedder.embedTexts(['dimension_preflight']);
  const got = probe[0]?.length ?? 0;
  if (got !== params.expectedDims) {
    throw new Error(`Embedding dimensions mismatch: got ${got}, expected ${params.expectedDims}. No silent truncation.`);
  }
}

async function processWithSplit(params: {
  docs: ChangedDoc[];
  embedder: OpenRouterEmbeddingProvider;
  qdrant: QdrantDocListClient;
  indexDims: number;
  onDocFailure: (kind: 'embedding_error' | 'vector_db_error', doc: Pick<ChangedDoc, 'nreg' | 'dokid' | 'pointId'>, err: unknown) => Promise<void>;
}): Promise<{ upserted: number }> {
  if (params.docs.length === 0) return { upserted: 0 };

  // Step 1: embeddings
  let embeddings: number[][];
  try {
    embeddings = await params.embedder.embedTexts(params.docs.map((d) => d.embedding_text));
    for (const v of embeddings) {
      if (v.length !== params.indexDims) {
        throw new Error(`Embedding batch has inconsistent dims: expected ${params.indexDims}, got ${v.length}`);
      }
    }
  } catch (e) {
    if (params.docs.length === 1) {
      await params.onDocFailure('embedding_error', params.docs[0], e);
      return { upserted: 0 };
    }
    const mid = Math.floor(params.docs.length / 2);
    const left = await processWithSplit({ ...params, docs: params.docs.slice(0, mid) });
    const right = await processWithSplit({ ...params, docs: params.docs.slice(mid) });
    return { upserted: left.upserted + right.upserted };
  }

  // Step 2: upsert
  const points = params.docs.map((d, i) => ({ id: d.pointId, vector: embeddings[i], payload: d.payload as any }));
  try {
    await params.qdrant.upsertPoints(points);
    return { upserted: points.length };
  } catch (e) {
    if (params.docs.length === 1) {
      await params.onDocFailure('vector_db_error', params.docs[0], e);
      return { upserted: 0 };
    }
    const mid = Math.floor(params.docs.length / 2);
    const left = await processWithSplit({ ...params, docs: params.docs.slice(0, mid) });
    const right = await processWithSplit({ ...params, docs: params.docs.slice(mid) });
    return { upserted: left.upserted + right.upserted };
  }
}

async function runSelftest(params: {
  logger: Logger;
  qdrant: QdrantDocListClient;
  embedder: OpenRouterEmbeddingProvider;
  indexDims: number;
}): Promise<void> {
  const pointId = crypto.randomUUID(); // string id to avoid collisions with integer dokids
  const payload: DocCardPayload = {
    nreg: '__selftest__',
    dokid: 1,
    nazva: 'SELFTEST TEMP',
    type: '0',
    organ: '0',
    status: '0',
    year: 1970,
    datred: '19700101',
    minjust: false,
    source_system: 'rada',
    is_in_supabase: false,
    supabase_doc_id: null,
    types_raw: '0',
    organs_raw: '0:19700101:__selftest__',
  };
  const embedding_text = `${payload.nazva}. Тип: ${payload.type}. Орган: ${payload.organ}. Рік: ${payload.year}.`;

  const vectors = await params.embedder.embedTexts([embedding_text]);
  const v = vectors[0];
  if (!v || v.length !== params.indexDims) throw new Error(`selftest: embedding dims mismatch (got ${v?.length ?? 0}, expected ${params.indexDims})`);

  await params.qdrant.upsertPoints([{ id: pointId, vector: v, payload }]);
  const found = await params.qdrant.retrieveById(pointId);
  if (!found || !found.payload) throw new Error('selftest: retrieve did not find inserted point');
  const gotNreg = String((found.payload as any).nreg || '');
  if (gotNreg !== '__selftest__') throw new Error(`selftest: payload mismatch (nreg=${gotNreg})`);
  await params.qdrant.deleteByIds([pointId]);

  params.logger.info({ pointId }, 'selftest ok');
}

export async function runSync(params: { logger: Logger; env: EnvConfig; cli: CliOptions }): Promise<SyncResult> {
  const startedAt = nowIso();
  const startedAtMs = Date.now();
  const runId = makeRunId('rada_doclistdb');
  const defaults = getDefaults();

  const s3 = createR2S3Client(params.env);

  // Load state early (even if we can't acquire the lock, we still want deterministic behavior).
  let state = await loadState({ s3, bucket: params.env.r2Bucket, prefix: params.env.r2Prefix }).catch(() => defaultState());

  // Lock
  const lockTtlSeconds = 3 * 3600;
  const lock = await acquireDailyLock({
    s3,
    bucket: params.env.r2Bucket,
    prefix: params.env.r2Prefix,
    runId,
    ttlSeconds: lockTtlSeconds,
  });
  if (!lock.acquired) {
    params.logger.warn({ runId, lock: lock.lock }, 'daily lock is held; exiting 0');
    return { ok: true, runId };
  }

  const errors: Array<{ where: string; nreg?: string; dokid?: number; message: string }> = [];
  const changedExamples: Array<{ nreg: string; dokid: number; point_id: string | number }> = [];

  let updatedCandidates: string[] = [];
  let newCandidates: string[] = [];
  let backstopCandidates: string[] = [];
  let skippedPayloadEqual = 0;
  let upserted = 0;
  let failed = 0;
  let reportWritten = false;

  // We'll only write state at the very end (on success).
  const nextState: UpdaterState = JSON.parse(JSON.stringify(state)) as UpdaterState;

  try {
    const rada = new RadaHttpClient(params.logger, {
      timeoutMs: 60_000,
      maxRetries: defaults.defaultMaxRetries,
      backoffBaseMs: defaults.defaultBackoffBaseMs,
      backoffMaxMs: defaults.defaultBackoffMaxMs,
      delayMinMs: params.cli.radaDelayMinMs,
      delayMaxMs: params.cli.radaDelayMaxMs,
      userAgent: 'OpenData',
    });

    const updated = await fetchUpdatedFeed({ logger: params.logger, client: rada, ifModifiedSince: state.last_modified.r_txt ?? null });
    const nn = await fetchNewTodayFeed({ logger: params.logger, client: rada, ifModifiedSince: state.last_modified.nn ?? null });

    updatedCandidates = updated.nregs;
    newCandidates = nn.nregs;

    if (updated.status === 200) nextState.last_modified.r_txt = updated.lastModified ?? nextState.last_modified.r_txt ?? null;
    if (nn.status === 200) nextState.last_modified.nn = nn.lastModified ?? nextState.last_modified.nn ?? null;

    const doBackstop = shouldRunBackstop(params.cli, state);
    if (doBackstop) {
      const backstop = await fetchBackstop30dFeed({
        logger: params.logger,
        client: rada,
        ifModifiedSince: state.last_modified.n_backstop ?? null,
      });
      backstopCandidates = backstop.nregs;
      if (backstop.status === 200) nextState.last_modified.n_backstop = backstop.lastModified ?? nextState.last_modified.n_backstop ?? null;
      // Only mark backstop success if we actually ran it and the request succeeded.
      nextState.last_backstop_success_at = nowIso();
    }

    const noChanges = updatedCandidates.length === 0 && newCandidates.length === 0 && backstopCandidates.length === 0;

    // Build ordered candidates set
    const candidates = dedupePreserveOrder([...updatedCandidates, ...newCandidates, ...backstopCandidates]);
    const limited = params.cli.maxDocs ? candidates.slice(0, params.cli.maxDocs) : candidates;
    params.logger.info(
      {
        runId,
        updated: updatedCandidates.length,
        new_today: newCandidates.length,
        backstop: backstopCandidates.length,
        deduped_total: candidates.length,
        processing: limited.length,
      },
      'candidates prepared'
    );

    // Fast path: no candidates. No Qdrant + no embeddings.
    if (limited.length === 0) {
      // Self-test is only for the "no changes" path.
      if (params.cli.selftest && updatedCandidates.length === 0 && newCandidates.length === 0) {
        const { baseUrl, apiKey } = getQdrantConnectionFromEnv(params.env);
        const qdrant = new QdrantDocListClient(params.logger, {
          baseUrl,
          apiKey,
          collectionName: params.env.qdrantCollection || defaults.defaultQdrantCollection,
          timeoutMs: params.env.qdrantTimeoutMs ?? defaults.defaultQdrantTimeoutMs,
          maxRetries: defaults.defaultMaxRetries,
          backoffBaseMs: defaults.defaultBackoffBaseMs,
          backoffMaxMs: defaults.defaultBackoffMaxMs,
        });
        await qdrant.initialize();
        const indexDims = qdrant.getIndexDimensions();
        if (!indexDims) throw new Error('Could not determine Qdrant collection vector dimensions.');

        if (!params.env.embeddingApiKey) throw new Error('Embedding API key missing (EMBEDDING_API_KEY or OPEN_ROUTER_API_RAG).');
        const embedder = new OpenRouterEmbeddingProvider(params.logger, {
          apiKey: params.env.embeddingApiKey,
          model: params.env.embeddingModel,
          dimensions: params.env.embeddingDimensions,
          endpoint: params.env.embeddingEndpoint,
          timeoutMs: params.env.embeddingTimeoutMs,
          maxRetries: defaults.defaultMaxRetries,
          backoffBaseMs: defaults.defaultBackoffBaseMs,
          backoffMaxMs: defaults.defaultBackoffMaxMs,
        });
        await embeddingPreflight({ logger: params.logger, embedder, expectedDims: indexDims });
        await runSelftest({ logger: params.logger, qdrant, embedder, indexDims });
      }

      nextState.last_success_at = nowIso();
      const report = {
        kind: 'rada_doclistdb_updater_run',
        run_id: runId,
        started_at: startedAt,
        finished_at: nowIso(),
        ok: true,
        mode: { dry_run: params.cli.dryRun, backstop: params.cli.backstop, selftest: params.cli.selftest },
        stats: {
          updated_candidates: updatedCandidates.length,
          new_candidates: newCandidates.length,
          backstop_candidates: backstopCandidates.length,
          skipped_payload_equal: 0,
          upserted: 0,
          failed: 0,
          duration_ms: Date.now() - startedAtMs,
        },
        selftest: params.cli.selftest && updatedCandidates.length === 0 && newCandidates.length === 0 ? { ok: true } : undefined,
      };
      await writeRunReport({ s3, bucket: params.env.r2Bucket, prefix: params.env.r2Prefix, runId, report });
      reportWritten = true;
      await saveStateAtomic({ s3, bucket: params.env.r2Bucket, prefix: params.env.r2Prefix, state: nextState, runId });
      return { ok: true, runId };
    }

    // Qdrant: needed for compare and/or upsert
    let qdrant: QdrantDocListClient | null = null;
    let indexDims: number | null = null;
    const needsQdrant = !params.cli.skipRetrieve || !params.cli.dryRun;
    if (needsQdrant) {
      const { baseUrl, apiKey } = getQdrantConnectionFromEnv(params.env);
      qdrant = new QdrantDocListClient(params.logger, {
        baseUrl,
        apiKey,
        collectionName: params.env.qdrantCollection || defaults.defaultQdrantCollection,
        timeoutMs: params.env.qdrantTimeoutMs ?? defaults.defaultQdrantTimeoutMs,
        maxRetries: defaults.defaultMaxRetries,
        backoffBaseMs: defaults.defaultBackoffBaseMs,
        backoffMaxMs: defaults.defaultBackoffMaxMs,
      });
      await qdrant.initialize();
      indexDims = qdrant.getIndexDimensions();
      if (!indexDims) throw new Error('Could not determine Qdrant collection vector dimensions.');
    }

    // Fetch cards + compare to Qdrant payload
    const limit = pLimit(params.cli.concurrency);
    const changed: ChangedDoc[] = [];

    await Promise.all(
      limited.map((nreg) =>
        limit(async () => {
          try {
            const card = await fetchAndNormalizeCard({ logger: params.logger, client: rada, nreg });

            let existing: { id: string | number; payload: Record<string, unknown> | null } | null = null;
            if (!params.cli.skipRetrieve) {
              if (!qdrant) throw new Error('Internal: qdrant not initialized');
              // Primary fast path: retrieve by dokid as point id
              existing = await qdrant.retrieveById(card.dokid);
              // Compatibility fallback: if ids are not dokid, try filter lookup (uses payload index).
              if (!existing) {
                existing = await qdrant.findOneByFilter({ dokid: card.dokid });
              }
            }

            // Preserve Supabase fields if present in existing payload to avoid spurious "changes".
            const existingPayloadAny = (existing?.payload || null) as any;
            const merged: DocCardPayload = {
              ...(card.payload as any),
              source_system: 'rada',
              is_in_supabase: Boolean(existingPayloadAny?.is_in_supabase ?? card.payload.is_in_supabase),
              supabase_doc_id:
                existingPayloadAny?.supabase_doc_id !== undefined && existingPayloadAny?.supabase_doc_id !== null
                  ? String(existingPayloadAny.supabase_doc_id)
                  : card.payload.supabase_doc_id,
            };

            let equal = false;
            if (existing && existing.payload) {
              try {
                const a = canonicalizePayload(existing.payload as any);
                const b = canonicalizePayload(merged);
                equal = payloadEquals(a, b);
              } catch (e) {
                equal = false;
              }
            }

            if (existing && equal) {
              skippedPayloadEqual += 1;
              return;
            }

            const pointId: string | number = existing?.id ?? card.dokid;
            const payload = canonicalizePayload(merged);

            changed.push({
              nreg: card.nreg,
              dokid: card.dokid,
              pointId,
              payload,
              embedding_text: card.embedding_text,
            });
            if (changedExamples.length < 25) changedExamples.push({ nreg: card.nreg, dokid: card.dokid, point_id: pointId });
          } catch (e: any) {
            failed += 1;
            errors.push({ where: 'candidate', nreg, message: e instanceof Error ? e.message : String(e) });
          }
        })
      )
    );

    params.logger.info(
      { runId, changed: changed.length, skipped_payload_equal: skippedPayloadEqual, failed },
      'delta detection complete'
    );

    if (!params.cli.dryRun && changed.length > 0) {
      if (!qdrant || !indexDims) throw new Error('Internal: qdrant not initialized for normal run');
      if (!params.env.embeddingApiKey) throw new Error('Embedding API key missing (EMBEDDING_API_KEY or OPEN_ROUTER_API_RAG).');
      const embedder = new OpenRouterEmbeddingProvider(params.logger, {
        apiKey: params.env.embeddingApiKey,
        model: params.env.embeddingModel,
        dimensions: params.env.embeddingDimensions,
        endpoint: params.env.embeddingEndpoint,
        timeoutMs: params.env.embeddingTimeoutMs,
        maxRetries: defaults.defaultMaxRetries,
        backoffBaseMs: defaults.defaultBackoffBaseMs,
        backoffMaxMs: defaults.defaultBackoffMaxMs,
      });
      await embeddingPreflight({ logger: params.logger, embedder, expectedDims: indexDims });

      // Batch size for embedding/upsert (kept modest)
      const batchSize = 32;
      for (let i = 0; i < changed.length; i += batchSize) {
        const batch = changed.slice(i, i + batchSize);
        const res = await processWithSplit({
          docs: batch,
          embedder,
          qdrant,
          indexDims,
          onDocFailure: async (kind, doc, err) => {
            failed += 1;
            errors.push({
              where: kind,
              nreg: doc.nreg,
              dokid: doc.dokid,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        });
        upserted += res.upserted;
        // Gentle pacing between Qdrant batches (small; Rada pacing is the main constraint)
        await sleep(150);
      }
    }

    nextState.last_success_at = nowIso();

    const report = {
      kind: 'rada_doclistdb_updater_run',
      run_id: runId,
      started_at: startedAt,
      finished_at: nowIso(),
      ok: failed === 0,
      mode: { dry_run: params.cli.dryRun, backstop: params.cli.backstop, selftest: params.cli.selftest },
      stats: {
        updated_candidates: updatedCandidates.length,
        new_candidates: newCandidates.length,
        backstop_candidates: backstopCandidates.length,
        skipped_payload_equal: skippedPayloadEqual,
        upserted,
        failed,
        duration_ms: Date.now() - startedAtMs,
      },
      changed_examples: changedExamples,
      errors: errors.slice(0, 200),
    };

    await writeRunReport({ s3, bucket: params.env.r2Bucket, prefix: params.env.r2Prefix, runId, report });
    reportWritten = true;

    if (failed > 0) {
      // Per task: state updates only after a fully successful run.
      throw new Error(`Run finished with failures: failed=${failed} (see run report in R2: runs/${runId}.json)`);
    }

    await saveStateAtomic({ s3, bucket: params.env.r2Bucket, prefix: params.env.r2Prefix, state: nextState, runId });
    return { ok: true, runId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!reportWritten) {
      // Best-effort run report for early/fatal failures.
      const report = {
        kind: 'rada_doclistdb_updater_run',
        run_id: runId,
        started_at: startedAt,
        finished_at: nowIso(),
        ok: false,
        mode: { dry_run: params.cli.dryRun, backstop: params.cli.backstop, selftest: params.cli.selftest },
        stats: {
          updated_candidates: updatedCandidates.length,
          new_candidates: newCandidates.length,
          backstop_candidates: backstopCandidates.length,
          skipped_payload_equal: skippedPayloadEqual,
          upserted,
          failed,
          duration_ms: Date.now() - startedAtMs,
        },
        fatal_error: msg,
        changed_examples: changedExamples,
        errors: errors.slice(0, 200),
      };
      await writeRunReport({ s3, bucket: params.env.r2Bucket, prefix: params.env.r2Prefix, runId, report }).catch(() => null);
    }
    throw e;
  } finally {
    await releaseLock({ s3, bucket: params.env.r2Bucket, key: lock.key });
  }
}

