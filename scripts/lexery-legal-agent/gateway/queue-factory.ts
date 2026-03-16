/**
 * Queue factory: inmemory | redis from config.queueDriver.
 * Guardrails: production + inmemory (or runContext inmemory) → fail unless ALLOW_INMEMORY_RUNTIME=true.
 */
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { InMemoryQueue } from './queue.js';
import { RedisQueue, getDefaultRedisQueueNames } from './queue-redis.js';
import type { TaskQueue } from './queue.js';
import type { RunEvent } from './types.js';

export type QueueDriver = 'inmemory' | 'redis';

const ALLOW_INMEMORY_ENV = 'ALLOW_INMEMORY_RUNTIME';

function enforceGuardrails(): void {
  const prod = config.nodeEnv === 'production';
  if (!prod) return;
  const allow = process.env[ALLOW_INMEMORY_ENV] === 'true';
  if (config.queueDriver === 'inmemory' && !allow) {
    throw new Error(
      `Production requires durable queue. Set QUEUE_DRIVER=redis (and REDIS_URL) or allow in-memory explicitly: ${ALLOW_INMEMORY_ENV}=true`
    );
  }
  if (config.runContextDriver === 'inmemory' && !allow) {
    throw new Error(
      `Production requires durable run context. Set RUN_CONTEXT_DRIVER=redis (and REDIS_URL) or allow in-memory explicitly: ${ALLOW_INMEMORY_ENV}=true`
    );
  }
}

export interface TaskQueueWithConsumer extends TaskQueue {
  onEvent(h: (event: RunEvent) => void | Promise<void>): void;
  shutdown?(): Promise<void>;
}

let taskQueueInstance: TaskQueueWithConsumer | null = null;

/**
 * Returns the process-wide task queue. Creates it on first call (factory + guardrails).
 */
export function createTaskQueue(): TaskQueueWithConsumer {
  if (taskQueueInstance) return taskQueueInstance;
  enforceGuardrails();
  const driver = config.queueDriver;
  if (driver === 'redis') {
    if (!config.redisUrl) {
      throw new Error('QUEUE_DRIVER=redis requires REDIS_URL');
    }
    const queueNames = getDefaultRedisQueueNames();
    taskQueueInstance = new RedisQueue({ redisUrl: config.redisUrl, ...queueNames });
    logger.info('Queue driver: redis', {
      stream_main: queueNames.streamMain,
      stream_retry: queueNames.streamRetry,
      stream_dlq: queueNames.streamDlq,
      group_name: queueNames.groupName,
    });
  } else {
    taskQueueInstance = new InMemoryQueue();
    logger.info('Queue driver: inmemory', {});
  }
  return taskQueueInstance;
}

export async function shutdownTaskQueue(): Promise<void> {
  if (!taskQueueInstance?.shutdown) return;
  await taskQueueInstance.shutdown();
}
