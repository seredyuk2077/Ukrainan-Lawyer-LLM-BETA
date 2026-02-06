#!/usr/bin/env node
/**
 * Lexery Legal Agent Brain — HTTP Server
 * U1 Gateway: POST /v1/runs
 */
import express from 'express';
import { handleCreateRun } from './gateway/handler.js';
import { config } from './lib/config.js';
import { checkSupabaseHealth } from './lib/supabase.js';
import { logger } from './lib/logger.js';
import { getTaskQueue } from './gateway/handler.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const requestId = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  (req as { id?: string }).id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  next();
};
app.use(requestId);

app.post('/v1/runs', handleCreateRun);

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
queue.onEvent((event) => {
  logger.info('RunEvent enqueued (U2 stub)', {
    run_id: event.run_id,
    step: event.step,
    trace_id: event.trace_id,
  });
});

app.listen(config.port, () => {
  logger.info(`Lexery Brain U1 Gateway listening on port ${config.port}`);
});
