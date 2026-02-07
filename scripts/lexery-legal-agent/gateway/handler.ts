/**
 * U1 Gateway — POST /v1/runs handler (LEX-68, 69, 70, 71, 72, 73, 75)
 */
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { CreateRunRequestSchema, type CreateRunRequest } from './types.js';
import { DevAuthProvider, AuthError } from './auth.js';
import { checkRateLimit, checkConcurrentRuns, decrementActiveRuns } from './limits.js';
import { RunRepository } from './storage.js';
import { InMemoryQueue } from './queue.js';
import { processAttachments, estimateRequestSize } from './attachments.js';
import { putQueryOverflow } from './query-overflow.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { incrementRunsStarted, incrementRunsRejected } from './observability.js';
import type { SnapshotInput } from './types.js';

const auth = new DevAuthProvider();
const runRepo = new RunRepository();
const taskQueue = new InMemoryQueue();

export function getTaskQueue() {
  return taskQueue;
}

export async function handleGetRun(req: Request, res: Response): Promise<void> {
  const runId = req.params.id;
  if (!runId) {
    res.status(400).json({ error: 'Missing run id', code: 'VALIDATION_ERROR' });
    return;
  }
  try {
    const auth = new DevAuthProvider();
    await auth.authenticate(req, { query: 'x' });
  } catch {
    res.status(401).json({ error: 'Invalid or missing X-Dev-API-Key', code: 'UNAUTHORIZED' });
    return;
  }
  const runRepoGet = new RunRepository();
  const run = await runRepoGet.findByRunId(runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found', code: 'NOT_FOUND' });
    return;
  }
  res.json({
    run_id: run.run_id,
    status: run.status,
    query: run.query,
    query_profile: run.query_profile ?? null,
    search_plan: run.search_plan ?? null,
    retrieval_trace: run.retrieval_trace ?? null,
    gate_decision: run.gate_decision ?? null,
    created_at: run.created_at,
    updated_at: (run as { updated_at?: string }).updated_at,
  });
}

export async function handleCreateRun(req: Request, res: Response): Promise<void> {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  const traceId = randomUUID();

  const ctx = { request_id: requestId, trace_id: traceId };

  try {
    const parseResult = CreateRunRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      incrementRunsRejected('validation');
      res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: parseResult.error.flatten(),
      });
      return;
    }

    const body = parseResult.data;

    if (estimateRequestSize(body) > config.requestInlineMaxBytes) {
      res.status(400).json({
        error: 'Request payload too large',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const authContext = await auth.authenticate(req, body);

    const rateCheck = checkRateLimit(authContext.tenant_id);
    if (!rateCheck.allowed) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'ERR_BUDGET_EXHAUSTED',
      });
      return;
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    const warnings: string[] = [];

    let queryForDb: string = body.query;
    let snapshotInput: SnapshotInput | undefined;

    const queryBytes = Buffer.byteLength(body.query, 'utf8');
    if (queryBytes > config.queryR2ThresholdBytes) {
      const overflowResult = await putQueryOverflow(body.query, authContext.tenant_id, runId);
      const prev = overflowResult.query_preview;
      queryForDb =
        prev.head +
        '\n...[overflow]...\n' +
        prev.tail;
      snapshotInput = {
        query_overflow: true,
        query_ref: overflowResult.success ? overflowResult.query_ref ?? null : undefined,
        query_preview: prev,
        input_overflow_store_failed: !overflowResult.success,
      };
      if (!overflowResult.success) {
        warnings.push('input_overflow_store_failed');
      }
    }

    const snapshot = {
      request: {
        query: queryForDb,
        locale: body.locale,
        dry_run: body.dry_run,
        debug: body.debug,
      },
      auth: authContext,
      flags: { dry_run: body.dry_run, debug: body.debug },
      version: { api_version: config.apiVersion },
      ...(snapshotInput && { input: snapshotInput }),
    };

    if (body.dry_run) {
      res.status(200).json({
        run_id: `dry-run-${runId}`,
        status: 'dry_run_accepted',
        accepted_at: now,
        warnings: [],
      });
      return;
    }

    const concurrentCheck = checkConcurrentRuns(authContext.tenant_id);
    if (!concurrentCheck.allowed) {
      res.status(429).json({
        error: 'Too many concurrent runs',
        code: 'ERR_BUDGET_EXHAUSTED',
      });
      return;
    }

    let attachmentsManifest: { name: string; size: number; sha256?: string; storage: 'inline' | 'r2'; r2_key?: string }[] = [];

    if (body.attachments && body.attachments.length > 0) {
      const result = await processAttachments(body.attachments, authContext.tenant_id, runId);
      attachmentsManifest = result.manifest;
      warnings.push(...result.warnings);
    }

    const existing = body.idempotency_key
      ? await runRepo.findByIdempotencyKey(authContext.tenant_id, body.idempotency_key)
      : null;

    let recordRunId: string = runId;
    if (existing) {
      recordRunId = existing.run_id;
      decrementActiveRuns(authContext.tenant_id);
      res.status(202).json({
        run_id: existing.run_id,
        status: 'accepted',
        accepted_at: existing.created_at,
        idempotent: true,
        warnings: warnings.length ? warnings : undefined,
      });
      return;
    }

    await runRepo.create({
      runId: recordRunId,
      tenantId: authContext.tenant_id,
      userId: authContext.user_id,
      query: queryForDb,
      snapshot,
      attachmentsManifest: attachmentsManifest.length ? attachmentsManifest : undefined,
      idempotencyKey: body.idempotency_key,
    });

    try {
      await taskQueue.enqueue({
        run_id: recordRunId,
        step: 'U2',
        created_at: now,
        trace_id: traceId,
      });
    } catch (queueErr) {
      await runRepo.markFailed(recordRunId, 'QUEUE_FAIL');
      decrementActiveRuns(authContext.tenant_id);
      res.status(503).json({
        error: 'Queue unavailable',
        code: 'QUEUE_FAIL',
      });
      return;
    }

    decrementActiveRuns(authContext.tenant_id);
    incrementRunsStarted();
    logger.info('Run accepted', {
      run_id: recordRunId,
      tenant_id: authContext.tenant_id,
      user_id: authContext.user_id,
      request_id: requestId,
    });

    res.status(202).json({
      run_id: recordRunId,
      status: 'accepted',
      accepted_at: now,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
      });
      return;
    }

    const runIdForFail = (req as { _runId?: string })._runId;
    if (runIdForFail && err && (err as Error).message?.includes('queue') === false) {
      try {
        await runRepo.markFailed(runIdForFail, 'GATEWAY_ERROR');
      } catch {}
    }

    logger.error('U1 Gateway error', {
      ...ctx,
      error: (err as Error).message,
    });

    const code = (err as { code?: string }).code;
    if (code === 'DB_WRITE_FAIL' || (err as Error).message?.includes('Supabase')) {
      res.status(503).json({ error: 'Database unavailable', code: 'DB_DOWN' });
      return;
    }
    if (code === 'QUEUE_FAIL') {
      res.status(503).json({ error: 'Queue unavailable', code: 'QUEUE_FAIL' });
      return;
    }

    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
}
