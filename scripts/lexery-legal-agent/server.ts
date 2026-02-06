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
import { setRunContextStore } from './lib/run-context.js';
import { createRedisRunContextStore } from './lib/run-context-redis.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const requestId = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  (req as { id?: string }).id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  next();
};
app.use(requestId);

app.post('/v1/runs', handleCreateRun);
app.get('/v1/runs/:id', handleGetRun);

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
    handleU2Event(event).catch((err) => {
      logger.error('U2 consumer unhandled', { run_id: event.run_id, error: String(err) });
    });
  });
}

async function start() {
  setU2QueueDepth(0);
  if (config.runContextDriver === 'redis' && config.redisUrl) {
    try {
      const redisStore = await createRedisRunContextStore(config.redisUrl);
      setRunContextStore(redisStore);
      logger.info('RunContext store: Redis', {});
    } catch (err) {
      logger.warn('Redis RunContext unavailable, using in-memory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  app.listen(config.port, () => {
    logger.info(`Lexery Brain U1 Gateway listening on port ${config.port}`);
    logger.info('U2 config (safe)', {
      port: config.port,
      openrouter_key_present: !!config.openRouterApiKey,
      clf_model_id: config.clfModelId,
      clf_timeout_sec: config.clfTimeoutSec,
      use_rule_based_classifier: config.useRuleBasedClassifier,
      u2_consumer_disabled: config.u2DisableConsumer,
      run_context_driver: config.runContextDriver,
      u2_worker_concurrency: config.u2WorkerConcurrency,
      u2_llm_concurrency: config.u2LlmConcurrency,
    });
  });
}

start().catch((err) => {
  logger.error('Server start failed', { error: String(err) });
  process.exit(1);
});
