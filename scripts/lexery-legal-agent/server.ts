#!/usr/bin/env node
/**
 * Lexery Legal Agent Brain — HTTP Server
 * U1 Gateway: POST /v1/runs
 * U2 Consumer: step "U2" → Query Profiling Pipeline
 */
import express from 'express';
import { handleCreateRun, handleGetRun } from './gateway/handler.js';
import { config } from './lib/config.js';
import { checkSupabaseHealth } from './lib/supabase.js';
import { logger } from './lib/logger.js';
import { getTaskQueue } from './gateway/handler.js';
import { setU2QueueDepth } from './gateway/observability.js';
import { handleU2Event } from './classify/consumer.js';
import { handleU3Event, handleU3aEvent } from './plan/consumer.js';
import { handleU4Event } from './retrieval/consumer.js';
import { handleU5Event } from './gate/consumer.js';
import { handleU6Event } from './expand/consumer.js';
import { handleU9Event } from './assemble/consumer.js';
import { handleU10Event } from './write/consumer.js';
import { handleU11Event } from './write/verifyConsumer.js';
import { handleU12Event } from './write/deliverConsumer.js';
import { getRunContextStore, resetRunContextStore, setRunContextStore } from './lib/run-context.js';
import { createRedisRunContextStore } from './lib/run-context-redis.js';
import { runOutboxWorkerBatch } from './mm/outboxWorker.js';
import { ensureMemoryCollectionPayloadIndexes } from './mm/semanticSearch.js';
import { shutdownTaskQueue } from './gateway/queue-factory.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const requestId = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  (req as { id?: string }).id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  next();
};
app.use(requestId);

/** Express 4: catch async route rejections so they don't become unhandled. */
function asyncRoute<T extends (req: express.Request, res: express.Response) => Promise<void>>(
  fn: T
): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

app.post('/v1/runs', asyncRoute(handleCreateRun));
app.get('/v1/runs/:id', asyncRoute(handleGetRun));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: string }).code) : 'API_ERROR';
  const status = code === 'DB_READ_FAIL' || code.startsWith('DB_') ? 503 : 500;
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Internal server error',
    code,
  });
});

app.get('/health', async (_req, res) => {
  const dbOk = await checkSupabaseHealth();
  res.json({
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    service: 'lexery-brain-u1',
    database: dbOk ? 'ok' : 'error',
  });
});

const queue = getTaskQueue();
if (config.u2DisableConsumer) {
  queue.onEvent((event) => {
    logger.info('RunEvent enqueued (U2 consumer disabled)', {
      run_id: event.run_id,
      step: event.step,
      trace_id: event.trace_id,
    });
  });
} else {
  queue.onEvent((event) => {
    if (event.step === 'U2') {
      handleU2Event(event).catch((err) => {
        logger.error('U2 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U3') {
      handleU3Event(event).catch((err) => {
        logger.error('U3 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U3a') {
      handleU3aEvent(event).catch((err) => {
        logger.error('U3a consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U4') {
      handleU4Event(event).catch((err) => {
        logger.error('U4 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U5') {
      handleU5Event(event).catch((err) => {
        logger.error('U5 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U6') {
      handleU6Event(event).catch((err) => {
        logger.error('U6 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U9') {
      handleU9Event(event).catch((err) => {
        logger.error('U9 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U10') {
      handleU10Event(event).catch((err) => {
        logger.error('U10 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U11') {
      handleU11Event(event).catch((err) => {
        logger.error('U11 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    } else if (event.step === 'U12') {
      handleU12Event(event).catch((err) => {
        logger.error('U12 consumer unhandled', { run_id: event.run_id, error: String(err) });
      });
    }
  });
}

let mmOutboxWorkerRunning = false;
async function runMmOutboxWorkerOnce(): Promise<void> {
  if (mmOutboxWorkerRunning) return;
  mmOutboxWorkerRunning = true;
  try {
    const result = await runOutboxWorkerBatch({
      batchSize: config.mmOutboxBatchSize,
    });
    if (result.processed > 0 || result.failed > 0) {
      logger.info('mm_outbox_worker: cycle', {
        processed: result.processed,
        failed: result.failed,
        skipped: result.skipped,
        factsInserted: result.factsInserted,
        qdrantUpserted: result.qdrantUpserted,
      });
    }
  } catch (err) {
    logger.warn('mm_outbox_worker: cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    mmOutboxWorkerRunning = false;
  }
}

/** Port optional for dev chat CLI tools (use 0 for random free port). Returns actual listen port. */
export async function start(port?: number): Promise<{ port: number; close: () => Promise<void> }> {
  setU2QueueDepth(0);
  let workerInterval: NodeJS.Timeout | null = null;
  if (config.memorySemanticEnabled && config.memoryQdrantUrl) {
    ensureMemoryCollectionPayloadIndexes()
      .then((r) => {
        if (r.ok) logger.info('mm_semantic_bootstrap: payload indexes ok', {});
        else
          logger.warn('mm_semantic_bootstrap: failed (semantic will run degraded)', {
            reason_code: r.reason_code,
          });
      })
      .catch((err) =>
        logger.warn('mm_semantic_bootstrap: error', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
  }
  if (config.memorySemanticEnabled && !config.memoryQdrantUrl) {
    logger.warn('MEMORY_SEMANTIC_ENABLED=true but memory Qdrant URL not configured — semantic memory degraded', {
      hint: 'Set QDRANT_MEMORY_URL or LEXERY-LA cluster env; do not rely on legislation fallback unless MEMORY_QDRANT_ALLOW_LEGISLATION_FALLBACK=true',
    });
  } else if (
    config.memorySemanticEnabled &&
    config.memoryQdrantUrl &&
    config.qdrantUrl &&
    config.memoryQdrantUrl.replace(/\/$/, '') === config.qdrantUrl.replace(/\/$/, '') &&
    !config.memoryQdrantAllowLegislationFallback
  ) {
    logger.warn('Memory Qdrant URL equals legislation URL — memory vectors may be in wrong cluster', {
      hint: 'Use LEXERY-LA cluster for memory or set MEMORY_QDRANT_ALLOW_LEGISLATION_FALLBACK=true explicitly',
    });
  }
  if (config.mmOutboxWorkerEnabled) {
    workerInterval = setInterval(() => {
      runMmOutboxWorkerOnce().catch(() => {});
    }, config.mmOutboxPollIntervalMs);
    logger.info('MM outbox worker enabled', {
      poll_interval_ms: config.mmOutboxPollIntervalMs,
      batch_size: config.mmOutboxBatchSize,
    });
  } else {
    logger.info('MM outbox worker disabled (set MM_OUTBOX_WORKER_ENABLED=true to process backlog)', {
      batch_size: config.mmOutboxBatchSize,
    });
  }
  if (config.runContextDriver === 'redis' && config.redisUrl) {
    try {
      const redisStore = await createRedisRunContextStore(config.redisUrl);
      setRunContextStore(redisStore);
      logger.info('RunContext store: Redis', {});
    } catch (err) {
      const allowFallback = process.env.ALLOW_INMEMORY_RUNTIME === 'true';
      const isProd = config.nodeEnv === 'production';
      if (isProd && !allowFallback) {
        logger.error('Production requires Redis RunContext when RUN_CONTEXT_DRIVER=redis; startup failing', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      logger.warn('Redis RunContext unavailable, using in-memory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const listenPort = port ?? config.port;
  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, () => {
      const actualPort = (server.address() as { port: number })?.port ?? listenPort;
      logger.info(`Lexery Brain U1 Gateway listening on port ${actualPort}`);
      logger.info('U2 config (safe)', {
        port: actualPort,
        openrouter_key_present: !!config.openRouterApiKey,
        clf_model_id: config.clfModelId,
        clf_timeout_sec: config.clfTimeoutSec,
        use_rule_based_classifier: config.useRuleBasedClassifier,
        u2_consumer_disabled: config.u2DisableConsumer,
        run_context_driver: config.runContextDriver,
        u2_worker_concurrency: config.u2WorkerConcurrency,
        u2_llm_concurrency: config.u2LlmConcurrency,
      });
      resolve({
        port: actualPort,
        close: async () => {
          if (workerInterval) {
            clearInterval(workerInterval);
            workerInterval = null;
          }
          await new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
          await shutdownTaskQueue().catch((err) => {
            logger.warn('Task queue shutdown failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          const runContextStore = getRunContextStore();
          await runContextStore.shutdown?.().catch((err) => {
            logger.warn('RunContext shutdown failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          resetRunContextStore();
        },
      });
    });
    server.on('error', reject);
  });
}

export { app };

const entryScript = process.argv[1] ?? '';
const isMain = entryScript.endsWith('server.ts') || entryScript.endsWith('server.js');
if (isMain) {
  start().catch((err) => {
    logger.error('Server start failed', { error: String(err) });
    process.exit(1);
  });
}
