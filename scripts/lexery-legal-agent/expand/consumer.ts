/**
 * U6 Expand — connectivity stub (LEX-119 placeholder).
 * Real Expand (LLM synonyms, thesaurus) to be implemented later.
 * This stub: log "U6 event received", enqueue U9.
 */
import type { RunEvent } from '../gateway/types.js';
import { getTaskQueue } from '../gateway/handler.js';
import { logger } from '../lib/logger.js';

export async function handleU6Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U6') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U6', trace_id, module: 'expand/consumer' };

  logger.info('U6 event received (Expand stub)', ctx);

  const now = new Date().toISOString();
  const taskQueue = getTaskQueue();
  await taskQueue.enqueue({
    run_id,
    step: 'U9',
    created_at: now,
    trace_id,
  });
  logger.info('U9 enqueued', { run_id, trace_id });
}
