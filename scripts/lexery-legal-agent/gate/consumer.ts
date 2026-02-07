/**
 * U5 Gate — connectivity stub (LEX-118 placeholder).
 * Real Gate (MIN_HITS_THRESHOLD, MIN_AVG_SCORE, expand decision) to be implemented later.
 * This stub: log "U5 event received", decide Expand=false, enqueue U9 for pipeline connectivity.
 */
import type { RunEvent } from '../gateway/types.js';
import { getTaskQueue } from '../gateway/handler.js';
import { logger } from '../lib/logger.js';

export async function handleU5Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U5') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U5', trace_id, module: 'gate/consumer' };

  logger.info('U5 event received (connectivity stub)', {
    ...ctx,
    expand: false,
    reason: 'stub',
  });

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
